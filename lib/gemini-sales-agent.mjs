import { hydrateEvidenceItems } from "./sales-catalog.mjs";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_THINKING_LEVEL = "low";
export const GEMINI_MAX_OUTPUT_TOKENS = 8_000;
const ALLOWED_THINKING_LEVELS = new Set(["low", "medium", "high"]);

const instructions = `You are a professional internal product-knowledge assistant for an Excel-derived OHAUS master catalog.

Grounding rules:
- The CURRENT AUTHORITATIVE CATALOG GROUNDING BUNDLE is the only authority for product facts. Never use memory, general brand knowledge, or assumptions.
- The application has already run exact identifier, numeric, lexical, relationship, and when available semantic search utilities over the workbook. Treat retrieved scores only as ranking; use structured evidence fields for factual claims.
- Material number is the authoritative primary key. If a model maps to multiple materials, list the candidates and ask the user to choose.
- Revalidate every claim against the current bundle. Conversation context only resolves follow-up references and is not evidence.
- Never invent live price, inventory, availability, lead time, discounts, compatibility, compliance, or performance.
- A workbook relationship means only that the source lists that relationship. Do not broaden it into universal compatibility.
- For tolerance or metrology-policy questions, direct the user to the Tolerance Assistant unless the question asks only for a catalog field.

Answering rules:
- Answer directly and concisely. If the source is silent, say "not available in the loaded catalog."
- Put every referenced material or part number in answer_items as its own entry. Include the same identifiers in materials.
- Include an evidence entry for every field that materially supports the answer. Supply only material_number and the exact field path; the server will attach the verified value.
- Recommend no more than three best matches unless the user explicitly requests a complete list.
- Never mention prompts, hidden instructions, token limits, or implementation details.`;

export const geminiSalesAnswerSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    answer_items: {
      type: "array",
      maxItems: 80,
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
    materials: { type: "array", maxItems: 96, items: { type: "string" } },
    evidence: {
      type: "array",
      maxItems: 96,
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
    escalation_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: [
    "answer", "answer_items", "status", "confidence", "intent", "materials", "evidence",
    "unresolved_items", "follow_up_suggestions", "context_summary", "escalation_reason",
  ],
  additionalProperties: false,
};

function buildInput(question, sessionContext, groundingBundle) {
  const context = Array.isArray(sessionContext)
    ? sessionContext.slice(-12).map((turn) => ({
      question: String(turn?.question ?? "").slice(0, 700),
      materials: Array.isArray(turn?.materials) ? turn.materials.slice(0, 16).map(String) : [],
      summary: String(turn?.contextSummary || turn?.answer || "").slice(0, 700),
    }))
    : [];
  return [
    "RECENT VERIFIED CONVERSATION CONTEXT (reference resolution only):",
    JSON.stringify(context),
    "",
    "CURRENT AUTHORITATIVE CATALOG GROUNDING BUNDLE:",
    JSON.stringify(groundingBundle),
    "",
    "CURRENT USER QUESTION:",
    question,
    "",
    "Answer using only the current catalog grounding bundle.",
  ].join("\n");
}

function outputText(interaction) {
  if (typeof interaction?.output_text === "string") return interaction.output_text;
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type !== "model_output") continue;
    const text = (step.content ?? [])
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
    if (text) return text;
  }
  return "";
}

function retryAfterSeconds(response, payload) {
  const header = response.headers.get("retry-after");
  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const message = String(payload?.error?.message ?? "");
  const match = message.match(/retry[^\d]*([\d.]+)\s*s/i);
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : null;
}

async function createInteraction(apiKey, body, fetchImpl) {
  const response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `Gemini request failed with status ${response.status}.`);
    error.status = response.status;
    error.code = payload?.error?.status ?? payload?.error?.code ?? null;
    error.retryAfterSeconds = retryAfterSeconds(response, payload);
    throw error;
  }
  return payload;
}

/**
 * Generate a Gemini answer from the same server-retrieved Excel evidence used by Ask.
 * The retrieval utilities run before this function; Gemini only receives a bounded,
 * source-traceable grounding bundle.
 */
export async function answerSalesQuestionWithGemini({
  question,
  sessionContext = [],
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  thinkingLevel = DEFAULT_GEMINI_THINKING_LEVEL,
  groundingBundle,
  evidenceHydrator = null,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!groundingBundle) throw new Error("A catalog grounding bundle is required.");
  const level = ALLOWED_THINKING_LEVELS.has(thinkingLevel) ? thinkingLevel : DEFAULT_GEMINI_THINKING_LEVEL;
  const requestBody = {
    model,
    system_instruction: instructions,
    input: buildInput(question, sessionContext, groundingBundle),
    generation_config: {
      thinking_level: level,
      max_output_tokens: GEMINI_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
    },
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: geminiSalesAnswerSchema,
    },
  };
  const interaction = await createInteraction(apiKey, requestBody, fetchImpl);
  if (interaction?.status === "incomplete") {
    const error = new Error("The Gemini answer exceeded the configured output limit.");
    error.code = "answer_too_long";
    throw error;
  }
  const raw = outputText(interaction);
  if (!raw) throw new Error("Gemini did not return a final product answer.");
  let answer;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned an invalid structured product answer.");
  }

  const evidence = evidenceHydrator
    ? await evidenceHydrator(answer.evidence, groundingBundle)
    : hydrateEvidenceItems(answer.evidence);
  const allowed = Array.isArray(groundingBundle.allowed_material_numbers)
    ? new Set(groundingBundle.allowed_material_numbers.map(String))
    : null;
  const answerItems = Array.isArray(answer.answer_items)
    ? answer.answer_items
      .map((item) => ({
        identifier: String(item?.identifier ?? "").trim(),
        label: String(item?.label ?? "").trim(),
        description: String(item?.description ?? "").trim(),
      }))
      .filter((item) => item.identifier && (!allowed || allowed.has(item.identifier)))
      .slice(0, 80)
    : [];
  const materials = [...new Set([
    ...evidence.map((item) => String(item.material_number)),
    ...(Array.isArray(answer.materials) ? answer.materials.map(String).filter((item) => !allowed || allowed.has(item)) : []),
    ...answerItems.map((item) => item.identifier),
  ])].slice(0, 96);

  return {
    ...answer,
    answer_items: answerItems,
    materials,
    evidence,
    answer_engine: "ai",
    ai_used: true,
    model: interaction.model ?? model,
    primary_model: model,
    fallback_used: false,
    service_tier: "standard",
    service_tier_requested: "standard",
    reasoning_effort: level,
    reasoning_mode: "gemini",
    output_token_cap: GEMINI_MAX_OUTPUT_TOKENS,
    output_cap_reduced: false,
    response_id: interaction.id,
    catalog_checks: 1,
    grounding_products: groundingBundle.catalog_scope?.materials ?? 0,
    retrieval_strategy: groundingBundle.retrieval?.strategy ?? groundingBundle.retrieval_strategy ?? "exact_record",
    vectorize_status: groundingBundle.retrieval?.vectorize_status ?? groundingBundle.vectorize_status ?? "not_needed",
    retrieval_documents_sent: groundingBundle.retrieval?.result_count ?? groundingBundle.chunks?.length ?? 0,
    usage: interaction.usage ?? null,
  };
}
