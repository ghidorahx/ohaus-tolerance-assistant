import test from "node:test";
import assert from "node:assert/strict";
import { readEvents } from "../lib/sales-stream.mjs";
import worker from "../dist/server/index.js";

const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
function ask(question, host = "localhost") {
  return worker.fetch(new Request(`http://${host}/api/sales`, {
    method: "POST", headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ question }),
  }), env, ctx);
}

test("built streaming endpoint keeps authorization and direct lookup", async () => {
  const secret = process.env.SALES_PILOT_ACCESS_CODE;
  delete process.env.SALES_PILOT_ACCESS_CODE;
  try {
    const denied = await ask("CR221 capacity?", "example.com");
    assert.equal(denied.status, 503);
    assert.match(denied.headers.get("content-type"), /application\/json/);
    const response = await ask("What is the capacity of CR221?");
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = await Array.fromAsync(readEvents(response.body));
    assert.equal(events.at(-1).type, "complete");
    assert.equal(events.at(-1).answer.ai_used, false);
  } finally {
    if (secret !== undefined) process.env.SALES_PILOT_ACCESS_CODE = secret;
  }
});

test("built endpoint delivers Gemini draft before final hydrated sources", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  const encoder = new TextEncoder();
  let finish;
  globalThis.fetch = async (_, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(new ReadableStream({ start(controller) {
      const emit = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      emit({ event_type: "step.start", index: 1, step: { type: "model_output" } });
      emit({ event_type: "step.delta", index: 1, delta: { type: "text", text: '{"answer":"CR221 capacity is 220 g.' } });
      finish = () => {
        emit({ event_type: "step.delta", index: 1, delta: { type: "text", text: '","materials":["30428204"],"evidence":[{"material_number":"30428204","field":"specifications.maximum_capacity"}]}' } });
        emit({ event_type: "interaction.completed", interaction: { status: "completed" } });
        controller.close();
      };
    } }));
  };
  try {
    const response = await ask("Explain CR221 capacity");
    const events = readEvents(response.body);
    assert.equal((await events.next()).value.type, "status");
    assert.equal((await events.next()).value.text, "CR221 capacity is 220 g.");
    finish();
    const final = (await events.next()).value;
    assert.equal(final.type, "complete");
    assert.equal(final.answer.evidence[0].value, "220 g");
    await events.return();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});
