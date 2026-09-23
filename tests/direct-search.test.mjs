import test from "node:test";
import assert from "node:assert/strict";
import { handleDirectSearch, directSearchHealth } from "../lib/direct-search-handler.mjs";
import { answerDirectGoogleSearch } from "../lib/gemini-google-search-agent.mjs";

const env = { GOOGLE_DIRECT_TEST_ENABLED: "true", SALES_PILOT_ACCESS_CODE: "unit-code", GEMINI_API_KEY: "unit-key" };
const factualText = "The capacity is 220 g.";
const citation = { type: "url_citation", url: "https://ohaus.com/test", title: "OHAUS", start_index: 0, end_index: factualText.length };
let nextRequest = 0;

function request(question, extras = {}) {
  return new Request("https://preview.example/api/google-direct", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pilot-access-code": "unit-code",
      "cf-connecting-ip": `test-direct-${++nextRequest}`,
      ...extras.headers,
    },
    body: JSON.stringify({ question, context: extras.context ?? [] }),
  });
}

function searchSteps({ suggestions = true, isError = false } = {}) {
  return [
    { type: "google_search_call", queries: ["OHAUS CR221 capacity"] },
    { type: "google_search_result", ...(isError ? { is_error: true } : {}), result: [{ ...(suggestions ? { search_suggestions: "<div>Search</div>" } : {}) }] },
  ];
}

function grounded({ text = factualText, annotations = [citation], suggestions = true, status = "completed", before = [] } = {}) {
  return {
    status,
    steps: [...searchSteps({ suggestions }), ...before, { type: "model_output", content: [{ type: "text", text, annotations }] }],
  };
}

function terminalTool(name, args, { searched = false, status = "requires_action", extra = [] } = {}) {
  return {
    status,
    steps: [
      ...(searched ? searchSteps() : []),
      { type: "function_call", name, arguments: args },
      ...extra,
    ],
  };
}

function sequenceFetch(payloads, calls = []) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const payload = payloads[Math.min(calls.length - 1, payloads.length - 1)];
    // Give each attempt an independent body. A live clone's tee would keep
    // cancellation waiting on the unconsumed original response in this fixture.
    return payload instanceof Response
      ? new Response(await payload.clone().arrayBuffer(), { status: payload.status, headers: payload.headers })
      : Response.json(payload);
  };
}

function direct(fetchImpl, extras = {}) {
  return answerDirectGoogleSearch({ question: "What is CR221 capacity?", apiKey: "unit-key", fetchImpl, ...extras });
}

test("direct test makes one Flash Search request with URL reading and safe terminal tools, without catalog dependencies", async () => {
  const calls = [];
  const response = await handleDirectSearch(request("What is CR221 capacity?"), env, sequenceFetch([grounded()], calls));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answer, factualText);
  assert.deepEqual(result.sources, [{ title: "OHAUS", url: "https://ohaus.com/test" }]);
  assert.deepEqual(result.citations, [{ start: 0, end: factualText.length, source_index: 0 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].body.model, "gemini-3.8-flash");
  assert.equal(calls[0].body.generation_config.thinking_level, "low");
  assert.equal(calls[0].body.generation_config.tool_choice, "validated");
  assert.equal(calls[0].body.store, false);
  assert.ok(calls[0].body.tools.some((tool) => tool.type === "google_search"));
  assert.ok(calls[0].body.tools.some((tool) => tool.type === "url_context"));
  for (const name of ["request_clarification", "report_unverified"]) {
    assert.ok(calls[0].body.tools.some((tool) => tool.type === "function" && tool.name === name), `missing ${name} tool`);
  }
  assert.doesNotMatch(calls[0].body.input, /VERIFIED CATALOG|workbook|source_file/);
});

test("direct test health advertises the actual independent model configuration", async () => {
  const health = await directSearchHealth(env).json();
  assert.equal(health.model, "gemini-3.8-flash");
  assert.equal(health.thinking, "low");
  assert.equal(health.catalog_used, false);
  assert.equal(health.enabled, true);
});

test("direct test rejects disabled, unauthorized, cross-origin and private requests before egress", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Unexpected egress"); };
  for (const [req, config, status] of [
    [request("What is CR221?"), { ...env, GOOGLE_DIRECT_TEST_ENABLED: "false" }, 404],
    [request("What is CR221?", { headers: { "x-pilot-access-code": "wrong" } }), env, 401],
    [request("What is CR221?", { headers: { origin: "https://other.example" } }), env, 403],
    [request("What is my order status?"), env, 422],
    [request("Show internal calibration customer invoice"), env, 422],
    [request("What about its capacity?", { context: [{ question: "My customer invoice", answer: "private" }] }), env, 422],
  ]) assert.equal((await handleDirectSearch(req, config, fetchImpl)).status, status);
  assert.equal(calls, 0);
});

test("technical internal calibration, battery and weight wording is public, including in history", async () => {
  for (const question of [
    "Does the Explorer have internal calibration?",
    "Does it use an internal rechargeable battery?",
    "How much does the CR221 weigh?",
    "How much weight can the CR221 measure?",
  ]) {
    const calls = [];
    const response = await handleDirectSearch(request(question), env, sequenceFetch([grounded()], calls));
    assert.equal(response.status, 200, question);
    assert.equal(calls.length, 1);
  }
  const calls = [];
  const response = await handleDirectSearch(request("What about the Explorer?", {
    context: [{ question: "Does it have internal calibration?", answer: "It has an internal rechargeable battery." }],
  }), env, sequenceFetch([grounded()], calls));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("a cited final answer does not require Search Suggestion HTML; suggestions are preserved when supplied", async () => {
  const without = await direct(sequenceFetch([grounded({ suggestions: false })]));
  assert.equal(without.answer, factualText);
  assert.deepEqual(without.suggestions, []);
  const withSuggestions = await direct(sequenceFetch([grounded()]));
  assert.deepEqual(withSuggestions.suggestions, ["<div>Search</div>"]);
});

test("only final model output supplies answer text and citations", async () => {
  const earlier = { type: "model_output", content: [{ type: "text", text: "Earlier unsupported answer.", annotations: [{ ...citation, url: "https://earlier.example/wrong" }] }] };
  const payload = { ...grounded({ before: [earlier] }), output_text: "UNTRUSTED TOP LEVEL TEXT", annotations: [{ ...citation, url: "https://outer.example/wrong" }] };
  const result = await direct(sequenceFetch([payload]));
  assert.equal(result.answer, factualText);
  assert.deepEqual(result.sources, [{ title: "OHAUS", url: "https://ohaus.com/test" }]);
  assert.equal(JSON.stringify(result).includes("wrong"), false);
  const missingFinalCitation = grounded({ annotations: [], before: [earlier] });
  const calls = [];
  const notVerified = await direct(sequenceFetch([missingFinalCitation], calls));
  assert.equal(calls.length, 2);
  assert.equal(notVerified.status, "not_verified");
  assert.deepEqual(notVerified.sources, []);
  assert.equal(notVerified.answer.includes(factualText), false);
});

test("incomplete, uncited, and failed-search responses cannot leak factual drafts after the bounded retry", async () => {
  const failedSearch = grounded();
  failedSearch.steps[1].is_error = true;
  for (const payload of [grounded({ status: "incomplete" }), grounded({ annotations: [] }), failedSearch]) {
    const calls = [];
    const response = await handleDirectSearch(request("What is CR221 capacity?"), env, sequenceFetch([payload], calls));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "not_verified");
    assert.equal(calls.length, 2);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.citations, []);
    assert.equal(result.answer.includes(factualText), false);
  }
});

test("ungrounded answer is retried once and a grounded second response is accepted", async () => {
  const calls = [];
  const result = await direct(sequenceFetch([grounded({ annotations: [] }), grounded()], calls));
  assert.equal(calls.length, 2);
  assert.equal(result.answer, factualText);
  assert.equal(result.sources.length, 1);
});

test("a recovered search result is accepted after an earlier search tool failure", async () => {
  const payload = grounded();
  payload.steps.unshift(...searchSteps({ isError: true }));
  const calls = [];
  const result = await direct(sequenceFetch([payload], calls));
  assert.equal(calls.length, 1);
  assert.equal(result.answer, factualText);
});

test("successful URL context can ground a cited answer only for a matching retrieved URL", async () => {
  const payload = grounded();
  payload.steps.splice(0, 2,
    { type: "url_context_call", urls: ["https://ohaus.com/test"] },
    { type: "url_context_result", result: [{ status: "success", url: "https://ohaus.com/test" }] },
  );
  const calls = [];
  const result = await direct(sequenceFetch([payload], calls));
  assert.equal(calls.length, 1);
  assert.equal(result.answer, factualText);
  payload.steps[1].result[0].url = "https://ohaus.com/unrelated";
  const mismatch = await direct(sequenceFetch([payload]));
  assert.equal(mismatch.status, "not_verified");
});

test("citation spans must be integers within final text and citation URLs must be safe HTTPS", async () => {
  const invalid = [
    null,
    { ...citation, start_index: undefined },
    { ...citation, start_index: -1 },
    { ...citation, start_index: 0.5 },
    { ...citation, end_index: factualText.length + 1 },
    { ...citation, end_index: 0 },
    { ...citation, url: "http://ohaus.com/test" },
    { ...citation, url: "https://user:password@ohaus.com/test" },
    { ...citation, url: "javascript:alert(1)" },
  ];
  for (const annotation of invalid) {
    const result = await direct(sequenceFetch([grounded({ annotations: [annotation] })]));
    assert.equal(result.status, "not_verified", JSON.stringify(annotation));
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.citations, []);
  }
});

test("an explicit safe clarification works without search or citations and does not echo freeform model output", async () => {
  const calls = [];
  const payload = { ...terminalTool("request_clarification", { missing: "component" }), output_text: "The thread is definitely M8. UNVERIFIED" };
  const response = await handleDirectSearch(request("What is the Ranger 7000 thread size?"), env, sequenceFetch([payload], calls));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "needs_clarification");
  assert.equal(calls.length, 1);
  assert.match(result.answer, /component|part/i);
  assert.doesNotMatch(result.answer, /M8|UNVERIFIED/);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.citations, []);
});

test("all supported clarification kinds produce safe nonempty prompts", async () => {
  for (const missing of ["component", "exact_model", "model_and_component", "comparison_models", "question"]) {
    const result = await direct(sequenceFetch([terminalTool("request_clarification", { missing })]));
    assert.equal(result.status, "needs_clarification");
    assert.ok(result.answer.length > 0);
    assert.deepEqual(result.sources, []);
  }
});

test("unverified terminal response requires a successful Search and never repeats model-provided guesses", async () => {
  const calls = [];
  const payload = { ...terminalTool("report_unverified", {}, { searched: true }), output_text: "Unverified but it is M8." };
  const result = await direct(sequenceFetch([payload], calls));
  assert.equal(result.status, "not_verified");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(result.answer, /M8/);
  assert.deepEqual(result.sources, []);
  const noSearchCalls = [];
  const noSearch = await direct(sequenceFetch([terminalTool("report_unverified", {})], noSearchCalls));
  assert.equal(noSearchCalls.length, 2);
  assert.equal(noSearch.status, "not_verified");
});

test("unexpected tool names, arguments, status and multiple terminal calls are rejected and retried", async () => {
  const badPayloads = [
    terminalTool("request_clarification", { missing: "invented_kind" }),
    terminalTool("request_clarification", { missing: ["component"] }),
    terminalTool("request_clarification", { missing: "component", answer: "The thread is M8." }),
    terminalTool("report_unverified", { answer: "M8" }, { searched: true }),
    terminalTool("invented_tool", {}),
    terminalTool("request_clarification", { missing: "component" }, { status: "completed" }),
    terminalTool("request_clarification", { missing: "component" }, { extra: [{ type: "function_call", name: "report_unverified", arguments: {} }] }),
  ];
  for (const payload of badPayloads) {
    const calls = [];
    const result = await direct(sequenceFetch([payload, grounded()], calls));
    assert.equal(calls.length, 2, JSON.stringify(payload));
    assert.equal(result.answer, factualText);
  }
});

test("conversation context is retained for reference resolution and bounded to four turns", async () => {
  const context = Array.from({ length: 6 }, (_, index) => ({ question: `Question ${index}`, answer: `Answer ${index}` }));
  const calls = [];
  await direct(sequenceFetch([grounded()], calls), { context });
  assert.doesNotMatch(calls[0].body.input, /Question 0|Question 1/);
  for (const index of [2, 3, 4, 5]) assert.match(calls[0].body.input, new RegExp(`Question ${index}`));
});

test("transient provider errors retry once while provider failures remain explicit errors", async () => {
  const unavailable = Response.json({ error: { status: "UNAVAILABLE", message: "sensitive provider detail" } }, { status: 503 });
  const calls = [];
  const recovered = await direct(sequenceFetch([unavailable, grounded()], calls));
  assert.equal(calls.length, 2);
  assert.equal(recovered.answer, factualText);
  const failures = [];
  const response = await handleDirectSearch(request("What is CR221 capacity?"), env, sequenceFetch([unavailable], failures));
  assert.equal(response.status, 502);
  assert.equal(failures.length, 2);
  const error = await response.json();
  assert.equal(typeof error.code, "string");
  assert.equal(error.answer, undefined);
  assert.doesNotMatch(JSON.stringify(error), /sensitive provider detail|unit-key|unit-code/);
});

test("provider auth, other 4xx, and rate limits do not retry", async () => {
  for (const status of [400, 401, 403, 429]) {
    const calls = [];
    const payload = Response.json({ error: { status: status === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT", message: "provider-only detail" } }, { status });
    const response = await handleDirectSearch(request("What is CR221 capacity?"), env, sequenceFetch([payload], calls));
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.equal(calls.length, 1);
    const body = await response.json();
    assert.equal(typeof body.code, "string");
    assert.doesNotMatch(JSON.stringify(body), /provider-only detail/);
  }
});

test("aborted requests never retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(direct(async (_url, options) => {
    calls++;
    controller.abort();
    options.signal.throwIfAborted();
    throw new Error("Unreachable");
  }, { signal: controller.signal }), (error) => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("diagnostics disclose only response shape, never the question, answer, API key or provider detail", async () => {
  const diagnostics = [];
  await direct(sequenceFetch([grounded({ annotations: [] }), grounded()]), {
    question: "UniquePrivateQuestionMarker",
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.ok(diagnostics.length > 0);
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /UniquePrivateQuestionMarker|The capacity is 220|unit-key|https:\/\/ohaus/);
  for (const event of diagnostics) {
    assert.equal(typeof event, "object");
    assert.ok(!("question" in event));
    assert.ok(!("answer" in event));
    assert.ok(!("apiKey" in event));
    assert.ok(!("input" in event));
  }
});
