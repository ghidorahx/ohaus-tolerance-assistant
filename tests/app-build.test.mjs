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

test("server renders the OHAUS assistant shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>OHAUS Tolerance Assistant<\/title>/i);
  assert.match(html, /Tolerance Assistant/);
  assert.match(html, /Ask a tolerance question/);
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
