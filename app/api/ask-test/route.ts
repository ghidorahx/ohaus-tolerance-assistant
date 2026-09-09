import {
  answerWithGoogleSearch,
  GOOGLE_SEARCH_MODEL,
} from "@/lib/gemini-google-search-agent.mjs";
import { googleSearchGroundingDecision } from "@/lib/google-search-routing.mjs";
import { salesStreamResponse } from "@/lib/sales-stream.mjs";
import { GET as getCatalogAssistant, POST as postCatalogAssistant } from "../sales/route";

export const runtime = "edge";

const MAX_CHAT_BODY_BYTES = 256 * 1_024;

class RequestBodyTooLargeError extends Error {}

const JSON_SAFETY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function safeJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(JSON_SAFETY_HEADERS)) headers.set(name, value);
  return Response.json(body, { ...init, headers });
}

function webExperimentEnabled() {
  return process.env.GOOGLE_SEARCH_GROUNDING_ENABLED?.trim().toLowerCase() === "true";
}

type CatalogAnswer = {
  answer?: string;
  answer_items?: Array<{ identifier?: string; label?: string; description?: string }>;
  context_summary?: string;
  evidence?: Array<{
    material_number?: string;
    model_or_item?: string;
    field?: string;
    value?: string;
    source_file?: string;
  }>;
  materials?: string[];
  status?: string;
  confidence?: string;
  intent?: string;
  unresolved_items?: string[];
  follow_up_suggestions?: string[];
  escalation_reason?: string | null;
  retrieval_strategy?: string;
  vectorize_status?: string;
  retrieval_documents_sent?: number;
  catalog_checks?: number;
  timing?: { retrieval_ms?: number; generation_ms?: number; total_ms?: number };
};

type CatalogResponse = {
  answer?: CatalogAnswer;
  catalog?: Record<string, unknown>;
  context_used?: number;
  error?: string;
};

async function readBoundedBody(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CHAT_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CHAT_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function catalogRequest(request: Request, rawBody: string, accept: string, signal: AbortSignal = request.signal) {
  const headers = new Headers(request.headers);
  headers.set("Accept", accept);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: rawBody,
    signal,
  });
}

function webGroundingBundle(answer: CatalogAnswer, catalog: Record<string, unknown> | undefined) {
  const evidence = Array.isArray(answer.evidence) ? answer.evidence : [];
  const materials = Array.isArray(answer.materials) ? answer.materials.map(String) : [];
  return {
    catalog_scope: {
      materials: Number(catalog?.materials) || materials.length,
      source_file: typeof catalog?.source_file === "string" ? catalog.source_file : "Loaded catalog",
    },
    allowed_material_numbers: materials,
    evidence_fields: evidence,
    verified_catalog_answer: {
      answer: String(answer.answer ?? ""),
      answer_items: Array.isArray(answer.answer_items) ? answer.answer_items : [],
      context_summary: String(answer.context_summary ?? ""),
    },
    retrieval: {
      strategy: answer.retrieval_strategy ?? "verified_catalog_answer",
      vectorize_status: answer.vectorize_status ?? "not_needed",
      result_count: Number(answer.retrieval_documents_sent) || evidence.length,
    },
  };
}

function webFailureResponse(error: unknown) {
  const upstream = error as {
    status?: number;
    code?: string | number | null;
    message?: string;
    retryAfterSeconds?: number | null;
  };
  if (upstream.status === 429 && (upstream.code === "insufficient_quota" || /credits|quota/i.test(upstream.message ?? ""))) {
    return safeJson({
      error: "The Gemini API project needs available quota before Google Search can answer.",
      code: "ai_billing_required",
    }, { status: 503 });
  }
  if (upstream.status === 429) {
    const retryAfterSeconds = Math.max(1, Math.min(600, Math.ceil(upstream.retryAfterSeconds ?? 30)));
    return safeJson({
      error: `Google Search is temporarily rate limited. Try again in about ${retryAfterSeconds} seconds.`,
      code: "ai_rate_limited",
      retry_after_seconds: retryAfterSeconds,
    }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
  }
  if (upstream.code === "google_search_not_grounded" || upstream.code === "google_search_incomplete") {
    return safeJson({
      error: "Google Search did not return a cited result, so no web answer was shown.",
      code: "web_grounding_unavailable",
    }, { status: 502 });
  }
  if (upstream.code === "answer_too_long") {
    return safeJson({
      error: "That web result is larger than the current answer limit. Narrow the question and try again.",
      code: "answer_too_long",
    }, { status: 422 });
  }
  return safeJson({
    error: "The Google Search test could not complete this request. Please try again.",
    code: "web_grounding_failed",
  }, { status: 502 });
}

async function webAnswer(
  request: Request,
  rawBody: string,
  body: { question?: unknown; context?: unknown },
  routingDecision: ReturnType<typeof googleSearchGroundingDecision>,
  onDraft?: (text: string) => void,
  signal: AbortSignal = request.signal,
) {
  const started = performance.now();
  const catalogResponse = await postCatalogAssistant(catalogRequest(request, rawBody, "application/json", signal));
  if (!catalogResponse.ok) return catalogResponse;
  const catalogPayload = await catalogResponse.json() as CatalogResponse;
  if (!catalogPayload.answer) {
    return safeJson({ error: "The verified catalog answer was unavailable." }, { status: 502 });
  }
  if (routingDecision.route === "catalog_plus_web") {
    const catalogStatus = String(catalogPayload.answer.status ?? "");
    const materials = Array.isArray(catalogPayload.answer.materials) ? catalogPayload.answer.materials : [];
    const unresolved = Array.isArray(catalogPayload.answer.unresolved_items)
      ? catalogPayload.answer.unresolved_items
      : [];
    if (["needs_clarification", "escalate"].includes(catalogStatus)
      || materials.length === 0
      || unresolved.length > 0) {
      return safeJson({
        ...catalogPayload,
        experiment: {
          google_search: false,
          catalog_authority: "excel_only",
          routing: "catalog_identity_unresolved",
        },
      });
    }
  }
  const groundingBundle = webGroundingBundle(catalogPayload.answer, catalogPayload.catalog);
  const catalogMilliseconds = performance.now() - started;
  let answer;
  try {
    answer = await answerWithGoogleSearch({
      question: String(body.question ?? "").trim(),
      // The verified catalog answer resolves safe follow-up context. Raw prior
      // turns are deliberately withheld from the web-search interaction.
      sessionContext: [],
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: GOOGLE_SEARCH_MODEL,
      thinkingLevel: process.env.GEMINI_THINKING_LEVEL ?? "low",
      groundingBundle,
      catalogAnswer: catalogPayload.answer,
      routingDecision,
      onDraft,
      signal,
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "Google Search grounding experiment failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return webFailureResponse(error);
  }
  const totalMilliseconds = performance.now() - started;
  return safeJson({
    ...catalogPayload,
    answer: {
      ...answer,
      timing: {
        retrieval_ms: Math.round(catalogMilliseconds),
        generation_ms: Math.round(totalMilliseconds - catalogMilliseconds),
        total_ms: Math.round(totalMilliseconds),
      },
    },
    experiment: {
      google_search: true,
      catalog_authority: "excel_only",
      routing: routingDecision.route,
    },
  });
}

export async function GET(request: Request) {
  const response = await getCatalogAssistant(request);
  if (!response.ok) return response;
  const payload = await response.json() as Record<string, unknown> & {
    answer_routing?: Record<string, unknown>;
  };
  return safeJson({
    ...payload,
    answer_routing: {
      ...payload.answer_routing,
      google_search_current_external: webExperimentEnabled(),
      catalog_authority: "excel_only",
    },
    experiment: "google-search-grounding-test",
  });
}

export async function POST(request: Request) {
  let rawBody: string;
  let body: { question?: unknown; context?: unknown };
  try {
    rawBody = await readBoundedBody(request);
    body = JSON.parse(rawBody) as { question?: unknown; context?: unknown };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return safeJson({ error: "The request is too large.", code: "request_too_large" }, { status: 413 });
    }
    return safeJson({ error: "A JSON request body is required." }, { status: 400 });
  }

  const decision = googleSearchGroundingDecision(
    typeof body.question === "string" ? body.question : "",
    Array.isArray(body.context) ? body.context as Array<Record<string, unknown>> : [],
  );
  if (!webExperimentEnabled() || !decision.useGoogleSearch) {
    return postCatalogAssistant(catalogRequest(request, rawBody, request.headers.get("Accept") ?? "application/json"));
  }

  if (request.headers.get("Accept")?.includes("text/event-stream")) {
    return salesStreamResponse(
      (onDraft, signal) => webAnswer(request, rawBody, body, decision, onDraft, signal),
      // The standard route already handles authorization and rate limiting
      // during the verified catalog pass inside webAnswer.
      request.signal,
    );
  }
  return webAnswer(request, rawBody, body, decision);
}
