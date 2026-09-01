import {
  answerSalesQuestionWithAI,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODE,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_TOTAL_REQUEST_TOKENS,
  MAX_VERIFIED_CONTEXT_TURNS,
} from "@/lib/sales-agent.mjs";
import { getSalesCatalogStatus, MAX_RETRIEVAL_DOCUMENTS } from "@/lib/sales-catalog.mjs";

export const runtime = "edge";

type RateEntry = { count: number; resetAt: number };
type SalesContextTurn = {
  question: string;
  answer: string;
  materials: string[];
  contextSummary: string;
};

const rateLimit = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 24;
const MAX_CONTEXT_CHARACTERS = MAX_INPUT_TOKENS * 3;

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

function rateLimitStatus(request: Request) {
  const now = Date.now();
  const id = clientId(request);
  const current = rateLimit.get(id);
  if (!current || current.resetAt <= now) {
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

export async function GET() {
  return json({
    status: "ready",
    model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    fallback_model: process.env.OPENAI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
    reasoning_effort: DEFAULT_REASONING_EFFORT,
    reasoning_mode: process.env.OPENAI_REASONING_MODE ?? DEFAULT_REASONING_MODE,
    api_configured: Boolean(process.env.OPENAI_API_KEY),
    access_code_required: Boolean(process.env.SALES_PILOT_ACCESS_CODE),
    context: {
      max_verified_turns: MAX_VERIFIED_CONTEXT_TURNS,
      approximate_character_budget: MAX_CONTEXT_CHARACTERS,
      max_retrieval_documents: MAX_RETRIEVAL_DOCUMENTS,
      max_total_request_tokens: MAX_TOTAL_REQUEST_TOKENS,
      max_input_tokens: MAX_INPUT_TOKENS,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    },
    catalog: getSalesCatalogStatus(),
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

  const requiredCode = process.env.SALES_PILOT_ACCESS_CODE;
  if (requiredCode) {
    const suppliedCode = request.headers.get("x-pilot-access-code") ?? "";
    if (!suppliedCode || !(await sameSecret(suppliedCode, requiredCode))) {
      return json({ error: "Enter the sales-pilot access code to continue.", code: "access_code_required" }, 401);
    }
  }

  let body: { question?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
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
    const context = boundedContext(body.context);
    const answer = await answerSalesQuestionWithAI({
      question,
      sessionContext: context,
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
      fallbackModel: process.env.OPENAI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      reasoningMode: process.env.OPENAI_REASONING_MODE ?? DEFAULT_REASONING_MODE,
    });
    return json({
      answer,
      context_used: context.length,
      catalog: getSalesCatalogStatus(),
    });
  } catch (error) {
    console.error("Sales assistant request failed", error);
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
