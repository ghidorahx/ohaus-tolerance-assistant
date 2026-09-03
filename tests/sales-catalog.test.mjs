import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroundingBundle,
  compareProducts,
  findNearestCapacityAlternatives,
  filterProducts,
  getCatalogOverview,
  getRecords,
  getRelationships,
  hydrateEvidenceItems,
  interpretCustomerQuestion,
  searchCatalog,
  searchRetrievalDocuments,
} from "../lib/sales-catalog.mjs";

test("loads the complete portable-balance pilot catalog", () => {
  const status = getCatalogOverview();
  assert.equal(status.portable_products, 80);
  assert.equal(status.portable_families, 7);
  assert.equal(status.api_records, 171);
  assert.equal(status.retrieval_documents, 87);
  assert.equal(status.product_retrieval_documents, 80);
  assert.equal(status.family_retrieval_documents, 7);
  assert.equal(status.retrieval_status, "ready");
  assert.ok(status.available_field_count > 80);
});

test("retrieves exact records and preserves duplicate model ambiguity", () => {
  const exact = getRecords({ identifiers: ["30428204"], sections: ["specifications"] });
  assert.equal(exact.results[0].record.model, "CR221");
  assert.equal(exact.results[0].record.specifications.maximum_capacity.display, "220 g");

  const ambiguous = getRecords({ identifiers: ["SKX2201"], sections: ["all"] });
  assert.equal(ambiguous.results[0].status, "ambiguous");
  assert.ok(ambiguous.results[0].candidates.length > 1);
});

test("searches across natural-language sales and usage fields", () => {
  const result = searchCatalog({ query: "outdoor battery portable", record_type: "portable_balance", limit: 10 });
  assert.ok(result.result_count > 0);
  assert.ok(result.results.some((item) => item.record.usage_context.includes("Outdoor")));
  assert.ok(result.results.every((item) => item.matched_fields.length > 0));
});

test("interprets colloquial customer language before catalog retrieval", () => {
  const interpreted = interpretCustomerQuestion(
    "The customer needs to count small components in a warehouse where there may not be an outlet.",
  );
  assert.deepEqual(
    interpreted.recognized_concepts.map((concept) => concept.id),
    ["battery_operation", "industrial_use", "parts_counting"],
  );
  assert.equal(interpreted.derived_selection.battery_required, true);
  assert.deepEqual(interpreted.derived_selection.applications, ["Parts Counting"]);
  assert.deepEqual(interpreted.derived_selection.usage_context, ["Work in Industrial"]);
  assert.match(interpreted.expanded_query, /battery|Parts Counting|Work in Industrial/);
});

test("recognizes customer outcomes instead of requiring catalog wording", () => {
  const hold = interpretCustomerQuestion("They need the number to stay visible after removing the item.");
  assert.ok(hold.recognized_concepts.some((concept) => concept.id === "display_hold"));
  assert.deepEqual(hold.derived_selection.applications, ["Display Hold"]);

  const compact = interpretCustomerQuestion("Bench space is limited and they want to tuck it away after use.");
  assert.ok(compact.recognized_concepts.some((concept) => concept.id === "compact_space"));
  assert.ok(compact.derived_selection.search_terms.includes("space saving"));
});

test("retrieves generated product and family knowledge documents", () => {
  const result = searchRetrievalDocuments({
    query: "slim stackable space saving classroom balance",
    document_type: "any",
    limit: 5,
  });
  assert.equal(result.status, "ready");
  assert.ok(result.result_count > 0);
  assert.ok(result.results.some((item) => item.family === "Compass™ CR"));
  assert.ok(result.results.every((item) => item.source_file === "Alpha-PortableBalances.xlsx"));
  assert.match(result.results.map((item) => item.excerpt).join(" "), /slim|stackable|space|classroom/i);
});

test("filters numerical and categorical requirements deterministically", () => {
  const result = filterProducts({
    minimum_capacity_g: 5_000,
    maximum_capacity_g: null,
    maximum_readability_g: 1,
    families: [],
    applications: [],
    usage_context: [],
    battery_required: true,
    legal_for_trade: null,
    search_terms: [],
    limit: 20,
  });
  assert.ok(result.total_matches > 0);
  assert.ok(result.products.every((product) => product.maximum_capacity.value >= 5_000));
  assert.ok(result.products.every((product) => product.readability.value <= 1));
  assert.ok(result.products.every((product) => /batter/i.test(product.power)));
});

test("compares arbitrary workbook-backed fields", () => {
  const result = compareProducts({
    identifiers: ["CR221", "CR5200"],
    fields: ["capacity", "readability", "power", "dimensions"],
  });
  assert.equal(result.comparisons.length, 2);
  assert.equal(result.comparisons[0].fields.capacity.display, "220 g");
  assert.equal(result.comparisons[1].fields.capacity.display, "5200 g");
  assert.ok(result.comparisons.every((product) => product.fields.dimensions.width));
});

test("keeps unresolved relationship items visible for review", () => {
  const result = getRelationships({ material_number: "30253005", relationship_type: "accessories" });
  assert.equal(result.status, "found");
  assert.ok(result.relationships.length > 0);
  assert.ok(result.relationships.some((relationship) => relationship.resolution_status === "needs_source"));
});

test("reverse-maps related items to every compatible portable-balance material", () => {
  const result = getRelationships({ material_number: "30268982", relationship_type: "accessories" });
  assert.equal(result.status, "found");
  assert.equal(result.source.material_number, "30268982");
  assert.equal(result.relationship_count, 44);
  assert.ok(result.relationships.every((relationship) => relationship.direction === "inbound"));
  assert.ok(result.relationships.every((relationship) => relationship.related_item?.model));
  assert.equal(new Set(result.relationships.map((relationship) => relationship.related_material_number)).size, 44);
});

test("retrieves legacy relationships for fit and work-with compatibility wording", () => {
  for (const question of [
    "Which models fit 30268982?",
    "What models work with 30268982?",
  ]) {
    const bundle = buildGroundingBundle({ question });
    assert.equal(bundle.relationship_results.length, 1, question);
    assert.equal(bundle.relationship_results[0].relationship_count, 44, question);
    assert.ok(bundle.relationship_results[0].relationships.every((relationship) => relationship.direction === "inbound"), question);
  }
});

test("hydrates model evidence from authoritative record values", () => {
  const evidence = hydrateEvidenceItems([
    { material_number: "30428204", field: "capacity" },
    { material_number: "30428204", field: "readability" },
    { material_number: "missing", field: "power" },
  ]);
  assert.deepEqual(evidence.map((item) => item.value), ["220 g", "0.1 g"]);
  assert.ok(evidence.every((item) => item.source_file === "Alpha-PortableBalances.xlsx"));
});

test("builds broad current-turn grounding and carries verified follow-up materials", () => {
  const bundle = buildGroundingBundle({
    question: "What accessories are listed for it?",
    sessionContext: [{ materials: ["30428204"] }],
  });
  assert.equal(bundle.bundle_version, "sales-grounding-v9-vectorize");
  assert.equal(bundle.exact_identifier_matches[0].record.material_number, "30428204");
  assert.equal(bundle.relationship_results[0].source.material_number, "30428204");
  assert.equal(bundle.catalog_scope.portable_products, 80);
  assert.equal(bundle.retrieval_document_matches.status, "ready");
  assert.equal(bundle.retrieval_document_matches.result_count, 8);
  assert.equal(bundle.retrieval_document_matches.strategy, "local_fallback");
  assert.equal(bundle.source_file, "Alpha-PortableBalances.xlsx");
});

test("hydrates Vectorize candidates from the authoritative local retrieval index", () => {
  const bundle = buildGroundingBundle({
    question: "I need a slim stackable classroom balance.",
    semanticRetrieval: {
      status: "ready",
      index: "ohaus-sales-catalog-v1",
      matches: [
        { document_id: "family:scout-skx", score: 0.93 },
        { document_id: "unknown:document", score: 0.99 },
      ],
    },
  });
  assert.equal(bundle.retrieval_document_matches.strategy, "vectorize_hybrid");
  assert.equal(bundle.retrieval_document_matches.vectorize_status, "ready");
  assert.equal(bundle.retrieval_document_matches.results[0].document_id, "family:scout-skx");
  assert.equal(bundle.retrieval_document_matches.results[0].semantic_score, 0.93);
  assert.equal(bundle.retrieval_document_matches.results.some((item) => item.document_id === "unknown:document"), false);
  assert.equal(bundle.retrieval_document_matches.result_count, 8);
});

test("supplies the complete populated record when explicitly requested", () => {
  const bundle = buildGroundingBundle({
    question: "Show me all information and complete specifications for CR221.",
    sessionContext: [],
  });
  const record = bundle.exact_identifier_matches[0].record;
  assert.equal(record.material_number, "30428204");
  assert.equal(record.specifications.maximum_capacity.display, "220 g");
  assert.ok(Object.keys(record.sales_content).length > 20);
  assert.ok(Object.keys(record.additional_attributes).length > 0);
  assert.ok(record.documents.data_sheet.length > 0);
  assert.equal(bundle.retrieval_document_matches.result_count, 0);
  assert.match(bundle.retrieval_document_matches.note, /Complete exact structured record/);
});

test("separates exact, numerical-nearest, and requirement-qualifying capacities", () => {
  const exact = findNearestCapacityAlternatives("Do you have exactly 225 gram capacity? If not, what is closest?");
  assert.equal(exact.requirement.requirement_type, "exact");
  assert.equal(exact.exact_match_count, 0);
  assert.equal(exact.closest_below.capacity_g, 220);
  assert.equal(exact.closest_below.difference_g, -5);
  assert.equal(exact.closest_above.capacity_g, 250);
  assert.equal(exact.closest_above.difference_g, 25);

  const minimum = findNearestCapacityAlternatives("Which balance has at least 225 g capacity?");
  assert.equal(minimum.requirement.requirement_type, "minimum");
  assert.equal(minimum.closest_qualifying_products[0].maximum_capacity.value, 250);
  assert.ok(minimum.closest_qualifying_products.every((product) => product.maximum_capacity.value >= 225));

  const ambiguous = findNearestCapacityAlternatives("A customer needs a 225 gram capacity.");
  assert.equal(ambiguous.requirement.requirement_type, "ambiguous");
  assert.equal(ambiguous.requirement.clarification_needed, true);
});

test("pre-filters explicit numerical selection requirements before generation", () => {
  const bundle = buildGroundingBundle({
    question: "Which balances support at least 5 kg capacity, 1 g readability, and battery operation?",
    sessionContext: [],
  });
  const result = bundle.deterministic_selection_results;
  assert.equal(result.criteria.minimum_capacity_g, 5_000);
  assert.equal(result.criteria.maximum_readability_g, 1);
  assert.equal(result.criteria.battery_required, true);
  assert.ok(result.total_matches > 0);
  assert.ok(result.products.every((product) => product.maximum_capacity.value >= 5_000));
  assert.ok(result.products.every((product) => product.readability.value <= 1));
  assert.ok(result.products.every((product) => /batter/i.test(product.power)));
});

test("applies inferred customer intent to deterministic product selection", () => {
  const bundle = buildGroundingBundle({
    question: "We need to count components on a factory floor with no nearby outlet.",
    sessionContext: [],
  });
  const result = bundle.deterministic_selection_results;
  assert.equal(result.criteria.battery_required, true);
  assert.deepEqual(result.criteria.applications, ["Parts Counting"]);
  assert.deepEqual(result.criteria.usage_context, ["Work in Industrial"]);
  assert.ok(result.total_matches > 0);
  assert.ok(result.products.every((product) => /parts counting/i.test(product.application)));
  assert.ok(result.products.every((product) => /batter/i.test(product.power)));
});
