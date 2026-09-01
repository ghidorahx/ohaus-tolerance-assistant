import assert from "node:assert/strict";
import test from "node:test";
import {
  answerSalesQuestionWithAI,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  DEFAULT_REASONING_PROFILE,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODE,
  resolveReasoningProfile,
} from "../lib/sales-agent.mjs";

test("routes adaptive answer modes without changing the GPT-5.6 Sol model", () => {
  assert.equal(DEFAULT_REASONING_PROFILE, "auto");
  assert.deepEqual(resolveReasoningProfile("What is the capacity of CR221?", "auto"), { profile: "auto", effort: "low" });
  assert.deepEqual(
    resolveReasoningProfile("Which balances support at least 5 kg capacity and battery operation?", "auto"),
    { profile: "auto", effort: "medium" },
  );
  assert.deepEqual(
    resolveReasoningProfile("Give me a thorough comparison of CR221 and CR5200 with all specifications and tradeoffs.", "auto"),
    { profile: "auto", effort: "high" },
  );
  assert.equal(resolveReasoningProfile("Any question", "fast").effort, "low");
  assert.equal(resolveReasoningProfile("Any question", "balanced").effort, "medium");
  assert.equal(resolveReasoningProfile("Any question", "thorough").effort, "high");
  assert.equal(resolveReasoningProfile("Any question", "not-valid").profile, "auto");
});

test("uses one quality-first GPT-5.6 Responses call with comprehensive workbook grounding", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: "resp-final",
      output_text: JSON.stringify({
        answer: "CR221 (30428204) has a maximum capacity of 220 g and readability of 0.1 g.",
        answer_items: [{ identifier: "30428204", label: "CR221", description: "220 g capacity with 0.1 g readability" }],
        status: "answered",
        confidence: "high",
        intent: "lookup",
        materials: ["30428204"],
        evidence: [
          { material_number: "30428204", field: "capacity" },
          { material_number: "30428204", field: "readability" },
        ],
        unresolved_items: [],
        follow_up_suggestions: ["How is CR221 powered?"],
        context_summary: "The user is discussing CR221 material 30428204.",
        escalation_reason: null,
      }),
      output: [],
    });
  };

  const result = await answerSalesQuestionWithAI({
    question: "What is the capacity and readability of CR221?",
    sessionContext: [{ question: "Tell me about CR221", answer: "CR221 is material 30428204.", materials: ["30428204"] }],
    apiKey: "test-key",
    fetchImpl,
  });

  assert.equal(DEFAULT_MODEL, "gpt-5.6-sol");
  assert.equal(DEFAULT_FALLBACK_MODEL, "gpt-5.6-terra");
  assert.equal(DEFAULT_REASONING_EFFORT, "high");
  assert.equal(DEFAULT_REASONING_MODE, "standard");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-5.6-sol");
  assert.deepEqual(requests[0].reasoning, { effort: "high", mode: "standard", context: "all_turns" });
  assert.equal(requests[0].max_output_tokens, 128_000);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].tools, undefined);
  assert.equal(requests[0].text.format.strict, true);
  assert.match(JSON.stringify(requests[0].input), /RECENT VERIFIED CONVERSATION CONTEXT/);
  assert.match(JSON.stringify(requests[0].input), /sales-grounding-v8/);
  assert.match(JSON.stringify(requests[0].input), /deterministic_selection_results/);
  assert.match(JSON.stringify(requests[0].input), /nearest_alternative_results/);
  assert.match(JSON.stringify(requests[0].input), /retrieval_document_matches/);
  assert.match(requests[0].instructions, /Keep routine answers streamlined/);
  assert.match(requests[0].instructions, /Use \*\*bold\*\* sparingly/);
  assert.match(requests[0].instructions, /Put every referenced material, item, or part number in answer_items/);
  assert.match(JSON.stringify(requests[0].input), /CR221/);
  assert.equal(result.evidence[0].value, "220 g");
  assert.deepEqual(result.answer_items, [{ identifier: "30428204", label: "CR221", description: "220 g capacity with 0.1 g readability" }]);
  assert.equal(result.catalog_checks, 1);
  assert.equal(result.grounding_products, 80);
  assert.equal(result.fallback_used, false);
  assert.equal(result.output_token_cap, 128_000);
  assert.equal(result.output_cap_reduced, false);
});

test("retains up to one hundred twenty compact verified turns for follow-up resolution", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({
      id: "resp-context",
      output_text: JSON.stringify({
        answer: "The requested follow-up is not available in the loaded catalog.",
        answer_items: [],
        status: "not_in_source",
        confidence: "high",
        intent: "unsupported",
        materials: [],
        evidence: [],
        unresolved_items: [],
        follow_up_suggestions: [],
        context_summary: "The user is testing retained verified context.",
        escalation_reason: null,
      }),
      output: [],
    });
  };
  const sessionContext = Array.from({ length: 125 }, (_, index) => ({
    question: `Context question ${index}`,
    answer: `Context answer ${index}`,
    materials: [],
    contextSummary: `Verified context marker ${index}`,
  }));

  await answerSalesQuestionWithAI({
    question: "What about the last item?",
    sessionContext,
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    fallbackModel: "gpt-5.6-terra",
    fetchImpl,
  });

  const input = JSON.stringify(requests[0].input);
  assert.doesNotMatch(input, /Verified context marker 4\b/);
  assert.match(input, /Verified context marker 5\b/);
  assert.match(input, /Verified context marker 124\b/);
});

test("preserves OpenAI retry timing on rate-limit errors", async () => {
  const fetchImpl = async () => Response.json(
    { error: { message: "Rate limit reached. Please try again in 18.2s.", code: "rate_limit_exceeded" } },
    { status: 429, headers: { "Retry-After": "19" } },
  );

  await assert.rejects(
    () => answerSalesQuestionWithAI({
      question: "Which products have a 225 g capacity?",
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      fallbackModel: "gpt-5.6-terra",
      fetchImpl,
    }),
    (error) => error.status === 429 && error.retryAfterSeconds === 19,
  );
});

test("falls back to GPT-5.6 Terra only when the Sol request is rate limited", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) {
      return Response.json({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }, { status: 429 });
    }
    return Response.json({
      id: "resp-terra",
      output_text: JSON.stringify({
        answer: "Live price is not available in the loaded catalog.",
        answer_items: [],
        status: "not_in_source",
        confidence: "high",
        intent: "unsupported",
        materials: [],
        evidence: [],
        unresolved_items: [],
        follow_up_suggestions: [],
        context_summary: "The user asked for live pricing.",
        escalation_reason: "A current price source is required.",
      }),
      output: [],
    });
  };

  const result = await answerSalesQuestionWithAI({
    question: "What is the price?",
    apiKey: "test-key",
    fetchImpl,
  });

  assert.deepEqual(requests.map((request) => request.model), ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(requests.map((request) => request.max_output_tokens), [128_000, 128_000]);
  assert.equal(result.model, "gpt-5.6-terra");
  assert.equal(result.primary_model, "gpt-5.6-sol");
  assert.equal(result.fallback_used, true);
  assert.equal(result.output_token_cap, 128_000);
  assert.equal(result.output_cap_reduced, false);

  const retry = await answerSalesQuestionWithAI({
    question: "Is current pricing in the catalog?",
    apiKey: "test-key",
    fetchImpl,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].model, "gpt-5.6-terra");
  assert.equal(retry.fallback_used, true);
});
