import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function fetchBuiltWorker(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "application/json" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function postBuiltWorker(pathname, body) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}-post`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the OHAUS assistant shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>OHAUS Support Assistants<\/title>/i);
  assert.match(html, /Tolerance Assistant/);
  assert.match(html, /Ask a tolerance question/);
  assert.match(html, /Pilot owner · T\. Delacruz/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("packages the structured knowledge base", async () => {
  const path = new URL("../public/data/ohaus-knowledge.json", import.meta.url);
  await access(path);
  const knowledge = JSON.parse(await readFile(path, "utf8"));
  assert.equal(knowledge.meta.currentRecords, 435);
  assert.equal(knowledge.meta.legacyRecords, 311);
  assert.equal(knowledge.current.length + knowledge.legacy.length, 746);
});

test("packages the workbook-grounded Ask endpoint and focused context policy", async () => {
  const response = await fetchBuiltWorker("/api/sales");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model, "gpt-5.6-sol");
  assert.equal(payload.fallback_model, "gpt-5.6-terra");
  assert.equal(payload.reasoning_effort, "medium");
  assert.equal(payload.reasoning_mode, "standard");
  assert.equal(payload.service_tier, "fast");
  assert.deepEqual(payload.answer_routing, {
    deterministic_fast_lane: true,
    phrase_normalization: true,
    ai_fallback: true,
  });
  assert.equal(payload.default_reasoning_profile, undefined);
  assert.equal(payload.reasoning_profiles, undefined);
  assert.equal(payload.context.max_verified_turns, 12);
  assert.equal(payload.context.approximate_character_budget, 162_000);
  assert.equal(payload.context.max_retrieval_documents, 16);
  assert.equal(payload.context.max_total_request_tokens, 66_000);
  assert.equal(payload.context.max_input_tokens, 54_000);
  assert.equal(payload.context.max_output_tokens, 12_000);
  assert.equal(payload.catalog.portable_products, 80);
  assert.equal(payload.catalog.api_records, 171);
  assert.equal(payload.catalog.retrieval_documents, 87);
  assert.equal(payload.catalog.retrieval_status, "ready");
  assert.equal(payload.vectorize.configured, false);
  assert.equal(payload.vectorize.index, "ohaus-sales-catalog-v1");
  assert.equal(payload.vectorize.source_documents, 87);
  assert.ok(payload.vectorize.vector_records > payload.vectorize.source_documents);
});

test("answers a high-confidence Excel lookup directly without an OpenAI call", async () => {
  const response = await postBuiltWorker("/api/sales", {
    question: "How much can CR221 weigh, and what is the smallest weight it can show?",
    context: [],
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.answer.answer_engine, "catalog_fast_lane");
  assert.equal(payload.answer.ai_used, false);
  assert.equal(payload.answer.model, "Direct Excel lookup");
  assert.equal(payload.answer.reasoning_effort, "none");
  assert.equal(payload.answer.timing.generation_ms, 0);
  assert.match(payload.answer.answer_items[0].description, /Maximum capacity: 220 g/);
  assert.match(payload.answer.answer_items[0].description, /Readability: 0\.1 g/);
});

test("keeps Medium plus Fast for AI fallback and hydrates legacy evidence with the correct catalog", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.openai.com")) return previousFetch(url, init);
    requests.push(JSON.parse(init.body));
    return Response.json({
      id: "resp-built-worker",
      service_tier: "priority",
      output_text: JSON.stringify({
        answer: "CR221 has a maximum capacity of 220 g.",
        answer_items: [
          { identifier: "30428204", label: "CR221", description: "Maximum capacity: 220 g" },
          { identifier: "99999999", label: "Invented", description: "Must be removed" },
        ],
        status: "answered",
        confidence: "high",
        intent: "lookup",
        materials: ["30428204", "99999999"],
        evidence: [
          { material_number: "30428204", field: "specifications.maximum_capacity" },
          { material_number: "99999999", field: "specifications.maximum_capacity" },
        ],
        unresolved_items: [],
        follow_up_suggestions: [],
        context_summary: "The user asked about CR221.",
        escalation_reason: null,
      }),
      output: [],
    });
  };

  try {
    const response = await postBuiltWorker("/api/sales", { question: "Explain CR221 capacity", context: [] });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning.effort, "medium");
    assert.equal(requests[0].service_tier, "fast");
    assert.equal(payload.answer.answer_engine, "ai");
    assert.deepEqual(payload.answer.evidence.map((item) => [item.material_number, item.value]), [["30428204", "220 g"]]);
    assert.deepEqual(payload.answer.answer_items.map((item) => item.identifier), ["30428204"]);
    assert.deepEqual(payload.answer.materials, ["30428204"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("deploys the built Worker and its matching hashed assets together", async () => {
  const config = await readFile(new URL("../wrangler.deploy.jsonc", import.meta.url), "utf8");
  assert.match(config, /"main":\s*"\.\/dist\/server\/index\.js"/);
  assert.match(config, /"directory":\s*"\.\/dist\/client"/);
  assert.match(config, /"binding":\s*"ASSETS"/);
  assert.doesNotMatch(config, /worker-wrapper\.js/);
});
