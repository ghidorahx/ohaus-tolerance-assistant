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
  assert.equal(bundle.bundle_version, "sales-grounding-v7");
  assert.equal(bundle.exact_identifier_matches[0].record.material_number, "30428204");
  assert.equal(bundle.relationship_results[0].source.material_number, "30428204");
  assert.equal(bundle.catalog_scope.portable_products, 80);
  assert.equal(bundle.retrieval_document_matches.status, "ready");
  assert.equal(bundle.retrieval_document_matches.result_count, 20);
  assert.equal(bundle.source_file, "Alpha-PortableBalances.xlsx");
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