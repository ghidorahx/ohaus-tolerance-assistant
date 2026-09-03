import { buildGroundingBundle, hydrateEvidenceItems } from "./sales-catalog.mjs";

const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_FALLBACK_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_REASONING_MODE = "standard";
const DEFAULT_SERVICE_TIER = "fast";
// Retrieval should do the heavy lifting. A compact request improves time to
// first token and leaves enough room for a source-complete answer when asked.
export const MAX_VERIFIED_CONTEXT_TURNS = 12;
export const MAX_TOTAL_REQUEST_TOKENS = 66_000;
export const MAX_OUTPUT_TOKENS = 12_000;
export const MAX_INPUT_TOKENS = MAX_TOTAL_REQUEST_TOKENS - MAX_OUTPUT_TOKENS;
export const RATE_LIMIT_FALLBACK_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS;
export const MAX_ANSWER_ITEMS = 80;
export const MAX_ANSWER_MATERIALS = 96;
export const MAX_ANSWER_EVIDENCE = 96;
const APPROXIMATE_CHARACTERS_PER_INPUT_TOKEN = 3;
const MAX_INPUT_CHARACTERS = MAX_INPUT_TOKENS * APPROXIMATE_CHARACTERS_PER_INPUT_TOKEN;
const ALLOWED_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_REASONING_MODES = new Set(["standard", "pro"]);
const PRIMARY_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
let primaryBackoffUntil = 0;

const PROMPT_CACHE_KEY = "ohaus-ask-master-catalog-v1";

const instructions = `You are a professional internal product-knowledge assistant for the loaded Excel-derived master product catalog.

Your goal is to answer the user's product question quickly, clearly, and accurately from the catalog while preserving the exact limits of the source.

Grounding rules:
- A server-generated JSON grounding bundle is supplied with every current question. That bundle is the only authority for product facts. Do not use memory, brand knowledge, or assumptions.
- The bundle may include exact identifier or alias matches, lexical and semantic retrieval matches, structured fields, relationship results, document links, and catalog scope. Inspect every supplied section that is relevant to the question.
- Retrieval may translate recognized colloquial phrases into catalog terminology. Treat any interpretation as a query-routing aid, not product evidence. When an interpretation is uncertain or materially changes the recommendation, briefly confirm the customer's intent.
- Use retrieval matches to locate likely records. A retrieval score only ranks relevance; it is not proof that a claim is true.
- Exact specifications, numeric requirements, identity, documents, and relationship claims must come from the hydrated structured records and exact source fields in the bundle.
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
- For product selection, prefer server-filtered or exact results when present. Recommend no more than three strongest matches and explain source-backed tradeoffs unless the user explicitly asks for all matching products or a complete list. Ask a focused clarification if an essential requirement is missing.
- For numeric requirements, use the server-provided numeric constraints and eligible matches as the mathematical authority. If there is no exact match, say so plainly. Distinguish the closest numerical option from the closest option that satisfies a stated minimum or maximum. Never present a product below a minimum requirement as qualifying.
- If the capacity wording is ambiguous, report the exact/nearest catalog options, label the answer needs_clarification, and ask whether the requested capacity is an exact target, a minimum requirement, or an approximate preference.
- If several valid results exist, summarize the best matches instead of pretending there is one definitive product. If the user explicitly asks for all information, every detail, a complete specification, or all matches, provide the complete source-backed result available in the supplied bundle.
- Include an evidence entry for every product field that materially supports the answer. Evidence entries contain only a material_number and an exact field path from the supplied record; the server supplies the value after generation.
- When descriptive retrieval helps identify a product, cite the matching structured evidence field whenever that claim materially supports the answer.
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
        maxItems: MAX_ANSWER_ITEMS,
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
      materials: { type: "array", maxItems: MAX_ANSWER_MATERIALS, items: { type: "string" } },
      evidence: {
        type: "array",
        maxItems: MAX_ANSWER_EVIDENCE,
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
      summary: String(turn?.contextSummary || turn?.answer || "").slice(0, 700),
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

export function outputTokenLimitForQuestion(question) {
  const query = String(question ?? "").toLowerCase();
  if (/\b(everything|every detail|all (?:available )?(?:details|information|specifications?|fields)|complete (?:record|specification|details?))\b/.test(query)) {
    return MAX_OUTPUT_TOKENS;
  }
  if (/\b(?:compatible|compatibility|fit|fits|accessories|spare[ -]?parts?|replacement(?:[ -]?parts?)?|services?|cross[ -]?sell(?:ing)?|upsell(?:ing)?s?|related items?)\b|\bworks?\s+with\b/.test(query)) {
    return 8_000;
  }
  if (/\b(compare|comparison|recommend|which (?:products?|models?|items?)|all (?:matches|products?|models?|items?))\b/.test(query)) {
    return 4_000;
  }
  return 2_400;
}

function canRetryForCompleteList(question) {
  return /\b(?:all|every|complete|list|compatible|compatibility|fit|fits|accessories|spare[ -]?parts?|replacement(?:[ -]?parts?)?|services?|cross[ -]?sell(?:ing)?|upsell(?:ing)?s?|related items?)\b|\bworks?\s+with\b/i.test(String(question ?? ""));
}

function maxOutputWasReached(response) {
  return response?.status === "incomplete" && response?.incomplete_details?.reason === "max_output_tokens";
}

function answerTooLongError() {
  const error = new Error("The complete source-backed answer exceeded the configured output limit. Narrow the requested list and try again.");
  error.code = "answer_too_long";
  return error;
}

const RELATIONSHIP_TRUNCATION_NOTE = "Additional catalog relationships are not shown; narrow the relationship type to see a smaller set.";

function explicitlyRequestsCompleteRelationshipList(question, intent) {
  const query = String(question ?? "");
  if (intent === "selection") return false;
  if (/\b(?:recommend|recommendation|best|better|ideal|suitable|should\s+(?:i|we)|most appropriate)\b/i.test(query)) return false;
  if (/\b(?:top|first|best)\s+\d+\b/i.test(query)) return false;
  if (/\b(?:give|show|list)\s+(?:me\s+)?(?:the\s+)?\d+\b/i.test(query)) return false;
  const enumeratesItems = /\b(?:which|what|list|show|all|every)\b/i.test(query)
    && /\b(?:models?|products?|items?|balances?|scales?|instruments?|accessor(?:y|ies)|spare\s*parts?|replacement\s*parts?|related\s*items?)\b/i.test(query);
  const asksRelationship = /\b(?:compatible|compatibility|fit|fits|work|works|use|uses|using|accept|accepts|support|supports|accessor(?:y|ies)|spare\s*parts?|replacement\s*parts?|related\s*items?|relationships?)\b/i.test(query);
  return intent === "relationship" && enumeratesItems && asksRelationship;
}

function canonicalRelationshipItems(groundingBundle, groundedMaterials) {
  const entries = [];
  const sourceMaterials = new Set();
  const seen = new Set();
  const add = ({ identifier, label, description, direction, relationshipType }) => {
    const material = String(identifier ?? "").trim();
    if (!material || seen.has(material) || (groundedMaterials && !groundedMaterials.has(material))) return;
    seen.add(material);
    entries.push({
      identifier: material,
      label: String(label ?? "").trim(),
      description,
      direction,
      relationshipType,
    });
  };

  if (Array.isArray(groundingBundle?.relationships)) {
    const exactMaterials = new Set((groundingBundle.exact_matches ?? [])
      .filter((match) => match?.status === "found" && match?.material?.material_number)
      .map((match) => String(match.material.material_number)));
    if (exactMaterials.size === 0) return { entries: [], sourceMaterials: [], truncated: false };
    for (const material of exactMaterials) sourceMaterials.add(material);
    for (const relationship of groundingBundle.relationships) {
      const inbound = relationship?.direction === "inbound";
      const matchedMaterial = String(relationship?.matched_material_number
        ?? (inbound ? relationship?.target_material_number : relationship?.source_material_number)
        ?? "");
      if (!exactMaterials.has(matchedMaterial)) continue;
      const relationshipType = String(relationship?.relationship_type ?? "related_item");
      const label = inbound
        ? relationship?.source_model ?? relationship?.source_product_name
        : relationship?.target_model ?? relationship?.target_product_name;
      const unresolved = inbound
        ? !label
        : Number(relationship?.target_resolved) !== 1;
      add({
        identifier: relationship?.related_material_number
          ?? (inbound ? relationship?.source_material_number : relationship?.target_material_number),
        label,
        description: `${inbound ? "Compatible model" : relationshipType.replaceAll("_", " ")} listed in the Excel catalog${unresolved ? "; related catalog record unresolved" : ""}`,
        direction: inbound ? "inbound" : "outbound",
        relationshipType,
      });
    }
    return {
      entries,
      sourceMaterials: [...sourceMaterials],
      truncated: Boolean(groundingBundle.truncated?.relationships) || entries.length > MAX_ANSWER_ITEMS,
    };
  }

  const groups = Array.isArray(groundingBundle?.relationship_results) ? groundingBundle.relationship_results : [];
  let sourceReportedMore = false;
  for (const group of groups) {
    const sourceMaterial = String(group?.source?.material_number ?? "").trim();
    if (sourceMaterial) sourceMaterials.add(sourceMaterial);
    const relationships = Array.isArray(group?.relationships) ? group.relationships : [];
    if (Number(group?.relationship_count) > relationships.length) sourceReportedMore = true;
    for (const relationship of relationships) {
      const inbound = relationship?.direction === "inbound";
      const relationshipType = String(relationship?.relationship_type ?? "related_item");
      const unresolved = Boolean(relationship?.resolution_status && relationship.resolution_status !== "resolved");
      add({
        identifier: relationship?.related_material_number,
        label: relationship?.related_item?.model ?? relationship?.related_item?.product_name,
        description: `${inbound ? "Compatible model" : relationshipType.replaceAll("_", " ")} listed in the Excel catalog${unresolved ? "; related catalog record unresolved" : ""}`,
        direction: inbound ? "inbound" : "outbound",
        relationshipType,
      });
    }
  }
  return {
    entries,
    sourceMaterials: [...sourceMaterials],
    truncated: sourceReportedMore || entries.length > MAX_ANSWER_ITEMS,
  };
}

function canonicalizeCompleteRelationshipList({ question, answer, answerItems, groundingBundle, groundedMaterials }) {
  const unchanged = {
    answer: String(answer.answer ?? ""),
    answerItems,
    status: answer.status,
    confidence: answer.confidence,
    unresolvedItems: Array.isArray(answer.unresolved_items) ? answer.unresolved_items : [],
    sourceMaterials: [],
  };
  if (!explicitlyRequestsCompleteRelationshipList(question, answer.intent)) return unchanged;
  const canonical = canonicalRelationshipItems(groundingBundle, groundedMaterials);
  if (canonical.entries.length === 0) return unchanged;

  const expected = canonical.entries.slice(0, MAX_ANSWER_ITEMS);
  const generatedByIdentifier = new Map();
  for (const item of answerItems) {
    if (!generatedByIdentifier.has(item.identifier)) generatedByIdentifier.set(item.identifier, item);
  }
  const merged = expected.map((item) => {
    const generated = generatedByIdentifier.get(item.identifier);
    return {
      identifier: item.identifier,
      label: item.label || generated?.label || "Catalog item",
      description: generated?.description || item.description,
    };
  });
  const generatedIdentifiers = new Set(answerItems.map((item) => item.identifier));
  const repaired = answerItems.length !== expected.length
    || generatedIdentifiers.size !== expected.length
    || expected.some((item) => !generatedIdentifiers.has(item.identifier));
  const allInbound = expected.every((item) => item.direction === "inbound");
  const relationshipTypes = new Set(expected.map((item) => item.relationshipType));
  const subject = allInbound
    ? "compatible models"
    : relationshipTypes.size === 1
      ? String(expected[0].relationshipType).replaceAll("_", " ")
      : "related catalog items";
  const truncated = canonical.truncated;
  const unresolvedItems = [...unchanged.unresolvedItems];
  if (truncated && !unresolvedItems.includes(RELATIONSHIP_TRUNCATION_NOTE)) unresolvedItems.push(RELATIONSHIP_TRUNCATION_NOTE);
  const summary = truncated
    ? `Showing ${merged.length} verified ${subject}; the catalog lookup indicates that additional relationships may be available.`
    : `${merged.length} ${subject} ${merged.length === 1 ? "is" : "are"} listed in the loaded Excel catalog.`;

  return {
    answer: repaired || truncated ? summary : unchanged.answer,
    answerItems: merged,
    status: repaired ? "answered" : unchanged.status,
    confidence: truncated ? "medium" : unchanged.confidence,
    unresolvedItems,
    sourceMaterials: canonical.sourceMaterials,
  };
}

/**
 * @typedef {object} VerifiedContextTurn
 * @property {string} question
 * @property {string} answer
 * @property {string[]} materials
 * @property {string} contextSummary
 */

/**
 * @typedef {object} SemanticRetrieval
 * @property {string} status
 * @property {string=} index
 * @property {Array<{id?: string, score?: number, document_id?: string}>=} matches
 */

/**
 * @param {object} options
 * @param {string} options.question
 * @param {VerifiedContextTurn[]=} options.sessionContext
 * @param {string} options.apiKey
 * @param {string=} options.model
 * @param {string=} options.fallbackModel
 * @param {string=} options.reasoningEffort
 * @param {string=} options.reasoningMode
 * @param {SemanticRetrieval | null=} options.semanticRetrieval
 * @param {object | null=} options.groundingBundle
 * @param {((items: unknown, groundingBundle: object) => unknown | Promise<unknown>)=} options.evidenceHydrator
 * @param {typeof fetch=} options.fetchImpl
 */
export async function answerSalesQuestionWithAI({
  question,
  sessionContext = [],
  apiKey,
  model = DEFAULT_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  reasoningMode = DEFAULT_REASONING_MODE,
  semanticRetrieval = null,
  groundingBundle: suppliedGroundingBundle = null,
  evidenceHydrator = null,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const effort = ALLOWED_REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : DEFAULT_REASONING_EFFORT;
  const mode = ALLOWED_REASONING_MODES.has(reasoningMode) ? reasoningMode : DEFAULT_REASONING_MODE;
  const groundingBundle = suppliedGroundingBundle
    ?? buildGroundingBundle({ question, sessionContext, semanticRetrieval });
  const input = buildInput(question, sessionContext, groundingBundle);
  const outputTokenCap = outputTokenLimitForQuestion(question);
  const requestBody = {
    model,
    instructions,
    input,
    max_output_tokens: outputTokenCap,
    store: false,
    prompt_cache_key: PROMPT_CACHE_KEY,
    prompt_cache_options: { mode: "implicit", ttl: "30m" },
    service_tier: DEFAULT_SERVICE_TIER,
    reasoning: { effort, mode, context: "current_turn" },
    text: { verbosity: "low", format: answerFormat },
  };
  const fallbackRequestBody = {
    ...requestBody,
    model: fallbackModel,
    max_output_tokens: Math.min(outputTokenCap, RATE_LIMIT_FALLBACK_OUTPUT_TOKENS),
  };
  let response;
  let modelUsed = model;
  let fallbackUsed = false;
  let effectiveOutputTokenCap = outputTokenCap;
  const fallbackAvailable = Boolean(fallbackModel && fallbackModel !== model);
  if (fallbackAvailable && Date.now() < primaryBackoffUntil) {
    modelUsed = fallbackModel;
    fallbackUsed = true;
    effectiveOutputTokenCap = Math.min(outputTokenCap, RATE_LIMIT_FALLBACK_OUTPUT_TOKENS);
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
      effectiveOutputTokenCap = Math.min(outputTokenCap, RATE_LIMIT_FALLBACK_OUTPUT_TOKENS);
      response = await createResponse(apiKey, fallbackRequestBody, fetchImpl);
    }
  }

  if (maxOutputWasReached(response) && effectiveOutputTokenCap < MAX_OUTPUT_TOKENS && canRetryForCompleteList(question)) {
    effectiveOutputTokenCap = MAX_OUTPUT_TOKENS;
    response = await createResponse(apiKey, {
      ...requestBody,
      model: modelUsed,
      max_output_tokens: effectiveOutputTokenCap,
    }, fetchImpl);
  }
  if (maxOutputWasReached(response)) throw answerTooLongError();

  const rawText = extractOutputText(response);
  if (!rawText) throw new Error("The model did not return a final sales answer.");

  let answer;
  try {
    answer = JSON.parse(rawText);
  } catch {
    throw new Error("The model returned an invalid structured sales answer.");
  }

  const evidence = evidenceHydrator
    ? await evidenceHydrator(answer.evidence, groundingBundle)
    : hydrateEvidenceItems(answer.evidence);
  const verifiedMaterials = [...new Set(evidence.map((item) => item.material_number))];
  const groundedMaterialList = Array.isArray(groundingBundle.allowed_material_numbers)
    ? groundingBundle.allowed_material_numbers.map(String)
    : null;
  const groundedMaterials = groundedMaterialList ? new Set(groundedMaterialList) : null;
  const requestedMaterials = Array.isArray(answer.materials)
    ? answer.materials.map(String).filter((material) => !groundedMaterials || groundedMaterials.has(material))
    : [];
  const generatedAnswerItems = Array.isArray(answer.answer_items)
    ? answer.answer_items
      .map((item) => ({
        identifier: String(item?.identifier ?? "").trim(),
        label: String(item?.label ?? "").trim(),
        description: String(item?.description ?? "").trim(),
      }))
      .filter((item) => item.identifier && (!groundedMaterials || groundedMaterials.has(item.identifier)))
      .slice(0, MAX_ANSWER_ITEMS)
    : [];
  const canonicalRelationship = canonicalizeCompleteRelationshipList({
    question,
    answer,
    answerItems: generatedAnswerItems,
    groundingBundle,
    groundedMaterials,
  });
  const answerItems = canonicalRelationship.answerItems;

  return {
    ...answer,
    answer: canonicalRelationship.answer,
    status: canonicalRelationship.status,
    confidence: canonicalRelationship.confidence,
    unresolved_items: canonicalRelationship.unresolvedItems,
    answer_engine: "ai",
    ai_used: true,
    answer_items: answerItems,
    materials: [...new Set([
      ...verifiedMaterials,
      ...requestedMaterials,
      ...canonicalRelationship.sourceMaterials,
      ...answerItems.map((item) => item.identifier),
    ])].slice(0, MAX_ANSWER_MATERIALS),
    evidence,
    model: modelUsed,
    primary_model: model,
    fallback_used: fallbackUsed,
    service_tier: response.service_tier ?? DEFAULT_SERVICE_TIER,
    service_tier_requested: DEFAULT_SERVICE_TIER,
    reasoning_effort: effort,
    reasoning_mode: mode,
    output_token_cap: effectiveOutputTokenCap,
    output_cap_reduced: effectiveOutputTokenCap < MAX_OUTPUT_TOKENS,
    response_id: response.id,
    catalog_checks: 1,
    grounding_products: groundingBundle.catalog_scope?.materials
      ?? groundingBundle.catalog_scope?.portable_products
      ?? 0,
    retrieval_strategy: groundingBundle.retrieval_document_matches?.strategy
      ?? groundingBundle.retrieval?.strategy
      ?? groundingBundle.retrieval_strategy
      ?? "exact_record",
    vectorize_status: groundingBundle.retrieval_document_matches?.vectorize_status
      ?? groundingBundle.retrieval?.vectorize_status
      ?? groundingBundle.vectorize_status
      ?? "not_needed",
    retrieval_documents_sent: groundingBundle.retrieval_document_matches?.result_count
      ?? groundingBundle.retrieval?.result_count
      ?? groundingBundle.chunks?.length
      ?? 0,
  };
}

export {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODE,
  DEFAULT_SERVICE_TIER,
};
