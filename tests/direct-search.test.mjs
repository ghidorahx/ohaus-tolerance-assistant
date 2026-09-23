import test from "node:test";
import assert from "node:assert/strict";
import { handleDirectSearch } from "../lib/direct-search-handler.mjs";
const env = { GOOGLE_DIRECT_TEST_ENABLED: "true", SALES_PILOT_ACCESS_CODE: "unit-code", GEMINI_API_KEY: "unit-key" };
function request(question, extras = {}) {
  return new Request("https://preview.example/api/google-direct", { method: "POST", headers: { "content-type": "application/json", "x-pilot-access-code": "unit-code", ...extras.headers }, body: JSON.stringify({ question, context: extras.context ?? [] }) });
}
const grounded = {
  status: "completed", output_text: "The capacity is 220 g.", steps: [
    { type: "google_search_call" },
    { type: "google_search_result", result: [{ search_suggestions: "<div>Search</div>" }] },
    { type: "model_output", content: [{ type: "text", annotations: [{ type: "url_citation", url: "https://ohaus.com/test", title: "OHAUS" }] }] },
  ],
};
test("direct test makes one Flash-Lite minimal Search request without catalog dependencies", async () => {
  const calls = [];
  const response = await handleDirectSearch(request("What is CR221 capacity?"), env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(grounded);
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.sources.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].body.model, "gemini-3.5-flash-lite");
  assert.equal(calls[0].body.generation_config.thinking_level, "minimal");
  assert.equal(calls[0].body.store, false);
  assert.deepEqual(calls[0].body.tools, [{ type: "google_search" }]);
  assert.doesNotMatch(calls[0].body.input, /VERIFIED CATALOG|workbook|source_file/);
});
test("direct test rejects disabled, unauthorized, cross-origin and private requests before egress", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Unexpected egress"); };
  for (const [req, config, status] of [
    [request("What is CR221?"), { ...env, GOOGLE_DIRECT_TEST_ENABLED: "false" }, 404],
    [request("What is CR221?", { headers: { "x-pilot-access-code": "wrong" } }), env, 401],
    [request("What is CR221?", { headers: { origin: "https://other.example" } }), env, 403],
    [request("What is my order status?"), env, 422],
    [request("What about its capacity?", { context: [{ question: "My customer invoice", answer: "private" }] }), env, 422],
  ]) assert.equal((await handleDirectSearch(req, config, fetchImpl)).status, status);
  assert.equal(calls, 0);
});
test("direct test refuses incomplete or uncited model responses", async () => {
  for (const payload of [{ ...grounded, status: "incomplete" }, { status: "completed", output_text: "Guess", steps: [] }]) {
    const response = await handleDirectSearch(request("What is CR221?"), env, async () => Response.json(payload));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).answer, undefined);
  }
});
