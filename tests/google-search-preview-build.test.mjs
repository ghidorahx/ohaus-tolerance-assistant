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

test("preview automatically queues one grounded Google Search after a public catalog miss", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  const encoder = new TextEncoder();
  const webText = "OHAUS was founded in the United States in 1907.";
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (!body.tools) {
      return Response.json({
        id: "catalog-public-miss",
        status: "completed",
        model: "gemini-3.8-flash",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(structuredAnswer("This public fact is not available in the loaded catalog. CATALOG-ABSTENTION-SENTINEL", {
            status: "not_in_source",
            confidence: "low",
            context_summary: "CATALOG-CONTEXT-SENTINEL",
          })) }],
        }],
      });
    }
    const events = [
      { event_type: "step.start", index: 0, step: { type: "google_search_call", id: "search-auto", arguments: { queries: ["OHAUS founded"] } } },
      { event_type: "step.start", index: 1, step: { type: "google_search_result", call_id: "search-auto", is_error: false, result: [{ search_suggestions: searchSuggestion }] } },
      { event_type: "step.start", index: 2, step: { type: "model_output" } },
      { event_type: "step.delta", index: 2, delta: { type: "text", text: webText } },
      {
        event_type: "step.delta",
        index: 2,
        delta: {
          type: "text_annotation_delta",
          annotations: [{ type: "url_citation", url: "https://us.ohaus.com/about-us", title: "About OHAUS" }],
        },
      },
      { event_type: "interaction.completed", interaction: { id: "web-auto", status: "completed", model: "gemini-3.8-flash" } },
    ];
    return new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }));
  };

  try {
    const response = await requestPreview("Who founded OHAUS?", {}, [{
      question: "RAW-HISTORY-SENTINEL",
      answer: "RAW-ANSWER-SENTINEL",
    }]);
    const events = await Array.fromAsync(readEvents(response.body));
    const final = events.at(-1);
    assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["status", "status"]);
    assert.equal(events[0].message, "Searching catalog");
    assert.match(events[1].message, /searching Google/i);
    assert.equal(final.type, "complete");
    assert.equal(requests.length, 2);
    assert.equal("tools" in requests[0], false);
    assert.deepEqual(requests[1].tools, [{ type: "google_search" }]);
    assert.doesNotMatch(requests[1].input, /RAW-HISTORY-SENTINEL|RAW-ANSWER-SENTINEL/);
    assert.doesNotMatch(requests[1].input, /CATALOG-ABSTENTION-SENTINEL|CATALOG-CONTEXT-SENTINEL/);
    assert.doesNotMatch(requests[1].input, /Who founded OHAUS\?/i);
    assert.match(requests[1].input, /official public information for OHAUS about: company founding and history/i);
    assert.equal(final.answer.answer, webText);
    assert.equal(final.answer.grounding_mode, "google_search_fallback");
    assert.equal(final.answer.fallback_used, true);
    assert.equal(final.answer.web_search_used, true);
    assert.equal(final.experiment.routing, "catalog_miss_auto_search");
    assert.deepEqual(final.answer.search_suggestions, [searchSuggestion]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("automatic Google failure preserves the original catalog abstention", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  const catalogText = "The requested public company fact is not available in the loaded catalog.";
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (!body.tools) {
      return Response.json({
        id: "catalog-public-miss-failure",
        status: "completed",
        model: "gemini-3.8-flash",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(structuredAnswer(catalogText, {
            status: "not_in_source",
            confidence: "low",
          })) }],
        }],
      });
    }
    return Response.json({
      id: "web-uncited",
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [
        { type: "google_search_call", id: "search-1" },
        { type: "google_search_result", call_id: "search-1", is_error: false },
        { type: "model_output", content: [{ type: "text", text: "Uncited web draft must not escape." }] },
      ],
    });
  };

  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question: "Who founded OHAUS?" }),
    }), env, ctx);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.equal(payload.answer.answer, catalogText);
    assert.equal(payload.answer.web_search_used, undefined);
    assert.equal(payload.answer.web_answer, undefined);
    assert.equal(payload.experiment.fallback_attempted, true);
    assert.equal(payload.experiment.fallback_used, false);
    assert.equal(payload.experiment.routing, "catalog_fallback_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("streamed automatic failure emits no web draft and completes with the catalog abstention", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const catalogText = "The public company fact is not available in the loaded catalog.";
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (!init?.body) {
      requests.push({ url, body: null });
      return Response.json({
        id: "web-auto-uncited",
        status: "completed",
        model: "gemini-3.8-flash",
        steps: [
          { type: "google_search_call", id: "search-auto" },
          { type: "google_search_result", call_id: "search-auto", is_error: false, result: [{ search_suggestions: searchSuggestion }] },
          { type: "model_output", content: [{ type: "text", text: "UNCITED-WEB-DRAFT" }] },
        ],
      });
    }
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (!body.tools) {
      return Response.json({
        id: "catalog-streamed-fallback",
        status: "completed",
        model: "gemini-3.8-flash",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(structuredAnswer(catalogText, {
            status: "not_in_source",
            confidence: "low",
          })) }],
        }],
      });
    }
    const providerEvents = [
      { event_type: "step.start", index: 0, step: { type: "google_search_call", id: "search-auto" } },
      { event_type: "step.start", index: 1, step: { type: "google_search_result", call_id: "search-auto", is_error: false, result: [{ search_suggestions: searchSuggestion }] } },
      { event_type: "step.start", index: 2, step: { type: "model_output" } },
      { event_type: "step.delta", index: 2, delta: { type: "text", text: "UNCITED-WEB-DRAFT" } },
      { event_type: "interaction.completed", interaction: { id: "web-auto-uncited", status: "completed", model: "gemini-3.8-flash" } },
    ];
    return new Response(providerEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  };

  try {
    const response = await requestPreview("Who founded OHAUS?");
    const events = await Array.fromAsync(readEvents(response.body));
    assert.deepEqual(events.map((event) => event.type), ["status", "status", "complete"]);
    assert.equal(events.some((event) => event.type === "draft"), false);
    assert.equal(events.at(-1).answer.answer, catalogText);
    assert.equal(events.at(-1).answer.web_search_used, undefined);
    assert.equal(events.at(-1).experiment.routing, "catalog_fallback_unavailable");
    assert.equal(requests.filter((entry) => entry.body?.tools).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("preview grounds every requested public field for one catalog-resolved model", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  const webText = "The public OHAUS warranty page describes the applicable warranty terms.";
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (!body.tools) {
      return Response.json({
        id: "catalog-product-gap",
        status: "completed",
        model: "gemini-3.8-flash",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(structuredAnswer("The requested specification is not available in the loaded catalog. MODEL-GAP-SENTINEL", {
            status: "not_in_source",
            confidence: "medium",
            intent: "lookup",
            materials: ["30428204"],
            answer_items: [{ identifier: "30428204", label: "CR221", description: "Catalog-resolved model" }],
            unresolved_items: ["CR221: warranty"],
            context_summary: "MODEL-CONTEXT-SENTINEL",
          })) }],
        }],
      });
    }
    return Response.json({
      id: "web-product-gap",
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [
        { type: "google_search_call", id: "search-product", arguments: { queries: ["CR221 warranty"] } },
        { type: "google_search_result", call_id: "search-product", is_error: false, result: [{ search_suggestions: searchSuggestion }] },
        {
          type: "model_output",
          content: [{
            type: "text",
            text: webText,
            annotations: [{ type: "url_citation", url: "https://us.ohaus.com/warranty", title: "OHAUS warranty" }],
          }],
        },
      ],
    });
  };

  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question: "What are the public battery life, dimensions, warranty, and recall details for CR221?" }),
    }), env, ctx);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.match(requests[1].input, /30428204/);
    assert.doesNotMatch(requests[1].input, /MODEL-GAP-SENTINEL|MODEL-CONTEXT-SENTINEL/);
    assert.doesNotMatch(requests[1].input, /What are the public battery life, dimensions, warranty, and recall details for CR221\?/i);
    assert.match(requests[1].input, /official public information for OHAUS material 30428204 about: public warranty policy and terms; current recalls and safety notices; battery runtime and expected operating time; overall physical dimensions/i);
    assert.doesNotMatch(requests[1].input, /CR221/i);
    assert.equal(payload.answer.answer, webText);
    assert.deepEqual(payload.answer.materials, ["30428204"]);
    assert.deepEqual(payload.answer.answer_items, []);
    assert.equal(payload.answer.grounding_mode, "google_search_fallback");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("auto-enabled preview never searches after a non-abstaining catalog result", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  let nextStatus = "answered";
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: `catalog-${nextStatus}`,
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [{
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(structuredAnswer(`Catalog result: ${nextStatus}.`, {
          status: nextStatus,
          confidence: "high",
          intent: nextStatus === "answered" ? "catalog_scope" : "unsupported",
          escalation_reason: nextStatus === "escalate" ? "Review required." : null,
        })) }],
      }],
    });
  };

  try {
    for (const status of ["answered", "needs_clarification", "escalate"]) {
      nextStatus = status;
      const before = requests.length;
      const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ question: "Tell me about OHAUS company history." }),
      }), env, ctx);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(requests.length, before + 1, status);
      assert.equal("tools" in requests.at(-1), false, status);
      assert.equal(payload.answer.status, status);
      assert.equal(payload.answer.web_search_used, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("automatic fallback flag can be disabled without disabling explicit Google Search", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: "catalog-auto-disabled",
      status: "completed",
      model: "gemini-3.8-flash",
      steps: [{
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(structuredAnswer("Catalog only.", {
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
      body: JSON.stringify({ question: "Who founded OHAUS?" }),
    }), env, ctx);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(payload.answer.web_search_used, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("authenticated preview applies the per-request master gate to legacy fallback answers", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.SALES_PILOT_ACCESS_CODE = "preview-test-code";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  const requests = [];
  globalThis.fetch = async (...args) => {
    requests.push(args);
    throw new Error("No provider request is allowed after the simulated master-catalog outage.");
  };

  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-pilot-access-code": "preview-test-code",
        "cf-connecting-ip": "203.0.113.40",
      },
      body: JSON.stringify({ question: "What is the IP rating for CR221?" }),
    }), env, ctx);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.catalog.retrieval_status, "ready");
    assert.equal(payload.catalog.portable_products, 80);
    assert.equal(payload.answer.retrieval_strategy, "exact_local");
    assert.equal(requests.length, 0);
    assert.equal(payload.answer.web_search_used, undefined);
    assert.equal(payload.experiment.google_search, false);
    assert.equal(payload.experiment.routing, "catalog_request_unverified");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("catalog provider failures never trigger a Google Search pass", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  delete process.env.SALES_PILOT_ACCESS_CODE;
  const requests = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({ error: { message: "Catalog provider unavailable." } }, { status: 500 });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question: "Who founded OHAUS?" }),
    }), env, ctx);
    assert.equal(response.status, 502);
    assert.equal(requests.length, 1);
    assert.equal("tools" in requests[0], false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});

test("preview rejects cross-origin and unauthenticated requests before any Google egress", async () => {
  const originalFetch = globalThis.fetch;
  const originalCode = process.env.SALES_PILOT_ACCESS_CODE;
  const originalSearchFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const originalAutoFlag = process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
  process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = "true";
  process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = "true";
  process.env.SALES_PILOT_ACCESS_CODE = "expected-test-code";
  const requests = [];
  globalThis.fetch = async (...args) => {
    requests.push(args);
    throw new Error("No provider request expected.");
  };
  try {
    const crossOrigin = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ question: "Search Google for the latest NIST guidance." }),
    }), env, ctx);
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error, "Cross-origin requests are not allowed.");

    const unauthenticated = await worker.fetch(new Request("http://localhost/api/ask-test", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question: "Who founded OHAUS?" }),
    }), env, ctx);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, "access_code_required");
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCode === undefined) delete process.env.SALES_PILOT_ACCESS_CODE;
    else process.env.SALES_PILOT_ACCESS_CODE = originalCode;
    if (originalSearchFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalSearchFlag;
    if (originalAutoFlag === undefined) delete process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED;
    else process.env.GOOGLE_SEARCH_AUTO_FALLBACK_ENABLED = originalAutoFlag;
  }
});
