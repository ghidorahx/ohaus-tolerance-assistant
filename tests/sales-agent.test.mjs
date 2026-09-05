import assert from "node:assert/strict";
import test from "node:test";
import {
  answerSalesQuestionWithAI,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODE,
  DEFAULT_SERVICE_TIER,
  outputTokenLimitForQuestion,
} from "../lib/sales-agent.mjs";

test("uses one low-reasoning GPT-5.6 Fast mode Responses call with comprehensive workbook grounding", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      id: "resp-final",
      service_tier: "priority",
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
  assert.equal(DEFAULT_REASONING_EFFORT, "low");
  assert.equal(DEFAULT_REASONING_MODE, "standard");
  assert.equal(DEFAULT_SERVICE_TIER, "fast");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-5.6-sol");
  assert.deepEqual(requests[0].reasoning, { effort: "low", mode: "standard", context: "current_turn" });
  assert.equal(requests[0].service_tier, "fast");
  assert.equal(requests[0].max_output_tokens, 2_400);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].prompt_cache_key, "ohaus-ask-master-catalog-v1");
  assert.deepEqual(requests[0].prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.equal(requests[0].text.verbosity, "low");
  assert.equal(requests[0].tools, undefined);
  assert.equal(requests[0].text.format.strict, true);
  assert.match(JSON.stringify(requests[0].input), /RECENT VERIFIED CONVERSATION CONTEXT/);
  assert.match(JSON.stringify(requests[0].input), /sales-grounding-v9-vectorize/);
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
  assert.equal(result.answer_engine, "ai");
  assert.equal(result.ai_used, true);
  assert.equal(result.grounding_products, 80);
  assert.equal(result.fallback_used, false);
  assert.equal(result.service_tier, "priority");
  assert.equal(result.service_tier_requested, "fast");
  assert.equal(result.output_token_cap, 2_400);
  assert.equal(result.output_cap_reduced, true);
  assert.equal(result.retrieval_strategy, "local_fallback");
  assert.equal(result.vectorize_status, "not_configured");
  assert.equal(result.retrieval_documents_sent, 8);
});

test("retains only the twelve most recent compact verified turns", async () => {
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
  assert.doesNotMatch(input, /Verified context marker 112\b/);
  assert.match(input, /Verified context marker 113\b/);
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
      service_tier: "priority",
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
  assert.deepEqual(requests.map((request) => request.service_tier), ["fast", "fast"]);
  assert.deepEqual(requests.map((request) => request.max_output_tokens), [2_400, 2_400]);
  assert.equal(result.model, "gpt-5.6-terra");
  assert.equal(result.primary_model, "gpt-5.6-sol");
  assert.equal(result.fallback_used, true);
  assert.equal(result.service_tier, "priority");
  assert.equal(result.service_tier_requested, "fast");
  assert.equal(result.output_token_cap, 2_400);
  assert.equal(result.output_cap_reduced, true);

  const retry = await answerSalesQuestionWithAI({
    question: "Is current pricing in the catalog?",
    apiKey: "test-key",
    fetchImpl,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].model, "gpt-5.6-terra");
  assert.equal(retry.fallback_used, true);
});

test("uses intent-sized output budgets", () => {
  assert.equal(outputTokenLimitForQuestion("What is CR221's capacity?"), 2_400);
  assert.equal(outputTokenLimitForQuestion("Compare CR221 and CR5200"), 4_000);
  assert.equal(outputTokenLimitForQuestion("Which models are compatible with this accessory?"), 8_000);
  assert.equal(outputTokenLimitForQuestion("Which models fit this part?"), 8_000);
  assert.equal(outputTokenLimitForQuestion("What models work with this part?"), 8_000);
  assert.equal(outputTokenLimitForQuestion("Give me every detail in the complete record"), 12_000);
});

test("retries a truncated compatibility list at the expanded ceiling and preserves every grounded item", async () => {
  const requests = [];
  const identifiers = Array.from({ length: 47 }, (_, index) => String(91000000 + index));
  const answerItems = identifiers.map((identifier, index) => ({
    identifier,
    label: `MODEL${index + 1}`,
    description: "Compatible model listed in the Excel catalog",
  }));
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) {
      return Response.json({
        id: "resp-incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      });
    }
    return Response.json({
      id: "resp-complete",
      status: "completed",
      output_text: JSON.stringify({
        answer: "47 compatible models are listed.",
        answer_items: answerItems,
        status: "answered",
        confidence: "high",
        intent: "relationship",
        materials: identifiers,
        evidence: [],
        unresolved_items: [],
        follow_up_suggestions: [],
        context_summary: "The compatible-model list contains 47 grounded materials.",
        escalation_reason: null,
      }),
      output: [],
    });
  };

  const result = await answerSalesQuestionWithAI({
    question: "What models work with this accessory?",
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    fallbackModel: "gpt-5.6-terra",
    groundingBundle: {
      catalog_scope: { materials: 47 },
      allowed_material_numbers: identifiers,
    },
    fetchImpl,
  });

  assert.deepEqual(requests.map((request) => request.max_output_tokens), [8_000, 12_000]);
  assert.equal(requests[0].text.format.schema.properties.answer_items.maxItems, 80);
  assert.equal(requests[0].text.format.schema.properties.materials.maxItems, 96);
  assert.equal(result.answer_items.length, 47);
  assert.equal(result.materials.length, 47);
  assert.equal(result.output_token_cap, 12_000);
  assert.equal(result.output_cap_reduced, false);
});

test("fills a completed legacy AI response with every grounded compatible model", async () => {
  const sourceMaterial = "30268982";
  const identifiers = Array.from({ length: 47 }, (_, index) => String(92000000 + index));
  const relationships = identifiers.map((identifier, index) => ({
    direction: "inbound",
    relationship_type: "accessories",
    related_material_number: identifier,
    resolution_status: "resolved",
    related_item: { model: `MODEL${index + 1}` },
  }));
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return Response.json({
      id: "resp-partial-legacy",
      status: "completed",
      output_text: JSON.stringify({
        answer: "Here are 24 compatible models.",
        answer_items: identifiers.slice(0, 24).map((identifier, index) => ({
          identifier,
          label: `MODEL${index + 1}`,
          description: "Compatible model listed in the Excel catalog",
        })),
        status: "answered",
        confidence: "high",
        intent: "relationship",
        materials: [sourceMaterial, ...identifiers.slice(0, 24)],
        evidence: [],
        unresolved_items: [],
        follow_up_suggestions: [],
        context_summary: "The response summarized compatible models.",
        escalation_reason: null,
      }),
      output: [],
    });
  };

  const result = await answerSalesQuestionWithAI({
    question: `Which models are compatible with ${sourceMaterial}?`,
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    fallbackModel: "gpt-5.6-terra",
    groundingBundle: {
      catalog_scope: { materials: 47 },
      allowed_material_numbers: [sourceMaterial, ...identifiers],
      exact_identifier_matches: [{ status: "found", record: { material_number: sourceMaterial } }],
      relationship_results: [{
        status: "found",
        source: { material_number: sourceMaterial, product_name: "RS232 Interface, Scout" },
        relationship_count: relationships.length,
        relationships,
      }],
    },
    fetchImpl,
  });

  assert.equal(requestCount, 1);
  assert.equal(result.answer_items.length, 47);
  assert.equal(new Set(result.answer_items.map((item) => item.identifier)).size, 47);
  assert.equal(result.answer_items.at(-1).identifier, identifiers.at(-1));
  assert.match(result.answer, /^47 compatible models are listed/);
  assert.deepEqual(result.unresolved_items, []);
  assert.equal(result.materials.includes(sourceMaterial), true);
});

test("fills exact master relationships, excludes noisy rows, and reports truncation", async () => {
  const ids = ["93000001", "93000002", "93000003"];
  const rows = ids.map((identifier, index) => ({
    direction: "inbound", matched_material_number: "30268982", related_material_number: identifier,
    source_material_number: identifier, source_model: `MODEL${index + 1}`, relationship_type: "accessories",
    target_material_number: "30268982", target_resolved: 1,
  }));
  rows.push({ direction: "inbound", matched_material_number: "99999999", related_material_number: "99990001", source_material_number: "99990001", source_model: "NOISE", relationship_type: "accessories", target_material_number: "99999999", target_resolved: 1 });
  const fetchImpl = async () => Response.json({ id: "resp-master-partial", status: "completed", output_text: JSON.stringify({
    answer: "One model is available.", answer_items: [{ identifier: ids[0], label: "MODEL1", description: "Compatible model" }],
    status: "answered", confidence: "high", intent: "relationship", materials: ["30268982", ids[0]], evidence: [],
    unresolved_items: [], follow_up_suggestions: [], context_summary: "Partial list.", escalation_reason: null,
  }), output: [] });
  const result = await answerSalesQuestionWithAI({
    question: "Show all compatible models for 30268982.", apiKey: "test-key", model: "gpt-5.6-terra", fallbackModel: "gpt-5.6-terra",
    groundingBundle: {
      catalog_scope: { materials: 6_407 }, allowed_material_numbers: ["30268982", ...ids, "99990001"],
      exact_matches: [{ status: "found", material: { material_number: "30268982" } }], relationships: rows,
      truncated: { relationships: true },
    }, fetchImpl,
  });
  assert.deepEqual(result.answer_items.map((item) => item.identifier), ids);
  assert.equal(result.confidence, "medium");
  assert.match(result.answer, /Showing 3 verified compatible models/);
  assert.match(result.unresolved_items.join(" "), /Additional catalog relationships are not shown/);
});

test("does not fill an intentionally limited compatibility recommendation", async () => {
  const ids = ["94000001", "94000002", "94000003", "94000004"];
  const fetchImpl = async () => Response.json({ id: "resp-top-three", status: "completed", output_text: JSON.stringify({
    answer: "Here are the top three.", answer_items: ids.slice(0, 3).map((identifier) => ({ identifier, label: identifier, description: "Recommended option" })),
    status: "answered", confidence: "high", intent: "selection", materials: ids.slice(0, 3), evidence: [], unresolved_items: [],
    follow_up_suggestions: [], context_summary: "Three recommendations.", escalation_reason: null,
  }), output: [] });
  const result = await answerSalesQuestionWithAI({
    question: "Recommend the best three models compatible with 30268982.", apiKey: "test-key", model: "gpt-5.6-terra", fallbackModel: "gpt-5.6-terra",
    groundingBundle: { catalog_scope: { materials: 4 }, allowed_material_numbers: ids, relationship_results: [{
      source: { material_number: "30268982" }, relationship_count: 4,
      relationships: ids.map((identifier) => ({ direction: "inbound", relationship_type: "accessories", related_material_number: identifier, resolution_status: "resolved", related_item: { model: identifier } })),
    }] }, fetchImpl,
  });
  assert.deepEqual(result.answer_items.map((item) => item.identifier), ids.slice(0, 3));
  assert.equal(result.answer, "Here are the top three.");
});

test("accepts a pre-retrieved grounding bundle and custom evidence hydrator", async () => {
  const groundingBundle = {
    bundle_version: "master-catalog-rag-v1",
    catalog_scope: { materials: 6_407 },
    retrieval: { strategy: "hybrid_rrf", vectorize_status: "ready", result_count: 1 },
    allowed_material_numbers: ["30428204"],
    records: [{ material_number: "30428204", fields: { "Maximum Capacity {metric}": "220 g" } }],
  };
  const fetchImpl = async () => Response.json({
    id: "resp-master",
    output_text: JSON.stringify({
      answer: "The maximum capacity is verified.",
      answer_items: [
        { identifier: "30428204", label: "CR221", description: "Maximum capacity 220 g" },
        { identifier: "99999999", label: "Invented", description: "Must not be trusted" },
      ],
      status: "answered",
      confidence: "high",
      intent: "lookup",
      materials: ["30428204"],
      evidence: [{ material_number: "30428204", field: "Maximum Capacity {metric}" }],
      unresolved_items: [],
      follow_up_suggestions: [],
      context_summary: "CR221 is active.",
      escalation_reason: null,
    }),
    output: [],
  });

  const result = await answerSalesQuestionWithAI({
    question: "What is the capacity of 30428204?",
    apiKey: "test-key",
    groundingBundle,
    evidenceHydrator(items, bundle) {
      return items.map((item) => ({
        ...item,
        model_or_item: "CR221",
        value: bundle.records[0].fields[item.field],
        source_file: "MMMDF.xlsx",
      }));
    },
    fetchImpl,
  });

  assert.equal(result.grounding_products, 6_407);
  assert.equal(result.retrieval_strategy, "hybrid_rrf");
  assert.equal(result.vectorize_status, "ready");
  assert.equal(result.evidence[0].value, "220 g");
  assert.deepEqual(result.answer_items.map((item) => item.identifier), ["30428204"]);
  assert.deepEqual(result.materials, ["30428204"]);
});
