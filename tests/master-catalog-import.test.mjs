import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importer = path.join(appRoot, "scripts/import-master-catalog.py");
const initialMigration = path.join(appRoot, "migrations/0001_master_catalog.sql");
const rolloutMigration = path.join(appRoot, "migrations/0002_master_catalog_rollout.sql");
const reconciliationMigration = path.join(appRoot, "migrations/0003_reconcile_staged_master.sql");
const fingerprintMigration = path.join(appRoot, "migrations/0004_retrieval_evaluation_build_fingerprint.sql");
const sourceSchema = path.join(appRoot, "db/schema.ts");

function runPython(args, options = {}) {
  const result = spawnSync(process.env.MASTER_CATALOG_PYTHON ?? "python3", args, {
    cwd: appRoot,
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function loadNdjson(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("defines matching normalized D1 source and migration schemas", async () => {
  const [initialSql, rolloutSql, reconciliationSql, fingerprintSql, schema] = await Promise.all([
    readFile(initialMigration, "utf8"),
    readFile(rolloutMigration, "utf8"),
    readFile(reconciliationMigration, "utf8"),
    readFile(fingerprintMigration, "utf8"),
    readFile(sourceSchema, "utf8"),
  ]);
  const sql = `${initialSql}\n${rolloutSql}\n${reconciliationSql}\n${fingerprintSql}`;
  const tables = [
    "master_catalog_versions",
    "master_catalog_evaluations",
    "master_catalog_state",
    "master_materials",
    "master_aliases",
    "master_attributes",
    "master_relationships",
    "master_documents",
    "master_chunks",
    "master_chunks_fts",
    "master_vector_seed_progress",
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS ${table}\\b`));
    assert.match(schema, new RegExp(`\\b${table}\\b`));
  }
  assert.match(sql, /status IN \('loading', 'staged', 'active', 'retired', 'failed'\)/);
  assert.match(sql, /ADD COLUMN generator_version TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /SET generator_version = '1\.1\.0'[\s\S]*mcv_f3213eb213a5f28d58e5f3ab/);
  assert.match(sql, /master_catalog_versions\(source_sha256, schema_version, generator_version\)/);
  assert.match(sql, /status IN \('passed', 'failed', 'incomplete'\)/);
  assert.match(sql, /ADD COLUMN retrieval_profile_sha256 TEXT NOT NULL/);
  assert.match(schema, /generator_version TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS master_chunks_after_insert/);
});

test("adds generator-aware version uniqueness and constrained evaluation history", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ohaus-master-migration-"));
  try {
    const databasePath = path.join(temporaryRoot, "catalog.sqlite");
    const result = JSON.parse(runPython(["-c", [
      "import json,sqlite3,sys,pathlib",
      "db=sqlite3.connect(sys.argv[1])",
      "db.executescript(pathlib.Path(sys.argv[2]).read_text())",
      "row=('mcv_legacy','master-catalog-v1','legacy.xlsx','a'*64,1,'Product_Catalog_AI',1,1,'staged','2026-09-02T00:00:00Z')",
      "db.execute('INSERT INTO master_catalog_versions(version_id,schema_version,source_file,source_sha256,source_bytes,source_sheet,source_rows,source_columns,status,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',row)",
      "historical=('mcv_f3213eb213a5f28d58e5f3ab','master-catalog-v1','master.xlsx','5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb',1,'Product_Catalog_AI',1,1,'staged','2026-09-02T00:00:00Z')",
      "db.execute('INSERT INTO master_catalog_versions(version_id,schema_version,source_file,source_sha256,source_bytes,source_sheet,source_rows,source_columns,status,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',historical)",
      "db.executescript(pathlib.Path(sys.argv[3]).read_text())",
      "db.executescript(pathlib.Path(sys.argv[4]).read_text())",
      "legacy_generator=db.execute(\"SELECT generator_version FROM master_catalog_versions WHERE version_id='mcv_legacy'\").fetchone()[0]",
      "historical_generator=db.execute(\"SELECT generator_version FROM master_catalog_versions WHERE version_id='mcv_f3213eb213a5f28d58e5f3ab'\").fetchone()[0]",
      "row2=('mcv_current','master-catalog-v1','current.xlsx','a'*64,1,'Product_Catalog_AI',1,1,'staged','2026-09-02T00:00:01Z','1.1.0')",
      "db.execute('INSERT INTO master_catalog_versions(version_id,schema_version,source_file,source_sha256,source_bytes,source_sheet,source_rows,source_columns,status,generated_at,generator_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)',row2)",
      "duplicate_rejected=False",
      "try:\n db.execute('INSERT INTO master_catalog_versions(version_id,schema_version,source_file,source_sha256,source_bytes,source_sheet,source_rows,source_columns,status,generated_at,generator_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)',('mcv_duplicate',*row2[1:]))\nexcept sqlite3.IntegrityError:\n duplicate_rejected=True",
      "evaluation=('mcv_current','b'*64,'1.0.0','a'*64,2,2,2,0,'passed','2026-09-02T00:00:02Z','{}','d'*64)",
      "db.execute('INSERT INTO master_catalog_evaluations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',evaluation)",
      "invalid_rejected=False",
      "try:\n db.execute('INSERT INTO master_catalog_evaluations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',('mcv_current','c'*64,'1.0.0','a'*64,2,1,1,0,'passed','2026-09-02T00:00:03Z','{}','e'*64))\nexcept sqlite3.IntegrityError:\n invalid_rejected=True",
      "columns=[r[1] for r in db.execute('PRAGMA table_info(master_catalog_evaluations)')]",
      "print(json.dumps({'legacy_generator':legacy_generator,'historical_generator':historical_generator,'duplicate_rejected':duplicate_rejected,'invalid_rejected':invalid_rejected,'columns':columns}))",
    ].join("\n"), databasePath, initialMigration, rolloutMigration, fingerprintMigration]));

    assert.equal(result.legacy_generator, "legacy");
    assert.equal(result.historical_generator, "1.1.0");
    assert.equal(result.duplicate_rejected, true);
    assert.equal(result.invalid_rejected, true);
    assert.deepEqual(result.columns, [
      "version_id",
      "fixture_sha256",
      "fixture_schema_version",
      "source_sha256",
      "fixture_case_count",
      "evaluated_count",
      "passed_count",
      "failed_count",
      "status",
      "evaluated_at",
      "details_json",
      "retrieval_profile_sha256",
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("reconciles the historical alias declaration only when all aliases are present", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ohaus-master-reconcile-"));
  try {
    const databasePath = path.join(temporaryRoot, "catalog.sqlite");
    const result = JSON.parse(runPython(["-c", [
      "import json,sqlite3,sys,pathlib",
      "db=sqlite3.connect(sys.argv[1])",
      "db.executescript(pathlib.Path(sys.argv[2]).read_text())",
      "db.executescript(pathlib.Path(sys.argv[3]).read_text())",
      "version=('mcv_f3213eb213a5f28d58e5f3ab','master-catalog-v1','1.1.0','master.xlsx','5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb',1,'Product_Catalog_AI',1,1,'staged',14293,'2026-09-02T00:00:00Z')",
      "db.execute('INSERT INTO master_catalog_versions(version_id,schema_version,generator_version,source_file,source_sha256,source_bytes,source_sheet,source_rows,source_columns,status,alias_count,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',version)",
      "db.execute(\"INSERT INTO master_materials(version_id,material_number,product_name,source_row,record_sha256,record_json) VALUES ('mcv_f3213eb213a5f28d58e5f3ab','10000001','Test',2,?, '{}')\",('a'*64,))",
      "db.execute(\"WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<15800) INSERT INTO master_aliases(alias_id,version_id,material_number,alias_type,alias,normalized_alias) SELECT 'a'||x,'mcv_f3213eb213a5f28d58e5f3ab','10000001','test','Alias '||x,'alias '||x FROM seq\")",
      "db.executescript(pathlib.Path(sys.argv[4]).read_text())",
      "print(json.dumps({'declared':db.execute(\"SELECT alias_count FROM master_catalog_versions WHERE version_id='mcv_f3213eb213a5f28d58e5f3ab'\").fetchone()[0],'actual':db.execute(\"SELECT count(*) FROM master_aliases WHERE version_id='mcv_f3213eb213a5f28d58e5f3ab'\").fetchone()[0]}))",
    ].join("\n"), databasePath, initialMigration, rolloutMigration, reconciliationMigration]));
    assert.deepEqual(result, { declared: 15_800, actual: 15_800 });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("imports duplicate headers, exact fields, relationships, documents, FTS, and deterministic chunks", { timeout: 120_000 }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ohaus-master-import-"));
  try {
    const workbook = path.join(temporaryRoot, "sample.xlsx");
    runPython(["-c", [
      "from openpyxl import Workbook",
      "import sys",
      "book=Workbook()",
      "sheet=book.active",
      "sheet.title='Product_Catalog_AI'",
      "sheet.append(['AI_Search_Index','AI_Summary','Material Number','Material Description (Global English)','Parent Family Name','Family Name','Trade Name','Alternative Model_#1','Alternative Model_#2','Maximum Capacity {metric}','Display','Display','Legal for Trade','Sales Org.','Main Delivering Plant','Procurement type','Commodity code','Order Notes','Image URL','Relationship / Accessories','EN Data Sheets 1'])",
      "sheet.append(['Product ID 10000001 | Product Field Balance | Parent Family Portable Balances | Family Field | Commodity SECRET-COMMODITY','A compact field balance.','10000001','Field Balance','Portable Balances','Field','FB220','CR221','MB 120','5 kg','LCD','Backlit','N/A','SECRET-SALES','SECRET-PLANT','SECRET-PROCUREMENT','SECRET-COMMODITY','SECRET-ORDER','https://images.invalid/private.png','20000001','https://docs.invalid/fb220.pdf'])",
      "sheet.append(['Product ID 20000001 | Product Carrying Case | Parent Family Accessories | Family Cases','Protective carrying case.','20000001','Carrying Case','Accessories','Cases','','','','','','','','','','','','','','',''])",
      "book.save(sys.argv[1])",
    ].join(";"), workbook]);

    const firstOutput = path.join(temporaryRoot, "first");
    const secondOutput = path.join(temporaryRoot, "second");
    const nextVersionOutput = path.join(temporaryRoot, "next-version");
    const firstManifestPath = path.join(temporaryRoot, "first-manifest.json");
    const secondManifestPath = path.join(temporaryRoot, "second-manifest.json");
    const nextVersionManifestPath = path.join(temporaryRoot, "next-version-manifest.json");
    runPython([importer, "--source", workbook, "--output-dir", firstOutput, "--manifest", firstManifestPath]);
    runPython([importer, "--source", workbook, "--output-dir", secondOutput, "--manifest", secondManifestPath]);

    const nextVersionWorkbook = path.join(temporaryRoot, "sample-next.xlsx");
    runPython(["-c", [
      "from openpyxl import load_workbook",
      "import sys",
      "book=load_workbook(sys.argv[1])",
      "book['Product_Catalog_AI']['B3']='An updated protective carrying case.'",
      "book.save(sys.argv[2])",
    ].join(";"), workbook, nextVersionWorkbook]);
    runPython([importer, "--source", nextVersionWorkbook, "--output-dir", nextVersionOutput, "--manifest", nextVersionManifestPath]);

    const [firstManifest, secondManifest, nextVersionManifest, records, chunks, vectorSeed, activationSql] = await Promise.all([
      readFile(firstManifestPath, "utf8").then(JSON.parse),
      readFile(secondManifestPath, "utf8").then(JSON.parse),
      readFile(nextVersionManifestPath, "utf8").then(JSON.parse),
      loadNdjson(path.join(firstOutput, "master-catalog-records.ndjson")),
      loadNdjson(path.join(firstOutput, "master-catalog-chunks.ndjson")),
      loadNdjson(path.join(firstOutput, "master-catalog-vector-seed.ndjson")),
      readFile(path.join(firstOutput, "master-catalog-activate.sql"), "utf8"),
    ]);

    const expectedVersionId = `mcv_${createHash("sha256")
      .update(`master-catalog-v1:1.2.0:${firstManifest.source.sha256}`)
      .digest("hex")
      .slice(0, 24)}`;
    assert.equal(firstManifest.version_id, secondManifest.version_id);
    assert.equal(firstManifest.version_id, expectedVersionId);
    assert.notEqual(firstManifest.version_id, nextVersionManifest.version_id);
    assert.equal(firstManifest.status, "staged");
    assert.equal(firstManifest.migration, "migrations/0004_retrieval_evaluation_build_fingerprint.sql");
    assert.deepEqual(firstManifest.migrations, [
      "migrations/0001_master_catalog.sql",
      "migrations/0002_master_catalog_rollout.sql",
      "migrations/0003_reconcile_staged_master.sql",
      "migrations/0004_retrieval_evaluation_build_fingerprint.sql",
    ]);
    assert.equal(firstManifest.generator.version, "1.2.0");
    assert.equal(firstManifest.generator.alias_strategy, "source-plus-compact-alpha-digit-spaced");
    assert.equal(firstManifest.counts.materials, 2);
    assert.equal(firstManifest.counts.aliases, 10);
    assert.equal(firstManifest.counts.named_parent_families, 2);
    assert.equal(firstManifest.counts.named_families, 2);
    assert.equal(firstManifest.counts.relationships, 1);
    assert.equal(firstManifest.counts.resolved_relationships, 1);
    assert.equal(firstManifest.counts.documents, 1);
    assert.equal(firstManifest.quality.duplicate_header_groups, 1);

    const product = records.find((record) => record.material_number === "10000001");
    assert.equal(product.fields.display, "LCD");
    assert.equal(product.fields.display__2, "Backlit");
    assert.equal(product.fields.maximum_capacity_metric, "5 kg");
    assert.equal(product.fields.alternative_model_1, "CR221");
    assert.equal(product.fields.alternative_model_2, "MB 120");
    assert.equal(product.fields.sales_org, "SECRET-SALES");
    assert.equal(product.fields.legal_for_trade, "N/A");
    assert.equal(product.fields.image_url, "https://images.invalid/private.png");
    assert.equal(product.fields.relationship_accessories, "20000001");

    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((chunk) => chunk.chunk_id.length <= 64));
    assert.ok(chunks.every((chunk) => chunk.content.length <= 1_450));
    assert.ok(chunks.every((chunk) => !chunk.chunk_kind.startsWith("relationship_") && chunk.chunk_kind !== "documents"));
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunk_id),
      (await loadNdjson(path.join(secondOutput, "master-catalog-chunks.ndjson"))).map((chunk) => chunk.chunk_id),
    );
    const semanticText = chunks.map((chunk) => chunk.content).join("\n");
    assert.doesNotMatch(semanticText, /SECRET-SALES|SECRET-PLANT|SECRET-PROCUREMENT|SECRET-COMMODITY|SECRET-ORDER/);
    assert.doesNotMatch(semanticText, /images\.invalid/);
    assert.doesNotMatch(semanticText, /N\/A/);
    assert.match(semanticText, /5 kg/);
    assert.equal(vectorSeed.length, chunks.length);
    assert.ok(vectorSeed.every((item) => item.id.length <= 64 && item.text.length <= 1_450));
    assert.match(activationSql, /activation is intentionally API-gated/i);
    assert.doesNotMatch(activationSql, /\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i);

    const databasePath = path.join(temporaryRoot, "catalog.sqlite");
    const stageFiles = firstManifest.outputs
      .map((output) => output.path)
      .filter((output) => /^master-catalog-stage-.*\.sql$/.test(output))
      .sort()
      .map((output) => path.join(firstOutput, output));
    const sqliteResult = JSON.parse(runPython(["-c", [
      "import json,sqlite3,sys,pathlib",
      "db=sqlite3.connect(sys.argv[1])",
      "db.executescript(pathlib.Path(sys.argv[2]).read_text())",
      "db.executescript(pathlib.Path(sys.argv[3]).read_text())",
      "[db.executescript(pathlib.Path(p).read_text()) for p in sys.argv[4:]]",
      "names=['master_materials','master_aliases','master_attributes','master_relationships','master_documents','master_chunks','master_chunks_fts','master_vector_seed_progress']",
      "counts={name:db.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in names}",
      "counts['status']=db.execute('SELECT status FROM master_catalog_versions').fetchone()[0]",
      "counts['generator_version']=db.execute('SELECT generator_version FROM master_catalog_versions').fetchone()[0]",
      "counts['numeric_capacity']=db.execute(\"SELECT value_number FROM master_attributes WHERE field_key='maximum_capacity_metric'\").fetchone()[0]",
      "counts['canonical_capacity'],counts['canonical_unit']=db.execute(\"SELECT canonical_number,canonical_unit FROM master_attributes WHERE field_key='maximum_capacity_metric'\").fetchone()",
      "counts['identifier_aliases']=db.execute(\"SELECT alias_type,alias,normalized_alias FROM master_aliases WHERE material_number='10000001' AND alias_type IN ('alternative_model','trade_name') ORDER BY alias_type,normalized_alias\").fetchall()",
      "print(json.dumps(counts))",
    ].join(";"), databasePath, initialMigration, rolloutMigration, ...stageFiles]));
    assert.equal(sqliteResult.master_materials, 2);
    assert.equal(sqliteResult.master_relationships, 1);
    assert.equal(sqliteResult.master_documents, 1);
    assert.equal(sqliteResult.master_chunks_fts, chunks.length);
    assert.equal(sqliteResult.master_vector_seed_progress, chunks.length);
    assert.equal(sqliteResult.status, "staged");
    assert.equal(sqliteResult.generator_version, "1.2.0");
    assert.equal(sqliteResult.numeric_capacity, 5);
    assert.equal(sqliteResult.canonical_capacity, 5_000);
    assert.equal(sqliteResult.canonical_unit, "g");
    assert.deepEqual(sqliteResult.identifier_aliases, [
      ["alternative_model", "CR221", "cr 221"],
      ["alternative_model", "CR221", "cr221"],
      ["alternative_model", "MB 120", "mb 120"],
      ["alternative_model", "MB 120", "mb120"],
      ["trade_name", "FB220", "fb 220"],
      ["trade_name", "FB220", "fb220"],
    ]);
    assert.ok(firstManifest.sql.maximum_observed_statement_bytes <= 80 * 1_024);

    // Global ID primary keys must remain version-scoped. Staging a later
    // workbook with an unchanged first product must preserve every normalized
    // row in both versions instead of silently skipping duplicates.
    const nextVersionStageFiles = nextVersionManifest.outputs
      .map((output) => output.path)
      .filter((output) => /^master-catalog-stage-.*\.sql$/.test(output))
      .sort()
      .map((output) => path.join(nextVersionOutput, output));
    const versionedDatabasePath = path.join(temporaryRoot, "catalog-versions.sqlite");
    const versionedCounts = JSON.parse(runPython(["-c", [
      "import json,sqlite3,sys,pathlib",
      "db=sqlite3.connect(sys.argv[1])",
      "db.executescript(pathlib.Path(sys.argv[2]).read_text())",
      "db.executescript(pathlib.Path(sys.argv[3]).read_text())",
      "[db.executescript(pathlib.Path(p).read_text()) for p in sys.argv[4:]]",
      "versions=[r[0] for r in db.execute('SELECT version_id FROM master_catalog_versions ORDER BY version_id')]",
      "tables=['master_materials','master_aliases','master_attributes','master_relationships','master_documents','master_chunks','master_vector_seed_progress']",
      "counts={v:{t:db.execute('SELECT count(*) FROM '+t+' WHERE version_id=?',(v,)).fetchone()[0] for t in tables} for v in versions}",
      "counts['fts']={v:db.execute('SELECT count(*) FROM master_chunks_fts WHERE version_id=?',(v,)).fetchone()[0] for v in versions}",
      "print(json.dumps(counts))",
    ].join(";"), versionedDatabasePath, initialMigration, rolloutMigration, ...stageFiles, ...nextVersionStageFiles]));
    for (const catalogManifest of [firstManifest, nextVersionManifest]) {
      const counts = versionedCounts[catalogManifest.version_id];
      assert.equal(counts.master_materials, catalogManifest.counts.materials);
      assert.equal(counts.master_aliases, catalogManifest.counts.aliases);
      assert.equal(counts.master_attributes, catalogManifest.counts.attributes);
      assert.equal(counts.master_relationships, catalogManifest.counts.relationships);
      assert.equal(counts.master_documents, catalogManifest.counts.documents);
      assert.equal(counts.master_chunks, catalogManifest.counts.chunks);
      assert.equal(counts.master_vector_seed_progress, catalogManifest.counts.chunks);
      assert.equal(versionedCounts.fts[catalogManifest.version_id], catalogManifest.counts.chunks);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("tracks the complete MMMDF staging manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(appRoot, "data/master-catalog-manifest.json"), "utf8"));
  assert.equal(manifest.version_id, "mcv_f3213eb213a5f28d58e5f3ab");
  assert.equal(manifest.generator.version, "1.1.0");
  assert.equal(manifest.migration, "migrations/0001_master_catalog.sql");
  assert.equal(manifest.status, "staged");
  assert.equal(manifest.source.file, "MMMDF_EN_US_20260605_AI_Organized 2.xlsx");
  assert.equal(manifest.source.sha256, "5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb");
  assert.equal(manifest.source.rows, 6_407);
  assert.equal(manifest.source.columns, 428);
  assert.equal(manifest.counts.materials, 6_407);
  assert.equal(manifest.counts.named_parent_families, 46);
  assert.equal(manifest.counts.named_families, 215);
  assert.equal(manifest.generator.alias_strategy, "source-plus-compact-alpha-digit-spaced");
  assert.equal(manifest.chunking.maximum_characters, 1_450);
  assert.ok(manifest.chunking.maximum_observed_characters <= 1_450);
  assert.ok(manifest.chunk_samples.every((chunk) => chunk.chunk_id.length <= 64));
  assert.ok(manifest.sql.maximum_observed_statement_bytes <= manifest.sql.conservative_statement_limit_bytes);
  assert.equal(manifest.quality.errors, 0);
});
