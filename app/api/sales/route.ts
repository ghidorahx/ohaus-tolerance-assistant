import {
  answerSalesQuestionWithAI,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODE,
  DEFAULT_SERVICE_TIER,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_TOTAL_REQUEST_TOKENS,
  MAX_VERIFIED_CONTEXT_TURNS,
} from "@/lib/sales-agent.mjs";
import { getSalesCatalogStatus, MAX_RETRIEVAL_DOCUMENTS } from "@/lib/sales-catalog.mjs";
import {
  getSalesVectorizeStatus,
  querySalesVectorize,
} from "@/lib/sales-vectorize.mjs";
import {
  activateMasterCatalogVersion,
  CatalogAdminError,
  getMasterCatalogStatus,
  MASTER_DEFAULT_CHUNK_LIMIT,
  MASTER_EMBEDDING_MODEL,
  MASTER_VECTORIZE_INDEX,
  masterCatalogNamespace,
  recordMasterCatalogEvaluation,
  resetFailedMasterVectorSeed,
  retrieveMasterCatalog,
  seedMasterVectorizeBatch,
} from "@/lib/master-catalog-rag.mjs";
import {
  buildMasterGroundingBundle,
  hydrateMasterEvidenceItems,
} from "@/lib/master-catalog-grounding.mjs";
import masterCatalogManifest from "@/data/master-catalog-manifest.json";
import masterRetrievalEvalProfile from "@/data/master-retrieval-eval-profile.json";

export const runtime = "edge";

type RateEntry = { count: number; resetAt: number };
type SalesContextTurn = {
  question: string;
  answer: string;
  materials: string[];
  contextSummary: string;
};
type CatalogVersionHealthSource = {
  version_id?: unknown;
  source_file?: unknown;
  source_sha256?: unknown;
  source_rows?: unknown;
  source_columns?: unknown;
  material_count?: unknown;
  alias_count?: unknown;
  attribute_count?: unknown;
  relationship_count?: unknown;
  document_count?: unknown;
  chunk_count?: unknown;
  status?: unknown;
  staged_at?: unknown;
  activated_at?: unknown;
};

const rateLimit = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 24;
const RATE_MAX_TRACKED_CLIENTS = 5_000;
const MAX_CONTEXT_CHARACTERS = MAX_INPUT_TOKENS * 3;
const MAX_CHAT_BODY_BYTES = 256 * 1_024;
const MAX_ADMIN_BODY_BYTES = 16 * 1_024;
const MASTER_MAX_RETRIEVAL_CHUNKS = 16;

class RequestBodyTooLargeError extends Error {}

function json(data: unknown, status = 200, additionalHeaders: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders,
    },
  });
}

function clientId(request: Request) {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "local";
}

async function readBoundedJson<T>(request: Request, maximumBytes: number): Promise<T> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new RequestBodyTooLargeError();
  if (!request.body) return {} as T;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  if (total === 0) return {} as T;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function pruneRateLimit(now: number) {
  if (rateLimit.size < RATE_MAX_TRACKED_CLIENTS) return;
  for (const [id, entry] of rateLimit) {
    if (entry.resetAt <= now) rateLimit.delete(id);
  }
  while (rateLimit.size >= RATE_MAX_TRACKED_CLIENTS) {
    const oldest = rateLimit.keys().next().value as string | undefined;
    if (!oldest) break;
    rateLimit.delete(oldest);
  }
}

function rateLimitStatus(request: Request) {
  const now = Date.now();
  const id = clientId(request);
  const current = rateLimit.get(id);
  if (!current || current.resetAt <= now) {
    pruneRateLimit(now);
    rateLimit.set(id, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { limited: false, retryAfterSeconds: 0 };
  }
  current.count += 1;
  return {
    limited: current.count > RATE_MAX_REQUESTS,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
  };
}

async function sameSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function isLocalRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function accessCodePolicy(request: Request) {
  const requiredCode = process.env.SALES_PILOT_ACCESS_CODE?.trim() ?? "";
  const localBypass = isLocalRequest(request) && !requiredCode;
  return {
    configured: Boolean(requiredCode),
    required: !localBypass,
    available: Boolean(requiredCode) || localBypass,
    requiredCode,
  };
}

async function hasValidAccessCode(request: Request, policy = accessCodePolicy(request)) {
  if (!policy.required) return true;
  if (!policy.requiredCode) return false;
  const suppliedCode = request.headers.get("x-pilot-access-code") ?? "";
  return Boolean(suppliedCode && await sameSecret(suppliedCode, policy.requiredCode));
}

async function hasValidCatalogAdminToken(request: Request) {
  const requiredToken = process.env.CATALOG_ADMIN_TOKEN?.trim() ?? "";
  const suppliedToken = request.headers.get("x-catalog-admin-token")?.trim() ?? "";
  if (!requiredToken || !suppliedToken) return false;
  return await sameSecret(suppliedToken, requiredToken);
}

async function cloudflareBindings(): Promise<Partial<Cloudflare.Env>> {
  try {
    const workers = await import("cloudflare:workers");
    return workers.env;
  } catch {
    // The Node build test has no workerd-native cloudflare:workers module.
    return {};
  }
}

function boundedContext(value: unknown): SalesContextTurn[] {
  if (!Array.isArray(value)) return [];
  const candidates = value.slice(-MAX_VERIFIED_CONTEXT_TURNS).flatMap((turn) => {
    if (!turn || typeof turn !== "object") return [];
    const candidate = turn as {
      question?: unknown;
      answer?: unknown;
      materials?: unknown;
      contextSummary?: unknown;
    };
    const question = typeof candidate.question === "string" ? candidate.question.trim().slice(0, 2_400) : "";
    const answer = typeof candidate.answer === "string" ? candidate.answer.trim().slice(0, 8_000) : "";
    const materials = Array.isArray(candidate.materials)
      ? candidate.materials.filter((item): item is string => typeof item === "string").slice(0, 24)
      : [];
    const contextSummary = typeof candidate.contextSummary === "string"
      ? candidate.contextSummary.trim().slice(0, 2_000)
      : "";
    return question && answer ? [{ question, answer, materials, contextSummary }] : [];
  });

  const bounded = [];
  let characterCount = 0;
  for (const turn of candidates.reverse()) {
    const size = JSON.stringify(turn).length;
    if (characterCount + size > MAX_CONTEXT_CHARACTERS) break;
    bounded.unshift(turn);
    characterCount += size;
  }
  return bounded;
}

function manifestScopeForVersion(version: CatalogVersionHealthSource | null | undefined) {
  if (!version || version.source_sha256 !== masterCatalogManifest.source.sha256) return {};
  const counts = masterCatalogManifest.counts as typeof masterCatalogManifest.counts & {
    named_parent_families?: number;
    named_families?: number;
  };
  return {
    parent_families: counts.named_parent_families ?? 46,
    families: counts.named_families ?? 215,
  };
}

function masterCatalogHealthForVersion(version: CatalogVersionHealthSource | null) {
  if (!version) return null;
  const scope = manifestScopeForVersion(version);
  return {
    materials: Number(version.material_count) || 0,
    parent_families: scope.parent_families,
    families: scope.families,
    relationship_edges: Number(version.relationship_count) || 0,
    document_links: Number(version.document_count) || 0,
    chunks: Number(version.chunk_count) || 0,
    retrieval_documents: Number(version.chunk_count) || 0,
    retrieval_status: "ready",
    source_file: String(version.source_file ?? "Loaded master catalog"),
    version_id: String(version.version_id ?? ""),
  };
}

function activeMasterCatalogHealth(masterStatus: Awaited<ReturnType<typeof getMasterCatalogStatus>>) {
  return masterCatalogHealthForVersion(masterStatus.active_version);
}

function masterVectorizeHealth(
  bindings: Partial<Cloudflare.Env>,
  masterStatus: Awaited<ReturnType<typeof getMasterCatalogStatus>>,
) {
  const version = masterStatus.active_version;
  return {
    status: version ? "ready" : masterStatus.status,
    configured: Boolean(bindings.AI && bindings.CATALOG_VECTORIZE),
    index: MASTER_VECTORIZE_INDEX,
    namespace: version?.version_id ? masterCatalogNamespace(String(version.version_id)) : "versioned master catalog",
    embedding_model: MASTER_EMBEDDING_MODEL,
    source_documents: Number(version?.chunk_count) || masterCatalogManifest.counts.chunks,
    vector_records: Number(masterStatus.seed_progress?.seeded ?? version?.chunk_count) || 0,
  };
}

function publicMasterAdminStatus(masterStatus: Awaited<ReturnType<typeof getMasterCatalogStatus>>) {
  const cleanVersion = (version: CatalogVersionHealthSource | null) => version ? {
    version_id: version.version_id,
    source_file: version.source_file,
    source_rows: version.source_rows,
    source_columns: version.source_columns,
    material_count: version.material_count,
    alias_count: version.alias_count,
    attribute_count: version.attribute_count,
    relationship_count: version.relationship_count,
    document_count: version.document_count,
    chunk_count: version.chunk_count,
    status: version.status,
    staged_at: version.staged_at,
    activated_at: version.activated_at,
  } : null;
  return {
    status: masterStatus.status,
    configured: masterStatus.configured,
    active_version: cleanVersion(masterStatus.active_version),
    catalog_version: cleanVersion(masterStatus.catalog_version),
    seed_progress: masterStatus.seed_progress,
    vectorize_index: MASTER_VECTORIZE_INDEX,
    embedding_model: MASTER_EMBEDDING_MODEL,
  };
}

function masterRetrievalOptions(question: string) {
  const expansive = /\b(?:all|every|complete|compare|comparison|list|which products?|which models?)\b/i.test(question);
  return {
    topK: expansive ? 48 : 30,
    chunkLimit: expansive ? MASTER_MAX_RETRIEVAL_CHUNKS : MASTER_DEFAULT_CHUNK_LIMIT,
    evidenceLimit: expansive ? 32 : 20,
  };
}

export async function GET(request: Request) {
  const bindings = await cloudflareBindings();
  const accessPolicy = accessCodePolicy(request);
  const masterStatus = await getMasterCatalogStatus({
    db: bindings.CATALOG_DB,
    ai: bindings.AI,
    index: bindings.CATALOG_VECTORIZE,
    includeSeedProgress: false,
  });
  const masterCatalog = activeMasterCatalogHealth(masterStatus);
  const vectorizeStatus = masterCatalog
    ? masterVectorizeHealth(bindings, masterStatus)
    : {
      ...getSalesVectorizeStatus(),
      configured: Boolean(bindings.AI && bindings.SALES_VECTORIZE),
    };
  return json({
    status: accessPolicy.available ? "ready" : "configuration_required",
    model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    fallback_model: process.env.OPENAI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
    reasoning_effort: DEFAULT_REASONING_EFFORT,
    reasoning_mode: process.env.OPENAI_REASONING_MODE ?? DEFAULT_REASONING_MODE,
    service_tier: DEFAULT_SERVICE_TIER,
    api_configured: Boolean(process.env.OPENAI_API_KEY),
    access_code_required: accessPolicy.required,
    access_code_configured: accessPolicy.configured,
    vectorize: vectorizeStatus,
    context: {
      max_verified_turns: MAX_VERIFIED_CONTEXT_TURNS,
      approximate_character_budget: MAX_CONTEXT_CHARACTERS,
      max_retrieval_documents: Math.max(MAX_RETRIEVAL_DOCUMENTS, MASTER_MAX_RETRIEVAL_CHUNKS),
      max_total_request_tokens: MAX_TOTAL_REQUEST_TOKENS,
      max_input_tokens: MAX_INPUT_TOKENS,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    },
    catalog: masterCatalog ?? getSalesCatalogStatus(),
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  const requestLimit = rateLimitStatus(request);
  if (requestLimit.limited) {
    return json({
      error: `Request limit reached. Try again in about ${requestLimit.retryAfterSeconds} seconds.`,
      code: "sales_rate_limited",
      retry_after_seconds: requestLimit.retryAfterSeconds,
    }, 429, { "Retry-After": String(requestLimit.retryAfterSeconds) });
  }

  const accessPolicy = accessCodePolicy(request);
  if (!accessPolicy.available) {
    return json({ error: "Team access is not configured for this deployment.", code: "access_code_not_configured" }, 503);
  }
  if (!(await hasValidAccessCode(request, accessPolicy))) {
    return json({ error: "Enter the team access code to continue.", code: "access_code_required" }, 401);
  }

  let body: { question?: unknown; context?: unknown };
  try {
    body = await readBoundedJson(request, MAX_CHAT_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "The request is too large.", code: "request_too_large" }, 413);
    }
    return json({ error: "A JSON request body is required." }, 400);
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length < 2 || question.length > 1_600) {
    return json({ error: "Ask a product question between 2 and 1,600 characters." }, 400);
  }
  if (!process.env.OPENAI_API_KEY) {
    return json({ error: "The OpenAI connection is not configured yet.", code: "ai_not_configured" }, 503);
  }

  try {
    const requestStarted = performance.now();
    const context = boundedContext(body.context);
    const bindings = await cloudflareBindings();
    const contextMaterials = [...new Set(context.flatMap((turn) => turn.materials.map(String)))];
    let groundingBundle: Record<string, unknown> | null = null;
    let masterRetrieval: Awaited<ReturnType<typeof retrieveMasterCatalog>> | null = null;
    let retrievalMilliseconds = 0;

    if (bindings.CATALOG_DB) {
      try {
        const retrievalStarted = performance.now();
        masterRetrieval = await retrieveMasterCatalog({
          question,
          contextMaterials,
          db: bindings.CATALOG_DB,
          ai: bindings.AI,
          index: bindings.CATALOG_VECTORIZE,
          ...masterRetrievalOptions(question),
        });
        retrievalMilliseconds = performance.now() - retrievalStarted;
        if (masterRetrieval.version && ["ready", "no_results"].includes(masterRetrieval.status)) {
          groundingBundle = buildMasterGroundingBundle(
            masterRetrieval,
            manifestScopeForVersion(masterRetrieval.version),
          );
        }
      } catch (error) {
        console.error(JSON.stringify({
          message: "Master catalog retrieval failed; using verified legacy fallback",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    let semanticRetrieval = { status: "not_configured", matches: [] };
    if (!groundingBundle && bindings.AI && bindings.SALES_VECTORIZE) {
      const retrievalStarted = performance.now();
      try {
        semanticRetrieval = await querySalesVectorize({
          question,
          ai: bindings.AI,
          index: bindings.SALES_VECTORIZE,
        });
      } catch (error) {
        console.error(JSON.stringify({
          message: "Legacy Vectorize query failed; using local retrieval fallback",
          error: error instanceof Error ? error.message : String(error),
        }));
        semanticRetrieval = { status: "fallback", matches: [] };
      }
      retrievalMilliseconds = performance.now() - retrievalStarted;
    }

    const generationStarted = performance.now();
    const answer = await answerSalesQuestionWithAI({
      question,
      sessionContext: context,
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
      fallbackModel: process.env.OPENAI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      reasoningMode: process.env.OPENAI_REASONING_MODE ?? DEFAULT_REASONING_MODE,
      semanticRetrieval,
      groundingBundle,
      evidenceHydrator: groundingBundle ? hydrateMasterEvidenceItems : undefined,
    });
    const generationMilliseconds = performance.now() - generationStarted;
    const masterCatalog = masterCatalogHealthForVersion(masterRetrieval?.version ?? null);
    return json({
      answer: {
        ...answer,
        timing: {
          retrieval_ms: Math.round(retrievalMilliseconds),
          generation_ms: Math.round(generationMilliseconds),
          total_ms: Math.round(performance.now() - requestStarted),
        },
      },
      context_used: context.length,
      catalog: masterCatalog ?? getSalesCatalogStatus(),
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "Ask assistant request failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    const upstream = error as { status?: number; code?: string | null; message?: string; retryAfterSeconds?: number | null };
    if (upstream.status === 429 && (upstream.code === "insufficient_quota" || /credits|quota/i.test(upstream.message ?? ""))) {
      return json({ error: "The OpenAI API project needs billing credits before the assistant can answer.", code: "ai_billing_required" }, 503);
    }
    if (upstream.status === 429) {
      const retryAfterSeconds = Math.max(1, Math.min(600, Math.ceil(upstream.retryAfterSeconds ?? 30)));
      return json({
        error: `The AI service is temporarily rate limited. Try again in about ${retryAfterSeconds} seconds.`,
        code: "ai_rate_limited",
        retry_after_seconds: retryAfterSeconds,
      }, 429, { "Retry-After": String(retryAfterSeconds) });
    }
    return json({ error: "The product assistant could not complete this request. Please try again.", code: "ai_request_failed" }, 502);
  }
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!process.env.CATALOG_ADMIN_TOKEN) {
    return json({ error: "Catalog administration is not configured.", code: "catalog_admin_not_configured" }, 503);
  }
  if (!(await hasValidCatalogAdminToken(request))) {
    return json({ error: "Catalog administrator authorization is required.", code: "catalog_admin_required" }, 401);
  }

  let body: {
    action?: unknown;
    version_id?: unknown;
    batch_size?: unknown;
    question?: unknown;
    fixture_sha256?: unknown;
    fixture_schema_version?: unknown;
    source_sha256?: unknown;
    retrieval_profile_sha256?: unknown;
    fixture_case_count?: unknown;
    evaluated_count?: unknown;
    passed_count?: unknown;
    failed_count?: unknown;
    status?: unknown;
    evaluated_at?: unknown;
    details?: unknown;
  };
  try {
    body = await readBoundedJson(request, MAX_ADMIN_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "The administration request is too large.", code: "request_too_large" }, 413);
    }
    return json({ error: "A JSON request body is required." }, 400);
  }

  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const versionId = typeof body.version_id === "string" ? body.version_id.trim() : "";
  if (!action) return json({ error: "A catalog action is required.", code: "catalog_action_required" }, 400);
  if (!versionId || !/^[a-zA-Z0-9_-]{1,96}$/.test(versionId)) {
    return json({ error: "A valid catalog version is required.", code: "catalog_version_required" }, 400);
  }

  const bindings = await cloudflareBindings();
  if (!bindings.CATALOG_DB) {
    return json({ error: "The master catalog database is not configured.", code: "catalog_database_not_configured" }, 503);
  }

  try {
    if (action === "status") {
      const status = await getMasterCatalogStatus({
        db: bindings.CATALOG_DB,
        ai: bindings.AI,
        index: bindings.CATALOG_VECTORIZE,
        versionId,
        includeSeedProgress: true,
      });
      return json(publicMasterAdminStatus(status));
    }

    if (action === "retrieve") {
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (question.length < 2 || question.length > 1_600) {
        return json({ error: "A retrieval question between 2 and 1,600 characters is required." }, 400);
      }
      const result = await retrieveMasterCatalog({
        question,
        db: bindings.CATALOG_DB,
        ai: bindings.AI,
        index: bindings.CATALOG_VECTORIZE,
        versionId,
        ...masterRetrievalOptions(question),
      });
      if (!("prompt_context" in result)) {
        return json({ error: "The catalog retrieval result is unavailable.", code: "catalog_retrieval_unavailable" }, 409);
      }
      return json({
        status: result.status,
        version_id: versionId,
        prompt_context: result.prompt_context,
        evaluation_diagnostics: {
          semantic_status: result.retrieval?.semantic?.status ?? "unavailable",
          semantic_material_numbers: [...new Set(
            (result.chunks ?? [])
              .filter((chunk) => chunk.retrieval?.sources?.includes("semantic"))
              .map((chunk) => String(chunk.material_number ?? "").trim())
              .filter(Boolean),
          )].slice(0, 50),
          semantic_chunk_ids: (result.chunks ?? [])
            .filter((chunk) => chunk.retrieval?.sources?.includes("semantic"))
            .map((chunk) => String(chunk.chunk_id ?? "").trim())
            .filter(Boolean)
            .slice(0, 50),
        },
      });
    }

    if (action === "seed") {
      if (!bindings.AI || !bindings.CATALOG_VECTORIZE) {
        return json({ error: "Master catalog vector services are not configured.", code: "catalog_vectorize_not_configured" }, 503);
      }
      const result = await seedMasterVectorizeBatch({
        db: bindings.CATALOG_DB,
        ai: bindings.AI,
        index: bindings.CATALOG_VECTORIZE,
        versionId,
        batchSize: Number(body.batch_size) || undefined,
      });
      return json(result);
    }

    if (action === "reset_failed_seed") {
      const result = await resetFailedMasterVectorSeed({
        db: bindings.CATALOG_DB,
        versionId,
      });
      return json(result);
    }

    if (action === "record_evaluation") {
      const result = await recordMasterCatalogEvaluation({
        db: bindings.CATALOG_DB,
        versionId,
        requiredProfile: masterRetrievalEvalProfile,
        fixtureSha256: body.fixture_sha256,
        fixtureSchemaVersion: body.fixture_schema_version,
        sourceSha256: body.source_sha256,
        retrievalProfileSha256: body.retrieval_profile_sha256,
        fixtureCaseCount: body.fixture_case_count,
        evaluatedCount: body.evaluated_count,
        passedCount: body.passed_count,
        failedCount: body.failed_count,
        status: body.status,
        evaluatedAt: body.evaluated_at,
        details: body.details,
      });
      return json(result);
    }

    if (action === "activate") {
      if (!bindings.CATALOG_VECTORIZE) {
        return json({ error: "Master catalog Vectorize is not configured.", code: "catalog_vectorize_not_configured" }, 503);
      }
      const result = await activateMasterCatalogVersion({
        db: bindings.CATALOG_DB,
        index: bindings.CATALOG_VECTORIZE,
        versionId,
        requiredEvaluation: masterRetrievalEvalProfile,
      });
      return json(result);
    }

    return json({ error: "Unknown catalog action.", code: "catalog_action_invalid" }, 400);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Master catalog administration failed",
      action,
      version_id: versionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof CatalogAdminError) {
      return json({
        error: error.message,
        code: error.code,
        ...(error.details === null ? {} : { details: error.details }),
      }, error.status);
    }
    const message = error instanceof Error ? error.message : "";
    if (/not query-visible|propagat/i.test(message)) {
      return json({ error: "The final catalog vectors are still propagating.", code: "catalog_vectors_propagating" }, 409);
    }
    if (/not fully seeded|no queued retrieval chunks|queue has/i.test(message)) {
      return json({ error: "The catalog cannot be activated until every retrieval chunk is indexed.", code: "catalog_seed_incomplete" }, 409);
    }
    return json({ error: "The catalog administration action could not be completed.", code: "catalog_admin_failed" }, 502);
  }
}
