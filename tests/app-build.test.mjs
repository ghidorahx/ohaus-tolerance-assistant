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

test("packages the workbook-grounded AI sales endpoint and extended context policy", async () => {
  const response = await fetchBuiltWorker("/api/sales");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model, "gpt-5.6-sol");
  assert.equal(payload.fallback_model, "gpt-5.6-terra");
  assert.equal(payload.reasoning_effort, "medium");
  assert.equal(payload.reasoning_mode, "standard");
  assert.equal(payload.default_reasoning_profile, undefined);
  assert.equal(payload.reasoning_profiles, undefined);
  assert.equal(payload.context.max_verified_turns, 120);
  assert.equal(payload.context.approximate_character_budget, 966_000);
  assert.equal(payload.context.max_retrieval_documents, 20);
  assert.equal(payload.context.max_total_request_tokens, 450_000);
  assert.equal(payload.context.max_input_tokens, 322_000);
  assert.equal(payload.context.max_output_tokens, 128_000);
  assert.equal(payload.catalog.portable_products, 80);
  assert.equal(payload.catalog.api_records, 171);
  assert.equal(payload.catalog.retrieval_documents, 87);
  assert.equal(payload.catalog.retrieval_status, "ready");
});
