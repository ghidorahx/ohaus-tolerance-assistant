import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMasterGroundingBundle,
  hydrateMasterEvidenceItems,
} from "../lib/master-catalog-grounding.mjs";

const retrieval = {
  status: "ready",
  version: { source_file: "master.xlsx" },
  retrieval: {
    strategy: "hybrid_rrf",
    lexical: { status: "ready" },
    numeric: { status: "ready" },
    semantic: { status: "ready" },
    fused_candidates: 12,
  },
  prompt_context: {
    catalog_scope: {
      source_file: "master.xlsx",
      material_count: 6407,
      chunk_count: 45167,
      relationship_count: 203589,
      document_count: 5775,
    },
    materials: [{ material_number: "10000001", model: "MODEL-1", product_name: "Product 1" }],
    chunks: [{ chunk_id: "mc_1", material_number: "10000001", content: "Capacity: 5 kg" }],
    evidence: [{ material_number: "10000001", model_or_item: "MODEL-1", field: "fields.capacity", value: "5 kg", source_file: "master.xlsx" }],
  },
  relationships: [{
    source_material_number: "10000001", relationship_type: "accessories",
    target_material_number: "20000001", target_resolved: 1, target_product_name: "Cable",
  }],
  documents: [{ material_number: "10000001", document_type: "manual", url: "https://example.test/manual" }],
};

test("builds a compact diagnostics-aligned grounding contract", () => {
  const bundle = buildMasterGroundingBundle(retrieval, { parent_families: 46, families: 215 });
  assert.equal(bundle.catalog_scope.materials, 6407);
  assert.equal(bundle.catalog_scope.parent_families, 46);
  assert.equal(bundle.retrieval.strategy, "hybrid_rrf");
  assert.equal(bundle.retrieval.vectorize_status, "ready");
  assert.equal(bundle.retrieval.result_count, 1);
  assert.deepEqual(bundle.allowed_material_numbers.sort(), ["10000001", "20000001"]);
  assert.equal(Object.hasOwn(bundle, "record"), false);
  assert.equal(JSON.stringify(bundle).includes("record_json"), false);
});

test("hydrates only cited source fields and supports relationship/document evidence", () => {
  const bundle = buildMasterGroundingBundle(retrieval);
  const hydrated = hydrateMasterEvidenceItems([
    { material_number: "10000001", field: "fields.capacity" },
    { material_number: "10000001", field: "relationships.accessories" },
    { material_number: "10000001", field: "documents.manual" },
    { material_number: "10000001", field: "fields.invented" },
  ], bundle);
  assert.deepEqual(hydrated.map((item) => item.field), [
    "fields.capacity",
    "relationships.accessories",
    "documents.manual",
  ]);
  assert.match(hydrated[1].value, /20000001/);
  assert.match(hydrated[2].value, /https:\/\/example\.test\/manual/);
});
