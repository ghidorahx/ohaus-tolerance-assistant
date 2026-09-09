import assert from "node:assert/strict";
import test from "node:test";

import { readEvents } from "../lib/sales-stream.mjs";
import worker from "../dist/server/index.js";

const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const searchSuggestion = '<div class="google-search-suggestion"><a href="https://www.google.com/search?q=nist">Search on Google</a></div>';

function requestPreview(question, headers = {}, context = undefined) {
  return worker.fetch(new Request("http://localhost/api/ask-test", {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ question, ...(context ? { context } : {}) }),
  }), env, ctx);
}

function structuredAnswer(answer, extras = {}) {
  return {
    answer,
    answer_items: [],
    status: "answered",
    confidence: "high",
    intent: "unsupported",
    materials: [],
    evidence: [],
    unresolved_items: [],
    follow_up_suggestions: [],
    context_summary: answer,
    escalation_reason: null,
    ...extras,
  };
}

test("preview delegates ordinary catalog questions to the unchanged route", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SALES_PILOT_ACCESS_CODE;
  try {
    const response = await requestPreview("What is the capacity of CR221?");
    const events = await Array.fromAsync(readEvents(response.body));
    const final = events.at(-1);
    assert.equal(final.type, "complete");
    assert.equal(final.answer.ai_used, false);
    assert.equal(final.answer.web_search_used, undefined);
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
  }
});

test("preview Google Search is disabled unless the dedicated Worker flag is enabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const requests = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: "catalog-only",
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [{
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(structuredAnswer("Not available in the loaded catalog.", {
          status: "not_in_source",
          confidence: "low",
        })) }],
      }],
    });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question: "Search Google for the latest NIST guidance." }),
    }), env, ctx);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal("tools" in requests[0], false);
    assert.equal(payload.answer.web_search_used, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
  }
});

test("preview uses Gemini 3.8 Search only after a verified catalog pass", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  const encoder = new TextEncoder();
  const finalText = "Current public recall information is summarized from the cited source.";
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (!body.tools) {
      return Response.json({
        id: "catalog-pass",
        status: "completed",
        model: "gemini-3.8-flash",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(structuredAnswer("CR221 is verified in the loaded catalog; current public recall information is not a catalog field.", {
            status: "not_in_source",
            confidence: "high",
            materials: ["30428204"],
            answer_items: [{ identifier: "30428204", label: "CR221", description: "Verified catalog model" }],
            unresolved_items: ["public recall information"],
          })) }],
        }],
      });
    }

    const events = [
      { event_type: "step.start", index: 0, step: { type: "google_search_call", id: "search-1", arguments: { queries: ["CR221 recall"] } } },
      { event_type: "step.start", index: 1, step: { type: "google_search_result", call_id: "search-1", is_error: false, result: [{ search_suggestions: searchSuggestion }] } },
      { event_type: "step.start", index: 2, step: { type: "model_output" } },
      { event_type: "step.delta", index: 2, delta: { type: "text", text: finalText } },
      {
        event_type: "step.delta",
        index: 2,
        delta: {
          type: "text_annotation_delta",
          annotations: [{
            type: "url_citation",
            url: "https://www.cpsc.gov/Recalls",
            title: "CPSC recalls",
            start_index: 0,
            end_index: 24,
          }],
        },
      },
      { event_type: "interaction.completed", interaction: { id: "web-pass", status: "completed", model: "gemini-3.8-flash" } },
    ];
    return new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }));
  };

  try {
    const response = await requestPreview("Search Google for the latest public recall information affecting CR221.");
    const events = await Array.fromAsync(readEvents(response.body));
    const final = events.at(-1);
    assert.equal(final.type, "complete");
    assert.equal(requests.length, 2);
    assert.equal("tools" in requests[0], false);
    assert.equal(requests[1].model, "gemini-3.8-flash");
    assert.deepEqual(requests[1].tools, [{ type: "google_search" }]);
    assert.equal(final.answer.web_search_used, true);
    assert.equal(final.experiment.routing, "catalog_plus_web");
    assert.equal(final.answer.answer, "CR221 is verified in the loaded catalog; current public recall information is not a catalog field.");
    assert.equal(final.answer.web_answer, finalText);
    assert.deepEqual(final.answer.materials, ["30428204"]);
    assert.deepEqual(final.answer.web_sources, [{
      title: "CPSC recalls",
      url: "https://www.cpsc.gov/Recalls",
    }]);
    assert.deepEqual(final.answer.search_suggestions, [searchSuggestion]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
  }
});

test("preview blocks context-dependent private commercial follow-ups from Google Search", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: "catalog-private-context",
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [{
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(structuredAnswer("Private commercial data is not in the catalog.", {
          status: "not_in_source",
          confidence: "low",
        })) }],
      }],
    });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        question: "Search Google.",
        context: [
          { question: "What is the customer pricing and lead time for CR221?", answer: "Not available in the loaded catalog." },
          { question: "What is its capacity?", answer: "220 g." },
          { question: "Does it use batteries?", answer: "Yes." },
          { question: "What does it weigh?", answer: "The catalog lists a net weight." },
        ],
      }),
    }), env, ctx);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal("tools" in requests[0], false);
    assert.equal(payload.answer.web_search_used, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
  }
});

test("preview refuses hybrid web augmentation when catalog identity is unresolved", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: "catalog-unresolved",
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [{
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(structuredAnswer("I could not verify that model in the catalog.", {
          status: "needs_clarification",
          confidence: "low",
          unresolved_items: ["CR221"],
        })) }],
      }],
    });
  };
  try {
    const response = await requestPreview("Search Google for the latest recall affecting CR221.");
    const events = await Array.fromAsync(readEvents(response.body));
    const final = events.at(-1);
    assert.equal(final.type, "complete");
    assert.equal(requests.length, 1);
    assert.equal("tools" in requests[0], false);
    assert.equal(final.experiment.routing, "catalog_identity_unresolved");
    assert.equal(final.answer.web_search_used, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
  }
});

test("preview preserves same-origin protection", async () => {
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ question: "Search Google for the latest NIST guidance." }),
    }), env, ctx);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Cross-origin requests are not allowed.");
  } finally {
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
  }
});
