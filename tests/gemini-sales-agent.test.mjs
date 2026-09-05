import assert from "node:assert/strict";
import test from "node:test";
import {
  answerSalesQuestionWithGemini,
  DEFAULT_GEMINI_MODEL,
} from "../lib/gemini-sales-agent.mjs";

const groundingBundle = {
  catalog_scope: { materials: 1 },
  allowed_material_numbers: ["30428204"],
  retrieval: { strategy: "exact_lexical", vectorize_status: "not_needed", result_count: 1 },
  evidence_fields: [{
    material_number: "30428204",
    model_or_item: "CR221",
    field: "specifications.maximum_capacity",
    value: "220 g",
    source_file: "catalog.xlsx",
  }],
};

test("Gemini uses low thinking, structured output, and hydrated Excel evidence", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({
      id: "interaction-test",
      model: DEFAULT_GEMINI_MODEL,
      status: "completed",
      steps: [{
        type: "model_output",
        content: [{
          type: "text",
          text: JSON.stringify({
            answer: "CR221 has a maximum capacity of 220 g.",
            answer_items: [{ identifier: "30428204", label: "CR221", description: "Maximum capacity: 220 g" }],
            status: "answered",
            confidence: "high",
            intent: "lookup",
            materials: ["30428204", "invented"],
            evidence: [
              { material_number: "30428204", field: "specifications.maximum_capacity" },
              { material_number: "invented", field: "specifications.maximum_capacity" },
            ],
            unresolved_items: [],
            follow_up_suggestions: [],
            context_summary: "The user asked about CR221 capacity.",
            escalation_reason: null,
          }),
        }],
      }],
      usage: { total_tokens: 123 },
    });
  };

  const result = await answerSalesQuestionWithGemini({
    question: "What is the capacity of CR221?",
    apiKey: "test-key",
    groundingBundle,
    evidenceHydrator: (items, bundle) => items.flatMap((item) => {
      const match = bundle.evidence_fields.find((candidate) =>
        candidate.material_number === item.material_number && candidate.field === item.field);
      return match ? [match] : [];
    }),
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com\/v1beta\/interactions$/);
  assert.equal(requests[0].headers["x-goog-api-key"], "test-key");
  assert.equal(requests[0].body.model, "gemini-3.7-flash");
  assert.equal(requests[0].body.generation_config.thinking_level, "low");
  assert.equal(requests[0].body.response_format.mime_type, "application/json");
  assert.equal(requests[0].body.response_format.schema.additionalProperties, false);
  assert.match(requests[0].body.input, /CURRENT AUTHORITATIVE CATALOG GROUNDING BUNDLE/);
  assert.deepEqual(result.materials, ["30428204"]);
  assert.deepEqual(result.evidence.map((item) => item.value), ["220 g"]);
  assert.equal(result.reasoning_mode, "gemini");
  assert.equal(result.usage.total_tokens, 123);
});

test("Gemini API failures preserve status and retry timing", async () => {
  await assert.rejects(
    answerSalesQuestionWithGemini({
      question: "Compare products",
      apiKey: "test-key",
      groundingBundle,
      fetchImpl: async () => Response.json(
        { error: { status: "RESOURCE_EXHAUSTED", message: "Please retry in 2.2s" } },
        { status: 429, headers: { "Retry-After": "3" } },
      ),
    }),
    (error) => error.status === 429 && error.code === "RESOURCE_EXHAUSTED" && error.retryAfterSeconds === 3,
  );
});
