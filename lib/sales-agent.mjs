import { buildDeterministicLookupAnswer, buildGroundingBundle, hydrateEvidenceItems } from "./sales-catalog.mjs";

const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_FALLBACK_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_REASONING_MODE = "standard";
export const DEFAULT_REASONING_PROFILE = "auto";
export const REASONING_PROFILES = ["auto", "fast", "balanced", "thorough"];
export const MAX_VERIFIED_CONTEXT_TURNS = 120;
// Keep a large safety ceiling for unusually broad catalog questions, but avoid
// reserving the model's full output capacity for the concise answer schema.
export const MAX_TOTAL_REQUEST_TOKENS = 450_000;
export const MAX_OUTPUT_TOKENS = 8_000;
export const MAX_INPUT_TOKENS = MAX_TOTAL_REQUEST_TOKENS - MAX_OUTPUT_TOKENS;
export const RATE_LIMIT_FALLBACK_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS;
const APPROXIMATE_CHARACTERS_PER_INPUT_TOKEN = 3;
const MAX_INPUT_CHARACTERS = MAX_INPUT_TOKENS * APPROXIMATE_CHARACTERS_PER_INPUT_TOKEN;
const ALLOWED_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_REASONING_MODES = new Set(["standard", "pro"]);
const PRIMARY_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
let primaryBackoffUntil = 0;

export function resolveReasoningProfile(question, requestedProfile = DEFAULT_REASONING_PROFILE) {
  const profile = REASONING_PROFILES.includes(requestedProfile) ? requestedProfile : DEFAULT_REASONING_PROFILE;
  if (profile === "fast") return { profile, effort: "low" };
  if (profile === "balanced") return { profile, effort: "medium" };
  if (profile === "thorough") return { profile, effort: "high" };

  const text = String(question ?? "").trim();
  const normalized = text.toLowerCase();
  const identifiers = text.match(/\b(?:\d{8}|[a-z]{1,6}[- ]?\d{2,6}[a-z0-9]*)\b/gi) ?? [];
  const measurements = text.match(/\b[\d,.]+\s*(?:kg|kilograms?|g|grams?|mg|milligrams?)\b/gi) ?? [];
  const constraintSignals = normalized.match(/\b(?:at least|at most|minimum|maximum|must|needs?|requires?|without|with|and|or better)\b/g) ?? [];
  const asksForCompleteCoverage = /\b(?:all information|all details|all specifications|everything|complete|full|entire|exhaustive|thorough)\b/i.test(text);
  const asksForComparison = /\b(?:compare|comparison|versus|vs\.?|difference between)\b/i.test(text);
  const asksForSelection = /\b(?:which|recommend|suggest|best|find|shortlist|closest|suitable)\b/i.test(text);
  const asksForRelationships = /\b(?:accessor|spare part|replacement|related|compatible)\b/i.test(text);
  const isDense = text.length > 260
    || measurements.length >= 3
    || constraintSignals.length >= 5
    || (asksForComparison && identifiers.length >= 3)
    || (asksForCompleteCoverage && (asksForComparison || asksForSelection));

  if (isDense) return { profile, effort: "high" };
  if (asksForComparison || asksForSelection || asksForRelationships || measurements.length >= 2) {
    return { profile, effort: "medium" };
  }
  return { profile, effort: "low" };
}

const instructions = `You are a professional internal product-knowledge assistant for the loaded Excel-derived portable-balance catalog.

Your goal is to answer the user's product question quickly, clearly, and accurately from the catalog while preserving the exact limits of the source.

Grounding rules:
- A server-generated JSON grounding bundle is supplied with every current question. That bundle is the only authority for product facts. Do not use memory, brand knowledge, or assumptions.
- The bundle includes interpreted customer language, exact identifier matches, deterministic requirement-filter results when applicable, deterministic nearest-capacity alternatives, natural-language matches, generated Markdown retrieval-document matches, relationship results, topic-field matches, and catalog scope.
- interpreted_customer_language translates recognized colloquial phrases into catalog terminology before retrieval. Treat it as a query-routing aid, not product evidence. When an interpretation is uncertain or materially changes the recommendation, briefly confirm the customer's intent.
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
- Put every referenced material, item, or part number in answer_items as a separate object with exactly one identifier, its short model or item name as the label, and a concise source-backed description. Never combine two identifiers in one answer_items entry. Keep label to the name only (for example, "CR221"); do not put the identifier, punctuation, a repeated product title, specifications, or descriptive prose in label. The interface renders each entry on its own clean line with the identifier in red.
- Keep the answer string to a short lead or conclusion and do not repeat identifiers already represented in answer_items. Use an empty answer_items array when no numbered catalog item is relevant. Every answer_items identifier must also appear in the materials array.
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
      answer_items: {
        type: "array",
        maxItems: 24,
        items: {
          type: "object",
          properties: {
            identifier: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["identifier", "label", "description"],
          additionalProperties: false,
        },
      },
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
      "answer_items",
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

  return [
    {
      role: "developer",
      content: [{
        type: "input_text",
        text: instructions,
        prompt_cache_breakpoint: { mode: "explicit" },
      }],
    },
    { role: "user", content: [{ type: "input_text", text: content }] },
  ];
}

function usageSummary(response) {
  return {
    input_tokens: response?.usage?.input_tokens ?? null,
    cached_tokens: response?.usage?.input_tokens_details?.cached_tokens ?? 0,
    cache_write_tokens: response?.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    output_tokens: response?.usage?.output_tokens ?? null,
    reasoning_tokens: response?.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    total_tokens: response?.usage?.total_tokens ?? null,
  };
}

export async function answerSalesQuestionWithAI({
  question,
  sessionContext = /** @type {any[]} */ ([]),
  apiKey,
  model = DEFAULT_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  reasoningMode = DEFAULT_REASONING_MODE,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const startedAt = performance.now();
  const effort = ALLOWED_REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : DEFAULT_REASONING_EFFORT;
  const mode = ALLOWED_REASONING_MODES.has(reasoningMode) ? reasoningMode : DEFAULT_REASONING_MODE;
  const deterministicAnswer = buildDeterministicLookupAnswer(question);
  if (deterministicAnswer) {
    const evidence = hydrateEvidenceItems(deterministicAnswer.evidence);
    const totalMs = performance.now() - startedAt;
    return {
      ...deterministicAnswer,
      evidence,
      model: "Catalog lookup",
      primary_model: model,
      fallback_used: false,
      reasoning_effort: "none",
      reasoning_mode: "deterministic",
      output_token_cap: 0,
      output_cap_reduced: true,
      response_id: null,
      catalog_checks: 1,
      grounding_products: 1,
      delivery: "catalog_fast_path",
      timing: { grounding_ms: totalMs, openai_ms: 0, total_ms: totalMs },
      usage: usageSummary(null),
      grounding: { retrieval_documents: 0, exact_match_count: 1 },
    };
  }

  const groundingStartedAt = performance.now();
  const groundingBundle = buildGroundingBundle({ question, sessionContext });
  const input = buildInput(question, sessionContext, groundingBundle);
  const groundingMs = performance.now() - groundingStartedAt;
  const requestBody = {
    model,
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    prompt_cache_key: "ohaus-ask-workbook-v1",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    reasoning: { effort, mode, context: "current_turn" },
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
  const openaiStartedAt = performance.now();
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
  const answerItems = Array.isArray(answer.answer_items)
    ? answer.answer_items
      .map((item) => ({
        identifier: String(item?.identifier ?? "").trim(),
        label: String(item?.label ?? "").trim(),
        description: String(item?.description ?? "").trim(),
      }))
      .filter((item) => item.identifier)
      .slice(0, 24)
    : [];
  const openaiMs = performance.now() - openaiStartedAt;
  const totalMs = performance.now() - startedAt;

  return {
    ...answer,
    answer_items: answerItems,
    materials: [...new Set([...verifiedMaterials, ...requestedMaterials, ...answerItems.map((item) => item.identifier)])].slice(0, 24),
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
    delivery: "openai",
    timing: { grounding_ms: groundingMs, openai_ms: openaiMs, total_ms: totalMs },
    usage: usageSummary(response),
    grounding: {
      retrieval_documents: groundingBundle.retrieval_document_matches.result_count,
      exact_match_count: groundingBundle.exact_identifier_matches.length,
    },
  };
}

export { DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_REASONING_MODE };
