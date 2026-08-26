import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("tracks the exact workbook version and complete portable-balance import", async () => {
  const [catalog, version] = await Promise.all([
    loadJson("../data/portable-balances-api.json"),
    loadJson("../data/sales-catalog-version.json"),
  ]);

  assert.equal(catalog.metadata.source_file, "Alpha-PortableBalances.xlsx");
  assert.match(catalog.metadata.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(catalog.metadata.source_rows, 6_407);
  assert.equal(catalog.metadata.source_columns, 428);
  assert.equal(catalog.metadata.portable_products, 80);
  assert.equal(catalog.records.filter((record) => record.record_type === "portable_balance").length, 80);
  assert.equal(version.source.sha256, catalog.metadata.source_sha256);
  assert.deepEqual(version.catalog, {
    sha256: version.catalog.sha256,
    portable_products: 80,
    portable_families: 7,
    related_items: 91,
    records: 171,
    retrieval_documents: 87,
  });
});

test("generates a complete, source-traceable Markdown retrieval layer", async () => {
  const [index, manifest, cr221] = await Promise.all([
    loadJson("../data/sales-retrieval-index.json"),
    loadJson("../data/sales-rag/manifest.json"),
    readFile(new URL("../data/sales-rag/products/30428204-cr221.md", import.meta.url), "utf8"),
  ]);

  assert.equal(index.document_count, 87);
  assert.equal(index.product_document_count, 80);
  assert.equal(index.family_document_count, 7);
  assert.equal(manifest.documents.length, 87);
  assert.ok(manifest.documents.every((document) => /^[a-f0-9]{64}$/.test(document.sha256)));
  assert.match(cr221, /# CR221/);
  assert.match(cr221, /\| Maximum capacity \| 220 g \|/);
  assert.match(cr221, /\| Readability \| 0\.1 g \|/);
  assert.match(cr221, /Workbook: Alpha-PortableBalances\.xlsx/);
});

test("reports catalog quality without hiding review items", async () => {
  const report = await loadJson("../data/sales-data-quality-report.json");
  assert.equal(report.status, "review_required");
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.warnings, 28);
  assert.equal(report.summary.affected_unresolved_relationship_edges, 86);
  assert.equal(report.summary.retrieval_documents, 87);
  assert.ok(Object.values(report.field_completeness).every((field) => field.completeness_percent === 100));
  assert.equal(report.errors.missing_required_fields.length, 0);
  assert.equal(report.errors.duplicate_material_numbers.length, 0);
});