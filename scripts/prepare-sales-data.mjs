import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultInput = path.resolve(
  appRoot,
  "../tmp/portable_balances_api_20260820/api_ready_data.json",
);
const inputPath = path.resolve(process.argv[2] ?? defaultInput);
const outputPath = path.join(appRoot, "data/portable-balances-api.json");

const source = JSON.parse(await readFile(inputPath, "utf8"));
const records = source.api_records.map((record) => JSON.parse(record.record_json));
const unresolvedRelationships = source.relationships
  .filter((relationship) => relationship.resolution_status === "Needs source")
  .map((relationship) => ({
    source_material_number: relationship.source_material_number,
    source_model: relationship.source_model,
    relationship_type: relationship.relationship_type,
    related_material_number: relationship.related_material_number,
    source_field: relationship.source_field,
  }));

const output = {
  metadata: {
    source_file: source.metadata.source_file,
    selection_rule: source.metadata.selection_rule,
    generated_at: new Date().toISOString(),
    portable_products: source.metadata.portable_products,
    portable_families: source.metadata.portable_families,
    family_counts: source.metadata.family_counts,
    api_records: records.length,
    resolved_related_items: source.metadata.resolved_related_items,
    document_links: source.metadata.document_links,
    relationship_edges: source.metadata.relationship_edges,
    unresolved_relationship_edges: source.metadata.unresolved_relationship_edges,
    qa_items: source.metadata.qa_items,
  },
  records,
  unresolved_relationships: unresolvedRelationships,
  test_questions: source.test_questions,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");

console.log(JSON.stringify({
  inputPath,
  outputPath,
  records: records.length,
  unresolvedRelationships: unresolvedRelationships.length,
}, null, 2));
