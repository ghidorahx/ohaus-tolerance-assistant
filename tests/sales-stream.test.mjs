import test from "node:test";
import assert from "node:assert/strict";
import { readEvents, answerPrefix, salesStreamResponse } from "../lib/sales-stream.mjs";
import { answerSalesQuestionWithGemini } from "../lib/gemini-sales-agent.mjs";

test("SSE handles byte boundaries, UTF-8 and CRLF", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"café"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.deepEqual(await Array.fromAsync(readEvents(stream)), [{ text: "café" }]);
});

test("draft extraction decodes escapes and never leaks other JSON fields", () => {
  assert.equal(answerPrefix('{"answer":"Hello\\nworld\\u00'), "Hello\nworld");
  assert.equal(answerPrefix('{"answer":"Hello\\u00e9\\"!","secret":"hidden"}'), 'Helloé"!');
  assert.equal(answerPrefix('{"nested":{"answer":"hidden"}}'), "");
  assert.equal(answerPrefix('{"answer":"x\\ud83d'), "x");
});

test("draft arrives before completion, final response and status survive", async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const response = salesStreamResponse(async (draft) => {
    draft("Hello");
    await gate;
    draft("Hello world");
    return Response.json({ answer: { answer: "Hello world", evidence: [] } });
  }, new AbortController().signal);
  const events = readEvents(response.body);
  assert.equal((await events.next()).value.type, "status");
  assert.deepEqual((await events.next()).value, { type: "draft", text: "Hello" });
  finish();
  assert.deepEqual((await events.next()).value, { type: "draft", text: " world" });
  assert.equal((await events.next()).value.type, "complete");
  await events.return();
});

test("stream preserves rate-limit errors and cancellation", async () => {
  const response = salesStreamResponse(async () => Response.json({ error: "Wait", retry_after_seconds: 3 }, { status: 429 }), new AbortController().signal);
  const events = await Array.fromAsync(readEvents(response.body));
  assert.equal(events.at(-1).status, 429);
  assert.equal(events.at(-1).type, "error");
  let upstream;
  const cancelled = salesStreamResponse(async (_, signal) => {
    upstream = signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return Response.json({});
  }, new AbortController().signal);
  await cancelled.body.cancel();
  assert.equal(upstream.aborted, true);
});

test("Gemini streams only model output and requires terminal completion", async () => {
  const raw = JSON.stringify({ answer: "Capacity 220 g", materials: [], evidence: [], answer_items: [] });
  const events = [
    { event_type: "step.start", index: 0, step: { type: "thought" } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: "private" } },
    { event_type: "step.start", index: 1, step: { type: "model_output" } },
    ...[raw.slice(0, 20), raw.slice(20)].map((text) => ({ event_type: "step.delta", index: 1, delta: { type: "text", text } })),
  ];
  const drafts = [];
  const options = {
    question: "Capacity?", apiKey: "test", groundingBundle: {}, onDraft: (text) => drafts.push(text),
    fetchImpl: async (_, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    },
  };
  await assert.rejects(answerSalesQuestionWithGemini(options), /without a complete/);
  events.push({ event_type: "interaction.completed", interaction: { status: "completed", model: "test" } });
  const result = await answerSalesQuestionWithGemini(options);
  assert.equal(result.answer, "Capacity 220 g");
  assert.equal(drafts.at(-1), result.answer);
  assert.ok(drafts.every((text) => !text.includes("private")));
});
