import { answerDirectGoogleSearch, DIRECT_SEARCH_MODEL, DIRECT_SEARCH_THINKING } from "./direct-google-search.mjs";
import { googleSearchGroundingDecision } from "./google-search-routing.mjs";

const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const attempts = new Map();

function isPrivateQuestion(text) {
  // Technical uses of "internal" and "how much" aren't private business data.
  // Strip only these phrases; all remaining sensitive terms still hit policy.
  const publicWording = text.normalize("NFKC")
    .replace(/\binternal(?:ly)?\s+(?=(?:calibrat(?:ion|ed|ing)|(?:rechargeable\s+)?batter(?:y|ies))\b)/gi, "")
    .replace(/\bhow\s+much\b(?=\s+(?:(?:can|does|will)\s+[^?\n]{0,60}\bweigh\b|weight\s+can\b))/gi, "what weight");
  return googleSearchGroundingDecision(publicWording).route === "private_live_unavailable";
}

export function directSearchHealth(env) {
  return reply({ enabled: env.GOOGLE_DIRECT_TEST_ENABLED === "true", api_configured: Boolean(env.GEMINI_API_KEY), access_code_configured: Boolean(env.SALES_PILOT_ACCESS_CODE), model: DIRECT_SEARCH_MODEL, thinking: DIRECT_SEARCH_THINKING, catalog_used: false });
}

export async function handleDirectSearch(request, env, fetchImpl = fetch) {
  if (env.GOOGLE_DIRECT_TEST_ENABLED !== "true") return reply({ error: "This test is not enabled." }, 404);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply({ error: "Cross-origin requests are not allowed." }, 403);
  const required = env.SALES_PILOT_ACCESS_CODE?.trim();
  if (!required) return reply({ error: "Team access is not configured." }, 503);
  const supplied = request.headers.get("x-pilot-access-code") ?? "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([required, supplied].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  if (!supplied || difference) return reply({ error: "Enter the team access code.", code: "access_code_required" }, 401);
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.expires <= now) attempts.delete(key);
  const id = request.headers.get("cf-connecting-ip") ?? "local";
  if (!attempts.has(id) && attempts.size >= 5000) return reply({ error: "Please try again shortly." }, 429);
  const entry = attempts.get(id) ?? { count: 0, expires: now + 600_000 };
  entry.count++;
  attempts.set(id, entry);
  if (entry.count > 24) return reply({ error: "Please wait a few minutes before trying again." }, 429);
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "A question is required." }, 400);
    let raw = "", size = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24000) { await reader.cancel(); return reply({ error: "The request is too large." }, 413); }
      raw += decoder.decode(value, { stream: true });
    }
    body = JSON.parse(raw + decoder.decode());
  } catch { return reply({ error: "A valid JSON question is required." }, 400); }
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question.length < 2 || question.length > 1600) return reply({ error: "Enter a question between 2 and 1,600 characters." }, 400);
  const context = Array.isArray(body.context) ? body.context.slice(-4).filter((turn) => turn && typeof turn.question === "string" && typeof turn.answer === "string").map((turn) => ({ question: turn.question.slice(0,1600), answer: turn.answer.slice(0,2400) })) : [];
  if ([question, ...context.flatMap((turn) => [turn.question, turn.answer])].some(isPrivateQuestion)) {
    return reply({ error: "Use a public product question here. Pricing, orders, personal details and confidential information belong in your internal systems. Clear this test conversation before asking a new public question." }, 422);
  }
  if (!env.GEMINI_API_KEY) return reply({ error: "Gemini is not configured." }, 503);
  try {
    const answer = await answerDirectGoogleSearch({ question, context, apiKey: env.GEMINI_API_KEY, fetchImpl, signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]), onDiagnostic: (event) => console.info(JSON.stringify({ message: "Direct Google research", ...event })) });
    return reply(answer);
  } catch (error) {
    console.error(JSON.stringify({ message: "Direct Google Search test failed", status: error?.status ?? null, code: error?.code ?? "request_interrupted" }));
    const status = error?.status === 429 ? 429 : 502;
    const message = status === 429 ? "Google's request limit was reached. Please try again shortly."
      : error?.code === "google_timeout" || error?.name === "TimeoutError" ? "The research took too long. Please try again with the exact model and component."
      : error?.status === 401 || error?.status === 403 ? "The Google service connection needs attention. Please let your administrator know."
      : "Google's research service could not complete this request. Please try again shortly.";
    return reply({ error: message, code: error?.code ?? "request_interrupted" }, status);
  }
}
