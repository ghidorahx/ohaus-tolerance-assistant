import assert from "node:assert/strict";
import test from "node:test";
import { buildGroundingBundle } from "../lib/sales-catalog.mjs";
import {
  answerLegacyCatalogFastLane,
  answerMasterCatalogFastLane,
  interpretCatalogQuestion,
} from "../lib/catalog-fast-lane.mjs";
import { requestedMasterRelationshipTypes } from "../lib/master-catalog-rag.mjs";

function legacyAnswer(question, context = []) {
  const interpretation = interpretCatalogQuestion(question);
  const grounding = buildGroundingBundle({
    question: interpretation.expanded_query,
    sessionContext: context,
    semanticRetrieval: null,
  });
  return answerLegacyCatalogFastLane({ question, interpretation, grounding });
}

function masterRetrieval(overrides = {}) {
  return {
    status: "ready",
    version: { source_file: "MMMDF.xlsx" },
    retrieval: {
      strategy: "exact",
      semantic: { status: "not_configured", matches: [] },
    },
    exact_matches: [],
    catalog_listing: { requested: false, status: "skipped", items: [] },
    chunks: [],
    materials: [],
    relationships: [],
    documents: [],
    documents_requested: false,
    documents_status: "skipped",
    ...overrides,
  };
}

test("answers colloquial capacity and readability phrases directly from exact Excel fields", () => {
  const answer = legacyAnswer("How much can CR221 weigh, and what is the smallest weight it can show?");
  assert.equal(answer.answer_engine, "catalog_fast_lane");
  assert.equal(answer.ai_used, false);
  assert.equal(answer.model, "Direct Excel lookup");
  assert.equal(answer.reasoning_effort, "none");
  assert.equal(answer.answer_items.length, 1);
  assert.equal(answer.answer_items[0].identifier, "30428204");
  assert.match(answer.answer_items[0].description, /Maximum capacity: 220 g/);
  assert.match(answer.answer_items[0].description, /Readability: 0\.1 g/);
  assert.deepEqual(answer.evidence.map((item) => item.field), [
    "specifications.maximum_capacity",
    "specifications.readability",
  ]);
});

test("keeps can-weigh capacity separate from does-weigh product weight", () => {
  const capacity = legacyAnswer("How much can CR221 weigh?");
  const productWeight = legacyAnswer("How much does CR221 weigh?");
  assert.match(capacity.answer_items[0].description, /Maximum capacity: 220 g/);
  assert.doesNotMatch(capacity.answer_items[0].description, /Product weight/);
  assert.match(productWeight.answer_items[0].description, /Product weight: 0\.4 kg/);
  assert.doesNotMatch(productWeight.answer_items[0].description, /Maximum capacity/);
});

test("understands unplugged runtime without invoking semantic or generative AI", () => {
  const answer = legacyAnswer("Can CR221 run unplugged, and for how long?");
  assert.equal(answer.ai_used, false);
  assert.match(answer.answer_items[0].description, /Power: 3 AA/);
  assert.match(answer.answer_items[0].description, /Battery life: 300 Hours/);
  assert.equal(answer.vectorize_status, "skipped");
});

test("returns every relationship item on its own line and labels it as catalog-listed", () => {
  const answer = legacyAnswer("What accessories fit STX123?");
  assert.equal(answer.intent, "relationship");
  assert.ok(answer.answer_items.length > 5);
  assert.ok(answer.answer_items.every((item) => /^\d{8}$/.test(item.identifier)));
  assert.ok(answer.answer_items.every((item) => /listed in the Excel catalog/.test(item.description)));
  assert.equal(new Set(answer.answer_items.map((item) => item.identifier)).size, answer.answer_items.length);
});

test("reverse-maps a legacy accessory to every compatible model without AI", () => {
  for (const question of [
    "Which models are compatible with 30268982?",
    "Which models fit 30268982?",
    "What models work with 30268982?",
    "What balances does 30268982 fit?",
  ]) {
    const answer = legacyAnswer(question);
    assert.equal(answer.answer_engine, "catalog_fast_lane", question);
    assert.equal(answer.ai_used, false, question);
    assert.equal(answer.answer_items.length, 44, question);
    assert.equal(answer.materials.length, 45, question);
    assert.match(answer.answer, /44 compatible models/, question);
    assert.equal(answer.confidence, "high", question);
    assert.deepEqual(answer.unresolved_items, [], question);
    assert.ok(answer.answer_items.every((item) => /compatible model listed in the Excel catalog/.test(item.description)), question);
    assert.equal(new Set(answer.answer_items.map((item) => item.identifier)).size, 44, question);
  }
});

test("searches every relationship type for generic compatibility wording and honors explicit types", () => {
  for (const question of [
    "Which models are compatible with 30268982?",
    "Which models fit 30268982?",
    "What models work with 30268982?",
    "What balances does 30268982 fit?",
  ]) {
    const interpretation = interpretCatalogQuestion(question);
    assert.equal(interpretation.relationship_type, "all", question);
    assert.deepEqual(interpretation.relationship_types, ["all"], question);
    assert.deepEqual(requestedMasterRelationshipTypes(question), ["all"], question);
  }

  assert.deepEqual(interpretCatalogQuestion("Which accessories fit 30268982?").relationship_types, ["accessories"]);
  assert.deepEqual(requestedMasterRelationshipTypes("Which accessories fit 30268982?"), ["accessories"]);
  assert.deepEqual(interpretCatalogQuestion("Which spare parts work with 30268982?").relationship_types, ["spare_parts"]);
  assert.deepEqual(requestedMasterRelationshipTypes("Which spare parts work with 30268982?"), ["spare_parts"]);
});

test("returns every master-catalog compatible model when the inbound list is below eighty", () => {
  const record = {
    material_number: "30268982",
    trade_name: "RS232 Interface, Scout",
    product_name: "RS232 Interface, Scout",
    fields: {},
    source: { file: "MMMDF.xlsx" },
  };
  const relationships = Array.from({ length: 47 }, (_, index) => ({
    direction: "inbound",
    matched_material_number: "30268982",
    source_material_number: String(92000000 + index),
    source_model: `SCOUT${index + 1}`,
    source_product_name: `Portable Balance SCOUT${index + 1}`,
    relationship_type: "accessories",
    target_material_number: "30268982",
    related_material_number: String(92000000 + index),
    target_resolved: 1,
  }));
  const answer = answerMasterCatalogFastLane({
    question: "Which models are compatible with 30268982?",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "30268982", status: "found", record }],
      relationships,
    }),
  });

  assert.equal(answer.answer_items.length, 47);
  assert.equal(answer.materials.length, 48);
  assert.match(answer.answer, /47 compatible models/);
  assert.doesNotMatch(answer.answer, /showing the first/);
  assert.ok(answer.answer_items.every((item) => /compatible model listed/.test(item.description)));
  assert.equal(answer.confidence, "high");
});

test("answers unsupported live commercial data immediately and keeps recommendations on AI", () => {
  const live = legacyAnswer("What is the current price and stock level for CR221?");
  assert.equal(live.status, "not_in_source");
  assert.equal(live.ai_used, false);
  assert.match(live.answer, /Live pricing and Live inventory/);

  const recommendation = "Which balance is best for a classroom?";
  const interpretation = interpretCatalogQuestion(recommendation);
  assert.equal(interpretation.requires_synthesis, true);
  assert.equal(interpretation.fast_lane_candidate, false);
  assert.equal(legacyAnswer(recommendation), null);
});

test("normalizes common misspellings and recognizes short or explicitly labeled identifiers", () => {
  const misspelled = interpretCatalogQuestion("Whats the readabilty and capcity of CR221?");
  assert.deepEqual(misspelled.concepts.map((concept) => concept.id), ["capacity", "readability"]);
  assert.equal(misspelled.fast_lane_candidate, true);
  assert.equal(interpretCatalogQuestion("What comes with V2A?").fast_lane_candidate, true);
  assert.equal(interpretCatalogQuestion("Capacity of alternative model 9123?").has_identifier, true);
});

test("understands common power and weight-limit phrasing but declines unknown or mixed intents", () => {
  const weightLimit = legacyAnswer("What is the weight limit for CR221?");
  assert.match(weightLimit.answer_items[0].description, /Maximum capacity: 220 g/);

  const batteryPower = legacyAnswer("Will CR221 work on battery?");
  assert.match(batteryPower.answer_items[0].description, /Power: 3 AA/);

  const batteryLife = legacyAnswer("How long does CR221 last on batteries?");
  assert.match(batteryLife.answer_items[0].description, /Battery life: 300 Hours/);

  assert.equal(legacyAnswer("How sensitive is CR221?"), null);
  assert.equal(legacyAnswer("What is the warranty for CR221?"), null);
  assert.equal(legacyAnswer("What is the capacity and current price for CR221?"), null);
  assert.equal(legacyAnswer("What accessories fit STX123 and what is its capacity?"), null);
  assert.equal(legacyAnswer("Compare the capacity of CR221 and FAKE999"), null);
  assert.deepEqual(interpretCatalogQuestion("What has 120000 g capacity?").identifier_candidates, []);
  assert.deepEqual(interpretCatalogQuestion("What has 120000 grams capacity?").identifier_candidates, []);
  assert.equal(legacyAnswer("What is warranty and capacity for CR221?"), null);
  assert.equal(legacyAnswer("Tell me capacity but not readability for CR221"), null);
  for (const question of [
    "CR221 capacity warranty",
    "CR221 capacity & warranty",
    "What is the capacity with warranty of CR221?",
    "What is CR221 capacity also warranty?",
  ]) {
    assert.equal(legacyAnswer(question), null, question);
  }
});

test("rejects nearby but different compound meanings instead of guessing a catalog field", () => {
  for (const question of [
    "How long is CR221 warranty?",
    "Does CR221 have a power button?",
    "Can CR221 connect to a 220V outlet?",
    "Will CR221 fit on my bench?",
    "Will CR221 fit in a 12 inch space?",
    "What is the battery capacity of CR221?",
    "How much can CR221 hold in memory?",
    "Does CR221 have a screen protector?",
    "What is the screen resolution of CR221?",
    "Is CR221 compatible with food use?",
    "Is CR221 compatible with a 200 g sample?",
  ]) {
    assert.equal(legacyAnswer(question), null, question);
  }
  assert.match(legacyAnswer("How long is CR221 battery life?").answer_items[0].description, /Battery life/);
  assert.match(legacyAnswer("What is the shipping weight of CR221?").answer_items[0].description, /Shipping weight: 580 G/);
});

test("keeps included contents separate from optional accessories", () => {
  for (const question of [
    "Which accessories are included with CR221?",
    "Which accessories come with CR221?",
    "What accessories are in the box for CR221?",
  ]) {
    const included = legacyAnswer(question);
    assert.equal(included.intent, "lookup", question);
    assert.equal(included.status, "not_in_source", question);
    assert.equal(included.answer_items.length, 1, question);
  }

  const optional = legacyAnswer("Which accessories fit CR221?");
  assert.equal(optional.intent, "relationship");
  assert.ok(optional.answer_items.length > 0);
});

test("keeps pan dimensions separate from the product's overall dimensions", () => {
  for (const question of [
    "What are the pan dimensions for CR221?",
    "What are the dimensions of the CR221 pan?",
  ]) {
    const answer = legacyAnswer(question);
    assert.match(answer.answer_items[0].description, /Pan or platform size/, question);
    assert.doesNotMatch(answer.answer_items[0].description, /Dimensions:/, question);
  }
});

test("only treats short, explicit anaphora as prior-product context", () => {
  const followUp = interpretCatalogQuestion("What accessories fit it?");
  assert.equal(followUp.uses_context_reference, true);
  assert.equal(followUp.fast_lane_candidate, true);

  const discovery = interpretCatalogQuestion("I need a quiet mini centrifuge with imbalance protection that stops the rotor if the lid opens. What fits?");
  assert.equal(discovery.uses_context_reference, false);
  assert.equal(discovery.fast_lane_candidate, false);
});

test("resolves natural material-number follow-ups from prior context without treating connectors as models", () => {
  const context = [{
    question: "Tell me about CR221",
    answer: "Portable Balance CR221",
    materials: ["30428204"],
    contextSummary: "CR221",
  }];
  for (const question of [
    "What is the material number for it?",
    "Part number for this model?",
    "Item number of it?",
    "What material number is it?",
  ]) {
    const interpretation = interpretCatalogQuestion(question);
    assert.deepEqual(interpretation.identifier_candidates, [], question);
    assert.equal(legacyAnswer(question, context).answer_items[0].identifier, "30428204", question);
  }
});

test("handles order and restock questions as unavailable live data without AI", () => {
  const order = legacyAnswer("Has the latest customer order for material 30428204 shipped yet?");
  assert.equal(order.ai_used, false);
  assert.equal(order.status, "not_in_source");
  assert.match(order.answer, /Current order status/);

  const restock = legacyAnswer("When will material 30428204 be back in inventory?");
  assert.equal(restock.ai_used, false);
  assert.match(restock.answer, /Future restock timing/);
});

test("answers a master-catalog exact lookup only from the resolved record", () => {
  const record = {
    material_number: "30428204",
    trade_name: "CR221",
    product_name: "Portable Balance CR221",
    parent_family: "Portable Balances",
    family: "Compass™ CR",
    fields: {
      display: "Liquid Crystal Display (LCD)",
      maximum_capacity_metric: "220 g",
      readability_metric: "0.1 g",
    },
    source: { file: "MMMDF.xlsx" },
  };
  const question = "What is the capacity and smallest increment of CR221?";
  const answer = answerMasterCatalogFastLane({
    question,
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      materials: [{ material_number: record.material_number, record }],
    }),
  });
  assert.equal(answer.ai_used, false);
  assert.equal(answer.answer_items[0].identifier, "30428204");
  assert.match(answer.answer_items[0].description, /220 g/);
  assert.match(answer.answer_items[0].description, /0\.1 g/);
  assert.ok(answer.evidence.every((item) => item.source_file === "MMMDF.xlsx"));
});

test("deduplicates one product mentioned by both model and material number", () => {
  const record = {
    material_number: "30428204",
    trade_name: "CR221",
    product_name: "Portable Balance CR221",
    fields: { maximum_capacity_metric: "220 g" },
  };
  const answer = answerMasterCatalogFastLane({
    question: "What is the capacity of CR221 material 30428204?",
    retrieval: masterRetrieval({
      exact_matches: [
        { identifier: "CR221", status: "found", record },
        { identifier: "30428204", status: "found", record },
      ],
    }),
  });
  assert.equal(answer.answer_items.length, 1);
  assert.equal(answer.answer_items[0].identifier, "30428204");
});

test("answers advanced master fields and scalar compatibility from exact workbook values", () => {
  const meter = {
    material_number: "30073970",
    trade_name: "ST10",
    product_name: "Pen Meter ST10",
    fields: { ph_measuring_range: "0.1 – 14" },
    source: { file: "MMMDF.xlsx" },
  };
  const phAnswer = answerMasterCatalogFastLane({
    question: "Across what pH range can ST10 measure?",
    retrieval: masterRetrieval({ exact_matches: [{ identifier: "ST10", status: "found", record: meter }] }),
  });
  assert.deepEqual(phAnswer.evidence.map((item) => item.field), ["fields.ph_measuring_range"]);
  assert.match(phAnswer.answer_items[0].description, /pH measuring range: 0\.1 – 14/);

  const rotor = {
    material_number: "30304361",
    trade_name: "R-A24X2/20MIB",
    product_name: "Rotor Angle 24x1.5/2.0ml ID BIOSEALS",
    fields: { compatible_models: "FC5720R" },
    source: { file: "MMMDF.xlsx" },
  };
  const compatibility = answerMasterCatalogFastLane({
    question: "Which models are listed as compatible with R-A24X2/20MIB?",
    retrieval: masterRetrieval({ exact_matches: [{ identifier: "R-A24X2/20MIB", status: "found", record: rotor }] }),
  });
  assert.equal(compatibility.intent, "lookup");
  assert.match(compatibility.answer_items[0].description, /Compatible models: FC5720R/);
  assert.equal(compatibility.evidence[0].field, "fields.compatible_models");
});

test("preserves every compatible model from a multi-value master workbook cell", () => {
  const compatibleModels = "FC5714;FC5718;FC5718R;FC5720R;FC5816;FC5816R;FC5830R;FC5916;FC5916R";
  const rotor = {
    material_number: "30314824",
    trade_name: "R-A6X50MI",
    product_name: "Rotor Angle 6x50ml ID",
    fields: { compatible_models: compatibleModels },
    source: { file: "MMMDF_EN_US_20260605_AI_Organized 2.xlsx" },
  };
  const answer = answerMasterCatalogFastLane({
    question: "Which models are compatible with material 30314824?",
    retrieval: masterRetrieval({ exact_matches: [{ identifier: "30314824", status: "found", record: rotor }] }),
  });

  assert.equal(answer.ai_used, false);
  assert.equal(answer.answer_items.length, 1);
  assert.match(answer.answer_items[0].description, new RegExp(`Compatible models: ${compatibleModels}$`));
  assert.equal(answer.evidence[0].value, compatibleModels);
});

test("never selects the first ambiguous alias", () => {
  const question = "What is the capacity of SKX222?";
  const answer = answerMasterCatalogFastLane({
    question,
    retrieval: masterRetrieval({
      exact_matches: [{
        identifier: "SKX222",
        status: "ambiguous",
        candidates: [
          { material_number: "30253030", model: "SKX222", product_name: "Portable Balance SKX222" },
          { material_number: "30268917", model: "SKX222", product_name: "Portable Balance SKX222" },
        ],
      }],
    }),
  });
  assert.equal(answer.status, "needs_clarification");
  assert.deepEqual(answer.answer_items.map((item) => item.identifier), ["30253030", "30268917"]);
  assert.doesNotMatch(answer.answer, /220 g|capacity is/i);
});

test("keeps unresolved master relationships explicitly unverified", () => {
  const record = {
    material_number: "30253005",
    trade_name: "STX123",
    product_name: "Portable Balance STX123",
    fields: {},
    source: { file: "MMMDF.xlsx" },
  };
  const question = "Which accessories are listed for STX123?";
  const answer = answerMasterCatalogFastLane({
    question,
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "STX123", status: "found", record }],
      relationships: [{
        direction: "outbound",
        source_material_number: "30253005",
        relationship_type: "accessories",
        target_material_number: "99999999",
        target_resolved: 0,
      }],
    }),
  });
  assert.equal(answer.answer_items[0].identifier, "99999999");
  assert.match(answer.answer_items[0].description, /listed in the Excel catalog/);
  assert.match(answer.answer_items[0].description, /record unresolved/);
});

test("filters relationship and document enrichment to the exact requested material", () => {
  const record = {
    material_number: "30428204",
    trade_name: "CR221",
    product_name: "Portable Balance CR221",
    fields: {},
    source: { file: "MMMDF.xlsx" },
  };
  const relationship = answerMasterCatalogFastLane({
    question: "Which accessories are listed for CR221?",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      relationships: [
        {
          direction: "outbound",
          matched_material_number: "30428204",
          source_material_number: "30428204",
          relationship_type: "accessories",
          target_material_number: "30467763",
          related_material_number: "30467763",
          target_resolved: 1,
        },
        {
          direction: "outbound",
          matched_material_number: "99990000",
          source_material_number: "99990000",
          relationship_type: "accessories",
          target_material_number: "99990001",
          related_material_number: "99990001",
          target_resolved: 1,
        },
      ],
    }),
  });
  assert.deepEqual(relationship.answer_items.map((item) => item.identifier), ["30467763"]);

  const documents = answerMasterCatalogFastLane({
    question: "Show me the manual for CR221.",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      documents: [
        { material_number: "30428204", document_type: "manual", url: "https://example.test/cr221" },
        { material_number: "30428204", document_type: "data_sheet", url: "https://example.test/cr221-data" },
        { material_number: "99990000", document_type: "manual", url: "https://example.test/neighbor" },
      ],
      documents_requested: true,
      documents_status: "ready",
    }),
  });
  assert.match(documents.answer, /example\.test\/cr221/);
  assert.doesNotMatch(documents.answer, /cr221-data/);
  assert.doesNotMatch(documents.answer, /neighbor/);
});

test("declines direct document or relationship answers when enrichment was unavailable", () => {
  const record = { material_number: "30428204", trade_name: "CR221", fields: {} };
  const unavailableDocument = answerMasterCatalogFastLane({
    question: "Show me the manual for CR221.",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      documents_requested: true,
      documents_status: "unavailable",
      warnings: ["Document expansion unavailable: D1 timeout"],
    }),
  });
  assert.equal(unavailableDocument, null);

  const partialRelationship = answerMasterCatalogFastLane({
    question: "What are all related items for CR221?",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      relationships: [{
        direction: "outbound",
        matched_material_number: "30428204",
        source_material_number: "30428204",
        relationship_type: "accessories",
        target_material_number: "30467763",
        related_material_number: "30467763",
      }],
      warnings: ["inbound relationship lookup unavailable: D1 timeout"],
    }),
  });
  assert.equal(partialRelationship, null);
});

test("returns all direct relationship results below the expanded visible item limit", () => {
  const record = { material_number: "30428204", trade_name: "CR221", fields: {} };
  const relationships = Array.from({ length: 30 }, (_, index) => ({
    direction: "outbound",
    matched_material_number: "30428204",
    source_material_number: "30428204",
    relationship_type: "accessories",
    target_material_number: String(90000000 + index),
    related_material_number: String(90000000 + index),
    target_resolved: 0,
  }));
  const answer = answerMasterCatalogFastLane({
    question: "Which accessories fit CR221?",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      relationships,
    }),
  });
  assert.equal(answer.answer_items.length, 30);
  assert.match(answer.answer, /30 accessories/);
  assert.doesNotMatch(answer.answer, /showing the first/);
  assert.equal(answer.confidence, "high");
  assert.equal(answer.unresolved_items.length, 0);
});

test("reports when a direct relationship result exceeds eighty visible items", () => {
  const record = { material_number: "30428204", trade_name: "CR221", fields: {} };
  const relationships = Array.from({ length: 90 }, (_, index) => ({
    direction: "outbound",
    matched_material_number: "30428204",
    source_material_number: "30428204",
    relationship_type: "accessories",
    target_material_number: String(90000000 + index),
    related_material_number: String(90000000 + index),
    target_resolved: 0,
  }));
  const answer = answerMasterCatalogFastLane({
    question: "Which accessories fit CR221?",
    retrieval: masterRetrieval({
      exact_matches: [{ identifier: "CR221", status: "found", record }],
      relationships,
    }),
  });
  assert.equal(answer.answer_items.length, 80);
  assert.equal(answer.materials.length, 81);
  assert.match(answer.answer, /90 accessories.*showing the first 80/);
  assert.equal(answer.confidence, "medium");
  assert.equal(answer.unresolved_items.length, 1);
});

test("prefers a shipping-specific weight over a conflicting generic gross weight", () => {
  const record = {
    material_number: "12345678",
    trade_name: "SHIP1",
    fields: {
      gross_weight_shipping: "2.5 kg",
      net_weight_shipping: "2.0 kg",
      gross_weight: "9.9 kg",
    },
  };
  const answer = answerMasterCatalogFastLane({
    question: "What is the shipping weight of SHIP1?",
    retrieval: masterRetrieval({ exact_matches: [{ identifier: "SHIP1", status: "found", record }] }),
  });
  assert.match(answer.answer_items[0].description, /Shipping weight: 2\.5 kg/);
  assert.doesNotMatch(answer.answer_items[0].description, /9\.9 kg/);
});

test("renders exact master category listings directly but leaves semantic discovery for AI", () => {
  const question = "Show every Compass CR model in the catalog.";
  const interpretation = interpretCatalogQuestion(question);
  assert.equal(interpretation.asks_catalog_listing, true);
  const answer = answerMasterCatalogFastLane({
    question,
    interpretation,
    retrieval: masterRetrieval({
      catalog_listing: {
        requested: true,
        status: "ready",
        kind: "materials_by_category",
        category: { level: "family", name: "Compass™ CR" },
        total_count: 2,
        returned_count: 2,
        truncated: false,
        items: [
          { material_number: "30428204", model: "CR221", product_name: "Portable Balance CR221", family: "Compass™ CR" },
          { material_number: "30428205", model: "CR621", product_name: "Portable Balance CR621", family: "Compass™ CR" },
        ],
      },
    }),
  });
  assert.equal(answer.intent, "catalog_scope");
  assert.deepEqual(answer.answer_items.map((item) => item.identifier), ["30428204", "30428205"]);

  assert.equal(interpretCatalogQuestion("Which homogenizer is designed for cell lysis?").fast_lane_candidate, false);
});
