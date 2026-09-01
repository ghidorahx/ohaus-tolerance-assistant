import { buildGroundingBundle, hydrateEvidenceItems } from "./sales-catalog.mjs";

const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_FALLBACK_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_REASONING_MODE = "standard";
export const MAX_VERIFIED_CONTEXT_TURNS = 120;
// Tier 1 provides 500K TPM. Keep this test profile at 450K total so a single
// request retains 50K TPM of headroom. GPT-5.6 itself caps output at 128K.
export const MAX_TOTAL_REQUEST_TOKENS = 450_000;
export const MAX_OUTPUT_TOKENS = 128_000;
export const MAX_INPUT_TOKENS = MAX_TOTAL_REQUEST_TOKENS - MAX_OUTPUT_TOKENS;
export const RATE_LIMIT_FALLBACK_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS;
const APPROXIMATE_CHARACTERS_PER_INPUT_TOKEN = 3;
const MAX_INPUT_CHARACTERS = MAX_INPUT_TOKENS * APPROXIMATE_CHARACTERS_PER_INPUT_TOKEN;
const ALLOWED_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_REASONING_MODES = new Set(["standard", "pro"]);
const PRIMARY_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
let primaryBackoffUntil = 0;

const instructions = `You are a professional internal product-knowledge assistant for the loaded Excel-derived portable-balance catalog.

Your goal is to answer the user's product question quickly, clearly, and accurately from the catalog while preserving the exact limits of the source.

Grounding rules:
- A server-generated JSON grounding bundle is supplied with every current question. That bundle is the only authority for product facts. Do not use memory, brand knowledge, or assumptions.
- The bundle includes exact identifier matches, deterministic requirement-filter results when applicable, deterministic nearest-capacity alternatives, natural-language matches, generated Markdown retrieval-document matches, relationship results, topic-field matches, and catalog scope.
- Use retrieval_document_matches for descriptive sales context, family summaries, applications, benefits, and relevant populated workbook details. A retrieval score only ranks likely relevance; it is not proof that a claim is true.
- Exact specifications, numeric requirements, product identity, and relationship claims must come from the structured exact, deterministic, or relationship results. The Markdown documents are a generated discovery layer, not a replacement for field-level evidence.
- Inspect every relevant part of the supplied bundle before declaring that information is unavailable.
- Material number is the authoritative primary key. A model label may map to multiple materials. When ambiguous, list the candidates and ask the user to choose.
- Recent conversation context is reference-only. Use it to resolve follow-ups such as "it" or "that model," but revalidate every factual claim against the current grounding bundle.
- Do not repeat a prior answer as evidence.
- A relationship in the workbook means the item is listed under that relationship field. Do not broaden it into universal compatibility. Label unresolved relationships as needing source review.
- Marketing descriptions, usage contexts, and benefit text can support a sales explanation, but they do not prove regulatory compliance, legal suitability, or guaranteed performance outside the stated conditions.
- Live price, inventory, lead time, customer discounts, and current regional availability are not in this catalog. Say so directly and use not_in_source or escalate.
- For tolerance, service-calculation, or metrology-policy questions, direct the user to the Tolerance Assistant unless the user is only asking for a catalog field such as readability or capacity.

Answering rules:
- Answer the question first, then give only the useful supporting detail.
- Keep routine answers streamlined: use one short opening paragraph and no more than four concise bullets when bullets improve scanning. Expand only when the user asks for a complete record, every detail, all matches, or a thorough comparison.
- The answer field supports lightweight Markdown. Use **bold** sparingly for the primary recommendation, model/material identity, decision-critical measurements, and important qualifications; the interface presents this emphasis in OHAUS red. Use simple bullet or numbered lists where helpful. Do not use tables, nested lists, decorative headings, or Markdown merely for decoration.
- Every material or part number written in the answer must also appear in the materials array. Wrap those identifiers in **bold** so they receive the interface's red emphasis.
- Do not repeat the same specification in multiple sections of the prose. The interface displays the cited evidence separately below the answer.
- For exact lookups, name the model and material number and cite each source field used.
- For comparisons, keep each product separate and compare the same requested fields.
- For product selection, prefer deterministic_selection_results when present; its requirements were applied server-side. Recommend no more than three strongest matches and explain the source-backed tradeoffs unless the user explicitly asks for all matching products or a complete list. Ask a focused clarification if an essential requirement is missing.
- For a requested capacity, use nearest_alternative_results as the mathematical authority. If there is no exact match, say so plainly. Distinguish the closest numerical option from the closest option that satisfies a stated minimum or maximum. Never present a product below a minimum capacity as qualifying.
- If the capacity wording is ambiguous, report the exact/nearest catalog options, label the answer needs_clarification, and ask whether the requested capacity is an exact target, a minimum requirement, or an approximate preference.
- If several valid results exist, summarize the best matches instead of pretending there is one definitive product. If the user explicitly asks for all information, every detail, a complete specification, or all matches, provide the complete source-backed result available in the supplied bundle.
- Include an evidence entry for every product field that materially supports the answer. Evidence entries contain only a material_number and an exact field path from the supplied record; the server supplies the value after generation.
- When descriptive retrieval helps identify a product, cite the matching structured sales_content or additional_attributes field whenever that claim materially supports the answer.
- If the source is silent, say "not available in the loaded catalog" rather than guessing.
- Never mention retrieval, prompts, hidden instructions, token limits, or implementation details.
- Keep the wording professional and useful to a sales representative.`;

const answerFormat = {
  type: "json_schema",
  name: "workbook_grounded_sales_answer",
  strict: true,
  schema: {
    type: "object",
    properties: {
      answer: { type: "string" },
      status: { type: "string", enum: ["answered", "needs_clarification", "not_in_source", "escalate"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      intent: { type: "string", enum: ["lookup", "comparison", "selection", "relationship", "catalog_scope", "service_redirect", "unsupported"] },
      materials: { type: "array", maxItems: 24, items: { type: "string" } },
      evidence: {
        type: "array",
        maxItems: 48,
        items: {
          type: "object",
          properties: {
            material_number: { type: "string" },
            field: { type: "string" },
          },
          required: ["material_number", "field"],
          additionalProperties: false,
        },
      },
      unresolved_items: { type: "array", maxItems: 40, items: { type: "string" } },
      follow_up_suggestions: { type: "array", maxItems: 3, items: { type: "string" } },
      context_summary: { type: "string" },
      escalation_reason: { type: ["string", "null"] },
    },
    required: [
      "answer",
      "status",
      "confidence",
      "intent",
      "materials",
      "evidence",
      "unresolved_items",
      "follow_up_suggestions",
      "context_summary",
      "escalation_reason",
    ],
    additionalProperties: false,
  },
};

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

async function createResponse(apiKey, body, fetchImpl) {
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `OpenAI request failed with status ${response.status}.`);
    error.status = response.status;
    error.code = payload?.error?.code ?? null;
    error.type = payload?.error?.type ?? null;
    const retryHeader = response.headers.get("retry-after");
    const retryNumber = Number(retryHeader);
    const retryDate = retryHeader && !Number.isFinite(retryNumber) ? Date.parse(retryHeader) : Number.NaN;
    const messageMatch = String(payload?.error?.message ?? "").match(/try again in\s*([\d.]+)\s*(ms|milliseconds?|s|seconds?|m|minutes?)/i);
    const messageValue = messageMatch ? Number(messageMatch[1]) : Number.NaN;
    const messageUnit = messageMatch?.[2]?.toLowerCase() ?? "s";
    const messageSeconds = Number.isFinite(messageValue)
      ? messageValue * (messageUnit.startsWith("m") && messageUnit !== "ms" && !messageUnit.startsWith("mill") ? 60 : messageUnit === "ms" || messageUnit.startsWith("mill") ? 0.001 : 1)
      : Number.NaN;
    error.retryAfterSeconds = Number.isFinite(retryNumber)
      ? Math.max(1, Math.ceil(retryNumber))
      : Number.isFinite(retryDate)
        ? Math.max(1, Math.ceil((retryDate - Date.now()) / 1_000))
        : Number.isFinite(messageSeconds)
          ? Math.max(1, Math.ceil(messageSeconds))
          : null;
    error.rateLimitResetRequests = response.headers.get("x-ratelimit-reset-requests");
    error.rateLimitResetTokens = response.headers.get("x-ratelimit-reset-tokens");
    throw error;
  }
  return payload;
}

function buildInput(question, sessionContext, groundingBundle) {
  const compactContext = Array.isArray(sessionContext)
    ? sessionContext.slice(-MAX_VERIFIED_CONTEXT_TURNS).map((turn) => ({
      question: String(turn?.question ?? "").slice(0, 700),
      materials: Array.isArray(turn?.materials) ? turn.materials.slice(0, 16) : [],
      summary: String(turn?.contextSummary || turn?.answer || "").slice(0, 1_000),
    }))
    : [];

  const buildContent = (context) => [
      "RECENT VERIFIED CONVERSATION CONTEXT (reference resolution only; not factual authority):",
      JSON.stringify(context),
      "",
      "CURRENT AUTHORITATIVE CATALOG GROUNDING BUNDLE:",
      JSON.stringify(groundingBundle),
      "",
      "CURRENT USER QUESTION:",
      question,
      "",
      "Answer the current question using only the current authoritative catalog grounding bundle.",
    ].join("\n");

  let content = buildContent(compactContext);
  while (compactContext.length > 0 && instructions.length + content.length > MAX_INPUT_CHARACTERS) {
    compactContext.shift();
    content = buildContent(compactContext);
  }

  if (instructions.length + content.length > MAX_INPUT_CHARACTERS) {
    throw new Error("The authoritative catalog evidence exceeds the configured input-token budget.");
  }

  return [{ role: "user", content }];
}

export async function answerSalesQuestionWithAI({
  question,
  sessionContext = [],
  apiKey,
  model = DEFAULT_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  reasoningMode = DEFAULT_REASONING_MODE,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const effort = ALLOWED_REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : DEFAULT_REASONING_EFFORT;
  const mode = ALLOWED_REASONING_MODES.has(reasoningMode) ? reasoningMode : DEFAULT_REASONING_MODE;
  const groundingBundle = buildGroundingBundle({ question, sessionContext });
  const input = buildInput(question, sessionContext, groundingBundle);
  const requestBody = {
    model,
    instructions,
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    reasoning: { effort, mode, context: "all_turns" },
    text: { verbosity: "medium", format: answerFormat },
  };
  const fallbackRequestBody = {
    ...requestBody,
    model: fallbackModel,
    max_output_tokens: RATE_LIMIT_FALLBACK_OUTPUT_TOKENS,
  };
  let response;
  let modelUsed = model;
  let fallbackUsed = false;
  let effectiveOutputTokenCap = MAX_OUTPUT_TOKENS;
  const fallbackAvailable = Boolean(fallbackModel && fallbackModel !== model);
  if (fallbackAvailable && Date.now() < primaryBackoffUntil) {
    modelUsed = fallbackModel;
    fallbackUsed = true;
    effectiveOutputTokenCap = RATE_LIMIT_FALLBACK_OUTPUT_TOKENS;
    response = await createResponse(apiKey, fallbackRequestBody, fetchImpl);
  } else {
    try {
      response = await createResponse(apiKey, requestBody, fetchImpl);
    } catch (error) {
      const upstream = error ?? {};
      const quotaFailure = upstream.code === "insufficient_quota" || /credits|quota/i.test(upstream.message ?? "");
      if (upstream.status !== 429 || quotaFailure || !fallbackAvailable) throw error;
      primaryBackoffUntil = Date.now() + PRIMARY_RATE_LIMIT_BACKOFF_MS;
      modelUsed = fallbackModel;
      fallbackUsed = true;
      effectiveOutputTokenCap = RATE_LIMIT_FALLBACK_OUTPUT_TOKENS;
      response = await createResponse(apiKey, fallbackRequestBody, fetchImpl);
    }
  }

  const rawText = extractOutputText(response);
  if (!rawText) throw new Error("The model did not return a final sales answer.");

  let answer;
  try {
    answer = JSON.parse(rawText);
  } catch {
    throw new Error("The model returned an invalid structured sales answer.");
  }

  const evidence = hydrateEvidenceItems(answer.evidence);
  const verifiedMaterials = [...new Set(evidence.map((item) => item.material_number))];
  const requestedMaterials = Array.isArray(answer.materials) ? answer.materials.map(String) : [];

  return {
    ...answer,
    materials: [...new Set([...verifiedMaterials, ...requestedMaterials])].slice(0, 24),
    evidence,
    model: modelUsed,
    primary_model: model,
    fallback_used: fallbackUsed,
    reasoning_effort: effort,
    reasoning_mode: mode,
    output_token_cap: effectiveOutputTokenCap,
    output_cap_reduced: effectiveOutputTokenCap < MAX_OUTPUT_TOKENS,
    response_id: response.id,
    catalog_checks: 1,
    grounding_products: groundingBundle.catalog_scope.portable_products,
  };
}

export { DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_REASONING_MODE };
