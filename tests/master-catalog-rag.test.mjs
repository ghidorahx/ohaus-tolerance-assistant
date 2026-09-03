import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  activateMasterCatalogVersion,
  boundedEmbeddingText,
  buildMasterCatalogPromptContext,
  CatalogAdminError,
  getMasterCatalogStatus,
  MASTER_CATALOG_TABLES,
  MASTER_CATALOG_BUNDLE_VERSION,
  MASTER_DEFAULT_CHUNK_LIMIT,
  MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD,
  MASTER_DEFAULT_TOP_K,
  MASTER_EMBEDDING_DIMENSIONS,
  MASTER_EMBEDDING_MODEL,
  MASTER_EMBEDDING_POOLING,
  MASTER_VECTORIZE_INDEX,
  MASTER_VECTORIZE_METRIC,
  masterCatalogNamespace,
  normalizeCatalogIdentifier,
  parseMasterNumericConstraints,
  recordMasterCatalogEvaluation,
  reciprocalRankFuse,
  requestedMasterRelationshipTypes,
  resetFailedMasterVectorSeed,
  resolveMasterIdentifier,
  retrieveMasterCatalog,
  seedMasterVectorizeBatch,
  selectCompactEvidence,
} from "../lib/master-catalog-rag.mjs";

function vector(value = 0.1) {
  return Array.from({ length: MASTER_EMBEDDING_DIMENSIONS }, () => value);
}

function createDb(handler) {
  const calls = [];
  function prepare(sql) {
    const state = { sql: String(sql).replace(/\s+/g, " ").trim(), parameters: [] };
    const statement = {
      bind(...parameters) {
        state.parameters = parameters;
        return statement;
      },
      async all() {
        calls.push({ method: "all", ...state });
        return { results: await handler(state.sql, state.parameters, "all") ?? [] };
      },
      async first() {
        calls.push({ method: "first", ...state });
        const result = await handler(state.sql, state.parameters, "first");
        return Array.isArray(result) ? result[0] ?? null : result ?? null;
      },
      async run() {
        calls.push({ method: "run", ...state });
        return await handler(state.sql, state.parameters, "run") ?? { success: true };
      },
      _state: state,
    };
    return statement;
  }
  return {
    calls,
    prepare,
    async batch(statements) {
      calls.push({ method: "batch", statements: statements.map((statement) => statement._state) });
      return statements.map(() => ({ success: true }));
    },
  };
}

const activeVersion = {
  version_id: "mcv_20260605a1b2",
  schema_version: "1",
  source_file: "MMMDF_EN_US_20260605_AI_Organized 2.xlsx",
  source_sheet: "Product_Catalog_AI",
  source_sha256: "a".repeat(64),
  source_rows: 6407,
  source_columns: 428,
  material_count: 6407,
  alias_count: 15000,
  attribute_count: 250000,
  chunk_count: 18000,
  relationship_count: 203589,
  document_count: 5799,
  status: "active",
};

const namespace = masterCatalogNamespace(activeVersion.version_id);

function versionHandler(sql, parameters) {
  if (sql.includes("FROM master_catalog_state AS s")) return activeVersion;
  if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) {
    return parameters[0] === activeVersion.version_id ? activeVersion : null;
  }
  return undefined;
}

function emptySeedStatus() {
  return { total: 0, seeded: 0, pending: 0, failed: 0 };
}

test("uses importer-compatible aliases and exact master table names", () => {
  // NFKD expands the trademark glyph to "TM", matching the Python importer.
  assert.equal(normalizeCatalogIdentifier("Scout™ STX-123"), "scouttm stx 123");
  assert.equal(normalizeCatalogIdentifier("214642"), "214642");
  assert.equal(namespace, `master-${activeVersion.version_id}`);
  assert.deepEqual(Object.values(MASTER_CATALOG_TABLES), [
    "master_catalog_versions",
    "master_catalog_state",
    "master_materials",
    "master_aliases",
    "master_attributes",
    "master_chunks",
    "master_chunks_fts",
    "master_relationships",
    "master_documents",
    "master_vector_seed_progress",
    "master_catalog_evaluations",
  ]);
  assert.equal(MASTER_VECTORIZE_INDEX, "ohaus-master-catalog-fast-v1");
  assert.equal(MASTER_EMBEDDING_MODEL, "@cf/baai/bge-small-en-v1.5");
  assert.equal(MASTER_EMBEDDING_DIMENSIONS, 384);
});

test("reports public catalog health without scanning vector seed progress", async () => {
  const missing = await getMasterCatalogStatus();
  assert.equal(missing.status, "not_configured");
  assert.equal(missing.embedding_dimensions, 384);

  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_vector_seed_progress")) return emptySeedStatus();
    return [];
  });
  const ready = await getMasterCatalogStatus({ db, ai: {}, index: {} });
  assert.equal(ready.status, "ready");
  assert.equal(ready.active_version.material_count, 6407);
  assert.equal(ready.active_version.namespace, namespace);
  assert.equal(ready.seed_progress, null);
  assert.deepEqual(ready.configured, { d1: true, workers_ai: true, vectorize: true });
  assert.equal(db.calls.some((call) => call.sql?.includes("FROM master_vector_seed_progress")), false);
});

test("includes vector seed progress when authenticated administration requests it", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_vector_seed_progress")) return emptySeedStatus();
    return [];
  });

  const ready = await getMasterCatalogStatus({
    db,
    ai: {},
    index: {},
    versionId: activeVersion.version_id,
    includeSeedProgress: true,
  });

  assert.equal(ready.status, "ready");
  assert.equal(ready.seed_progress.status, "empty");
  const seedQueries = db.calls.filter((call) => call.sql?.includes("FROM master_vector_seed_progress"));
  assert.equal(seedQueries.length, 1);
  assert.deepEqual(seedQueries[0].parameters, [activeVersion.version_id]);
});

test("resolves material number before importer-normalized model aliases", async () => {
  const cr221 = {
    material_number: "30428204",
    trade_name: "CR221",
    product_name: "Portable Balance CR221",
    source_row: 122,
    source_file: activeVersion.source_file,
    source_sheet: activeVersion.source_sheet,
    record_json: JSON.stringify({
      schema_version: "1",
      material_number: "30428204",
      source: { file: activeVersion.source_file, sheet: activeVersion.source_sheet, row: 122 },
      fields: { maximum_capacity_metric: "220 g" },
    }),
  };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_materials AS m") && sql.includes("m.material_number = ?")) {
      return parameters[1] === "30428204" ? [cr221] : [];
    }
    if (sql.includes("FROM master_aliases AS a")) {
      assert.equal(parameters[1], "skx 2201");
      return [
        { ...cr221, material_number: "30253037", trade_name: "SKX2201", record_json: JSON.stringify({ material_number: "30253037", fields: {} }) },
        { ...cr221, material_number: "30268924", trade_name: "SKX2201", record_json: JSON.stringify({ material_number: "30268924", fields: {} }) },
      ];
    }
    return [];
  });

  const exact = await resolveMasterIdentifier({ identifier: "30428204", db });
  assert.equal(exact.status, "found");
  assert.equal(exact.record.model, "CR221");
  assert.equal(exact.record.fields.maximum_capacity_metric, "220 g");
  assert.equal(db.calls.some((call) => call.sql?.includes("FROM master_aliases") && call.parameters[1] === "30428204"), false);

  const ambiguous = await resolveMasterIdentifier({ identifier: "SKX-2201", db });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.material_number), ["30253037", "30268924"]);
});

test("reciprocal rank fusion rewards chunks found by multiple retrievers", () => {
  const fused = reciprocalRankFuse([
    { name: "lexical", weight: 1.1, matches: [{ id: "lexical-only" }, { id: "shared" }] },
    { name: "semantic", weight: 1, matches: [{ id: "shared" }, { id: "semantic-only" }] },
  ]);
  assert.equal(fused[0].id, "shared");
  assert.deepEqual(fused[0].sources, ["lexical", "semantic"]);
});

test("parses deterministic exact, at-least, and at-most numeric constraints", () => {
  const constraints = parseMasterNumericConstraints(
    "Find capacity at least 220 g, readability exactly 0.1 g, and weight at most 5 kg.",
  );
  assert.deepEqual(constraints.map(({ field, comparator, value, unit }) => ({ field, comparator, value, unit })), [
    { field: "capacity", comparator: "at_least", value: 220, unit: "g" },
    { field: "readability", comparator: "exact", value: 0.1, unit: "g" },
    { field: "weight", comparator: "at_most", value: 5, unit: "kg" },
  ]);
});

test("preserves strict numeric comparators, inclusive ranges, and percent units", () => {
  const strict = parseMasterNumericConstraints(
    "Find capacity > 5 kg and weight less than 10 kg.",
  );
  assert.deepEqual(strict.map(({ field, comparator, value, unit }) => ({ field, comparator, value, unit })), [
    { field: "capacity", comparator: "greater_than", value: 5, unit: "kg" },
    { field: "weight", comparator: "less_than", value: 10, unit: "kg" },
  ]);

  const inclusive = parseMasterNumericConstraints(
    "Find capacity >= 5 kg and weight <= 10 kg.",
  );
  assert.deepEqual(inclusive.map(({ field, comparator }) => ({ field, comparator })), [
    { field: "capacity", comparator: "at_least" },
    { field: "weight", comparator: "at_most" },
  ]);

  const range = parseMasterNumericConstraints("Find capacity between 5 and 10 kg.");
  assert.deepEqual(range.map(({ field, comparator, value, unit }) => ({ field, comparator, value, unit })), [
    { field: "capacity", comparator: "at_least", value: 5, unit: "kg" },
    { field: "capacity", comparator: "at_most", value: 10, unit: "kg" },
  ]);

  const percent = parseMasterNumericConstraints("Find moisture below 80%RH.");
  assert.deepEqual(percent.map(({ field, comparator, value, unit }) => ({ field, comparator, value, unit })), [
    { field: "moisture", comparator: "less_than", value: 80, unit: "%" },
  ]);
});

test("does not turn relationship product names or hyphenated model text into numeric requirements", () => {
  assert.deepEqual(
    parseMasterNumericConstraints("Which service codes are linked to Load Cell 0785-22kg 0.18m C3?"),
    [],
  );
  assert.deepEqual(
    parseMasterNumericConstraints("Which upsell material numbers are listed for Weight Set ASTM (2)200g-1mg UC NonAd TR?"),
    [],
  );
  assert.deepEqual(
    parseMasterNumericConstraints("Find temperature below -10 °C.")
      .map(({ field, comparator, value, unit }) => ({ field, comparator, value, unit })),
    [{ field: "temperature", comparator: "less_than", value: -10, unit: "c" }],
  );
  assert.deepEqual(
    parseMasterNumericConstraints("Which accessories work with balances with 220 g capacity?")
      .map(({ field, comparator, value, unit }) => ({ field, comparator, value, unit })),
    [{ field: "capacity", comparator: "exact", value: 220, unit: "g" }],
  );
});

test("requires both numeric range bounds to match the same strict maximum-capacity attribute", async () => {
  let eligibility = null;
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("master_attributes AS numeric_0")) {
      eligibility = { sql, parameters };
      return [];
    }
    if (sql.includes("GROUP BY m.parent_family")) return [];
    if (sql.includes("GROUP BY m.family")) return [{ name: "Compass™ CR", material_count: 4, total_count: 1 }];
    if (sql.includes("m.family = ?")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  await retrieveMasterCatalog({
    question: "Which Compass CR models have a maximum capacity between 700 g and 800 g?",
    db,
  });

  assert.ok(eligibility);
  assert.match(eligibility.sql, /master_attributes AS numeric_0/);
  assert.doesNotMatch(eligibility.sql, /master_attributes AS numeric_1/);
  assert.match(eligibility.sql, /numeric_0\.canonical_number >= \?/);
  assert.match(eligibility.sql, /numeric_0\.canonical_number <= \?/);
  const serializedFieldSets = eligibility.parameters.filter((value) => typeof value === "string" && value.startsWith("["));
  assert.ok(serializedFieldSets.some((value) => value.includes("maximum_capacity_metric")));
  assert.equal(serializedFieldSets.some((value) => value.includes("maximum_loading_weight") || value.includes("weigh_beam_capacity")), false);
});

test("uses strict SQL operators for strict numeric filters", async () => {
  const eligibilitySql = [];
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("master_attributes AS numeric_0")) {
      eligibilitySql.push(sql);
      return [];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  await retrieveMasterCatalog({ question: "capacity > 220 g", db });
  await retrieveMasterCatalog({ question: "capacity < 220 g", db });

  assert.equal(eligibilitySql.length, 2);
  assert.match(eligibilitySql[0], /numeric_0\.canonical_number > \?/);
  assert.doesNotMatch(eligibilitySql[0], /numeric_0\.canonical_number >= \?/);
  assert.match(eligibilitySql[1], /numeric_0\.canonical_number < \?/);
  assert.doesNotMatch(eligibilitySql[1], /numeric_0\.canonical_number <= \?/);
});

test("runs exact, lexical, numeric, and semantic retrieval concurrently with compact field evidence", async () => {
  const recordJson = {
    schema_version: "1",
    material_number: "30428204",
    source: { file: activeVersion.source_file, sheet: activeVersion.source_sheet, row: 122 },
    fields: { maximum_capacity_metric: "220 g", readability_metric: "0.1 g", procurement_type: "F" },
  };
  const materialRow = {
    material_number: "30428204", trade_name: "CR221", product_name: "Portable Balance CR221",
    parent_family: "Balances & Scales", family: "Compass CR", source_row: 122,
    source_file: activeVersion.source_file, source_sheet: activeVersion.source_sheet,
    record_json: JSON.stringify(recordJson),
  };
  const chunks = {
    mc_shared: {
      chunk_id: "mc_shared", material_number: "30428204", chunk_kind: "performance", chunk_ordinal: 1,
      parent_family: "Balances & Scales", family: "Compass CR", title: "CR221 — Performance",
      content: "Maximum Capacity (Metric): 220 g; Readability (Metric): 0.1 g",
      field_keys_json: JSON.stringify(["maximum_capacity_metric", "readability_metric"]),
      metadata_json: JSON.stringify({ source_file: activeVersion.source_file, source_sheet: activeVersion.source_sheet, source_row: 122 }),
    },
    mc_other: {
      chunk_id: "mc_other", material_number: "30428204", chunk_kind: "applications", chunk_ordinal: 1,
      title: "CR221 — Applications", content: "A compact everyday portable balance.",
      field_keys_json: JSON.stringify(["product_name"]), metadata_json: "{}",
    },
  };
  let lexicalStarted = false;
  let semanticStarted = false;
  const db = createDb(async (sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_materials AS m") && sql.includes("m.material_number = ?")) {
      return parameters[1] === "30428204" ? [materialRow] : [];
    }
    if (sql.includes("FROM master_aliases AS a")) return [];
    if (sql.includes("SELECT m.material_number") && sql.includes("FROM master_materials AS m") && sql.includes("AS numeric_0")) {
      return [{ material_number: "30428204" }];
    }
    if (sql.includes("FROM master_chunks_fts")) {
      lexicalStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(semanticStarted, true);
      return [
        { chunk_id: "mc_shared", material_number: "30428204", bm25_score: -12 },
        { chunk_id: "mc_other", material_number: "30428204", bm25_score: -8 },
      ];
    }
    if (sql.includes("FROM master_attributes AS a") && sql.includes("json_each")) {
      if (parameters.some((parameter) => String(parameter).includes("maximum_capacity_metric"))) return [
        { material_number: "30428204", field_key: "maximum_capacity_metric", source_header: "Maximum Capacity (Metric)", source_column: "AA", value_number: 220, value_unit: "g", canonical_number: 220, canonical_unit: "g", chunk_id: "mc_shared" },
        { material_number: "99999999", field_key: "maximum_capacity_metric", source_header: "Maximum Capacity (Metric)", source_column: "AA", value_number: 500, value_unit: "g", canonical_number: 500, canonical_unit: "g", chunk_id: "mc_decoy" },
      ];
      return [{ material_number: "30428204", field_key: "readability_metric", source_header: "Readability (Metric)", source_column: "AB", value_number: 0.1, value_unit: "g", canonical_number: 0.1, canonical_unit: "g", chunk_id: "mc_shared" }];
    }
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) {
      return parameters.slice(1).flatMap((id) => chunks[id] ? [chunks[id]] : []);
    }
    if (sql.includes("FROM master_chunks") && sql.includes("material_number IN")) return [chunks.mc_shared];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [materialRow];
    if (sql.includes("FROM master_attributes") && sql.includes("field_key IN")) {
      return [
        { material_number: "30428204", field_key: "maximum_capacity_metric", source_header: "Maximum Capacity (Metric)", source_column: "AA", source_ordinal: 27 },
        { material_number: "30428204", field_key: "readability_metric", source_header: "Readability (Metric)", source_column: "AB", source_ordinal: 28 },
      ];
    }
    return [];
  });
  const ai = {
    async run(model, input) {
      semanticStarted = true;
      assert.equal(model, MASTER_EMBEDDING_MODEL);
      assert.equal(input.pooling, MASTER_EMBEDDING_POOLING);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { data: [vector()] };
    },
  };
  const index = {
    async query(_queryVector, options) {
      assert.equal(options.namespace, namespace);
      assert.equal(options.returnMetadata, "none");
      return { matches: [{ id: "mc_shared", score: 0.94 }, { id: "mc_other", score: 0.83 }] };
    },
  };

  const result = await retrieveMasterCatalog({ question: "Which material has capacity at least 0.22 kg and readability at most 0.1 g? Is 30428204 suitable?", db, ai, index });
  assert.equal(result.bundle_version, "master-catalog-rag-v1");
  assert.equal(result.status, "ready");
  assert.equal(result.retrieval.strategy, "hybrid_rrf");
  assert.equal(result.retrieval.numeric.matches[0].id, "mc_shared");
  assert.deepEqual(result.retrieval.numeric.eligible_materials, ["30428204"]);
  assert.equal(result.retrieval.numeric.matches.some((match) => match.id === "mc_decoy"), false);
  assert.equal(result.exact_matches.some((match) => match.status === "found"), true);
  assert.equal(result.chunks[0].chunk_id, "mc_shared");
  assert.equal(result.materials[0].record.fields.maximum_capacity_metric, "220 g");
  assert.equal(Object.hasOwn(result.prompt_context.materials[0], "record"), false);
  assert.equal(Object.hasOwn(result.prompt_context.exact_matches[0], "record"), false);
  assert.equal(result.prompt_context.catalog_scope.material_count, 6407);
  const capacity = result.evidence.find((item) => item.field === "fields.maximum_capacity_metric");
  assert.equal(capacity.value, "220 g");
  assert.equal(capacity.source_column, "AA");
  assert.equal(result.evidence.some((item) => item.field === "fields.procurement_type"), false);
  assert.equal(lexicalStarted, true);
  const numericCalls = db.calls.filter((call) => call.sql?.includes("FROM master_attributes AS a") && call.sql.includes("json_each"));
  assert.ok(numericCalls.every((call) => call.sql.includes("a.field_key IN")));
  assert.ok(numericCalls.every((call) => call.parameters.every((parameter) => !String(parameter).startsWith("%"))));
});

test("intersects complete numeric material sets before ranking and avoids duplicate chunk joins", async () => {
  const materialNumber = "39999999";
  const material = {
    material_number: materialNumber,
    trade_name: "LATE220",
    product_name: "Late-ranked qualifying balance",
    record_json: JSON.stringify({ material_number: materialNumber, fields: {} }),
  };
  const chunks = {
    mc_late_capacity: { chunk_id: "mc_late_capacity", material_number: materialNumber, chunk_kind: "performance", chunk_ordinal: 1, title: "Capacity", content: "Maximum capacity 220 g", field_keys_json: JSON.stringify(["maximum_capacity_metric"]), metadata_json: "{}" },
    mc_late_readability: { chunk_id: "mc_late_readability", material_number: materialNumber, chunk_kind: "performance", chunk_ordinal: 2, title: "Readability", content: "Readability 0.1 g", field_keys_json: JSON.stringify(["readability_metric"]), metadata_json: "{}" },
    mc_late_dimension: { chunk_id: "mc_late_dimension", material_number: materialNumber, chunk_kind: "physical", chunk_ordinal: 1, title: "Dimensions", content: "Width 300 mm", field_keys_json: JSON.stringify(["width_metric"]), metadata_json: "{}" },
  };
  let eligibilitySql = "";
  const numericEvidenceSql = [];
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("AS numeric_0") && sql.includes("AS numeric_1") && sql.includes("AS numeric_2")) {
      eligibilitySql = sql;
      // This row represents a qualifying material beyond the old independent
      // per-constraint LIMIT window.
      return [{ material_number: materialNumber }];
    }
    if (sql.includes("WITH ranked_attributes AS")) {
      numericEvidenceSql.push(sql);
      if (parameters.some((parameter) => String(parameter).includes("maximum_capacity_metric"))) {
        return [{ material_number: materialNumber, field_key: "maximum_capacity_metric", value_number: 220, value_unit: "g", canonical_number: 220, canonical_unit: "g", chunk_id: "mc_late_capacity" }];
      }
      if (parameters.some((parameter) => String(parameter).includes("readability_metric"))) {
        return [{ material_number: materialNumber, field_key: "readability_metric", value_number: 0.1, value_unit: "g", canonical_number: 0.1, canonical_unit: "g", chunk_id: "mc_late_readability" }];
      }
      return [{ material_number: materialNumber, field_key: "width_metric", value_number: 300, value_unit: "mm", canonical_number: 300, canonical_unit: "mm", chunk_id: "mc_late_dimension" }];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) {
      return parameters.slice(1).flatMap((id) => chunks[id] ? [chunks[id]] : []);
    }
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [material];
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "Find products with capacity at least 220 g, readability at most 0.1 g, and width at most 300 mm",
    db,
    topK: 6,
  });
  assert.deepEqual(result.retrieval.numeric.eligible_materials, [materialNumber]);
  assert.deepEqual(new Set(result.retrieval.numeric.matches.map((match) => match.id)), new Set(Object.keys(chunks)));
  assert.equal((eligibilitySql.match(/FROM master_attributes AS numeric_/g) ?? []).length, 3);
  assert.doesNotMatch(eligibilitySql, /\bLIMIT\b/);
  const eligibilityCall = db.calls.find((call) => call.sql === eligibilitySql);
  assert.ok(eligibilityCall.parameters.length < 100);
  assert.equal(numericEvidenceSql.length, 3);
  assert.ok(numericEvidenceSql.every((sql) => !sql.includes("JOIN master_chunks AS c")));
  assert.deepEqual(new Set(result.chunks.map((chunk) => chunk.chunk_id)), new Set(Object.keys(chunks)));
});

test("interleaves numeric proof with requested battery and power evidence for shortlisted products", async () => {
  const materialNumbers = ["30000001", "30000002", "30000003"];
  const materials = materialNumbers.map((materialNumber, index) => ({
    material_number: materialNumber,
    trade_name: `BAT${index + 1}`,
    product_name: `Battery balance ${index + 1}`,
    record_json: JSON.stringify({ material_number: materialNumber, fields: {} }),
  }));
  const chunks = Object.fromEntries(materialNumbers.flatMap((materialNumber) => [
    [`cap_${materialNumber}`, { chunk_id: `cap_${materialNumber}`, material_number: materialNumber, chunk_kind: "performance", chunk_ordinal: 1, title: "Capacity", content: "Maximum capacity 220 g", field_keys_json: JSON.stringify(["maximum_capacity_metric"]), metadata_json: "{}" }],
    [`power_${materialNumber}`, { chunk_id: `power_${materialNumber}`, material_number: materialNumber, chunk_kind: "power", chunk_ordinal: 1, title: "Power", content: "Rechargeable battery and AC power", field_keys_json: JSON.stringify(["power_supply"]), metadata_json: "{}" }],
  ]));
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("AS numeric_0")) {
      return materialNumbers.map((material_number) => ({ material_number }));
    }
    if (sql.includes("WITH ranked_attributes AS")) {
      return materialNumbers.map((material_number) => ({
        material_number,
        field_key: "maximum_capacity_metric",
        value_number: 220,
        value_unit: "g",
        canonical_number: 220,
        canonical_unit: "g",
        chunk_id: `cap_${material_number}`,
      }));
    }
    if (sql.includes("FROM master_chunks_fts")) {
      return materialNumbers.map((material_number, index) => ({
        chunk_id: `power_${material_number}`,
        material_number,
        bm25_score: -10 + index,
      }));
    }
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) {
      return parameters.slice(1).flatMap((id) => chunks[id] ? [chunks[id]] : []);
    }
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return materials;
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "Find products with capacity at least 220 g and battery power",
    db,
    chunkLimit: 8,
  });
  for (const materialNumber of materialNumbers) {
    const selectedKinds = result.chunks
      .filter((chunk) => chunk.material_number === materialNumber)
      .map((chunk) => chunk.chunk_kind);
    assert.ok(selectedKinds.includes("performance"), `${materialNumber} should keep numeric proof`);
    assert.ok(selectedKinds.includes("power"), `${materialNumber} should keep battery/power evidence`);
  }
});

test("falls back to lexical retrieval when semantic bindings are unavailable", async () => {
  const recordJson = { material_number: "30680257", fields: { maximum_speed: "1600 rpm" } };
  const row = { material_number: "30680257", trade_name: "E-G21HSRDS", product_name: "Hotplate-Stirrer", record_json: JSON.stringify(recordJson) };
  const chunk = { chunk_id: "mc_hotplate", material_number: "30680257", chunk_kind: "performance", content: "Heating to 380 C and stirring to 1600 rpm.", field_keys_json: JSON.stringify(["maximum_speed"]), metadata_json: "{}" };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [];
    if (sql.includes("FROM master_aliases")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [{ chunk_id: chunk.chunk_id, material_number: chunk.material_number, bm25_score: -5 }];
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return [chunk];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [row];
    return [];
  });
  const result = await retrieveMasterCatalog({ question: "hotplate stirring performance", db });
  assert.equal(result.retrieval.strategy, "lexical");
  assert.equal(result.retrieval.semantic.status, "not_configured");
  assert.match(result.warnings.join(" "), /lexical retrieval was used/i);
});

test("signals unavailable when every applicable D1 retrieval channel fails", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    throw new Error("catalog storage unavailable");
  });

  const result = await retrieveMasterCatalog({ question: "hotplate stirring performance", db });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "catalog_retrieval_unavailable");
  assert.equal("prompt_context" in result, false);
  assert.deepEqual(result.retrieval.d1_health.succeeded_channels, []);
  assert.deepEqual(result.retrieval.d1_health.failed_channels, ["lexical_search"]);
});

test("signals unavailable when vector candidates cannot be hydrated from D1", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_chunks_fts") || sql.includes("FROM master_chunks")) {
      throw new Error("chunk storage unavailable");
    }
    return [];
  });
  const result = await retrieveMasterCatalog({
    question: "hotplate stirring performance",
    db,
    ai: { async run() { return { data: [vector()] }; } },
    index: { async query() { return { matches: [{ id: "mc_hotplate", score: 0.9 }] }; } },
  });

  assert.equal(result.status, "unavailable");
  assert.equal("prompt_context" in result, false);
  assert.deepEqual(result.retrieval.d1_health.failed_channels, ["lexical_search", "ranked_chunk_hydration"]);
});

test("does not treat unhydrated lexical candidate IDs as grounded results", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_chunks_fts")) {
      return [{ chunk_id: "mc_hotplate", material_number: "30680257", bm25_score: -8 }];
    }
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) {
      throw new Error("chunk hydration unavailable");
    }
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "hotplate stirring performance", db });
  assert.equal(result.status, "unavailable");
  assert.equal("prompt_context" in result, false);
  assert.deepEqual(result.retrieval.d1_health.succeeded_channels, ["lexical_search"]);
  assert.deepEqual(result.retrieval.d1_health.failed_channels, ["ranked_chunk_hydration"]);
});

test("preserves authoritative no-results when an applicable D1 query succeeds", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "hotplate stirring performance", db });
  assert.equal(result.status, "no_results");
  assert.equal("prompt_context" in result, true);
  assert.deepEqual(result.retrieval.d1_health.succeeded_channels, ["lexical_search"]);
  assert.deepEqual(result.retrieval.d1_health.failed_channels, []);
});

test("keeps identity but ranks an exact SKU's query-relevant connectivity chunk ahead of applications", async () => {
  const row = { material_number: "30428204", trade_name: "CR221", product_name: "Portable Balance CR221", record_json: JSON.stringify({ material_number: "30428204", fields: {} }) };
  const exactChunks = [
    { chunk_id: "mc_identity", material_number: "30428204", chunk_kind: "identity", chunk_ordinal: 1, title: "CR221 — Identity", content: "Portable Balance CR221", field_keys_json: "[]", metadata_json: "{}" },
    { chunk_id: "mc_applications", material_number: "30428204", chunk_kind: "applications", chunk_ordinal: 1, title: "CR221 — Applications", content: "Basic weighing", field_keys_json: "[]", metadata_json: "{}" },
    { chunk_id: "mc_connectivity", material_number: "30428204", chunk_kind: "connectivity", chunk_ordinal: 1, title: "CR221 — Connectivity", content: "RS232 communication interface", field_keys_json: "[]", metadata_json: "{}" },
  ];
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [row];
    if (sql.includes("FROM master_aliases")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [{ chunk_id: "mc_connectivity", material_number: "30428204", bm25_score: -8 }];
    if (sql.includes("WITH material_chunks AS")) return exactChunks;
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return [exactChunks[2]];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [row];
    return [];
  });
  const result = await retrieveMasterCatalog({
    question: "What communication interfaces does 30428204 support?",
    db,
    chunkLimit: 2,
  });
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunk_kind), ["identity", "connectivity"]);
  assert.equal(result.chunks.some((chunk) => chunk.chunk_kind === "applications"), false);
});

test("balances exact multi-SKU comparisons across identities and the same requested fields", async () => {
  const materialNumbers = ["30428204", "30500000"];
  const rows = materialNumbers.map((materialNumber, index) => ({
    material_number: materialNumber,
    trade_name: index === 0 ? "CR221" : "CR5200",
    product_name: index === 0 ? "Portable Balance CR221" : "Portable Balance CR5200",
    parent_family: "Portable Balances",
    family: "Compass CR",
    record_json: JSON.stringify({ material_number: materialNumber, fields: {} }),
  }));
  const chunks = rows.flatMap((row) => [
    { chunk_id: `${row.material_number}_identity`, material_number: row.material_number, chunk_kind: "identity", chunk_ordinal: 1, title: `${row.trade_name} — Identity`, content: row.product_name, field_keys_json: "[]", metadata_json: "{}" },
    { chunk_id: `${row.material_number}_performance`, material_number: row.material_number, chunk_kind: "performance", chunk_ordinal: 1, title: `${row.trade_name} — Performance`, content: "Capacity and readability", field_keys_json: JSON.stringify(["maximum_capacity_metric", "readability_metric"]), metadata_json: "{}" },
    { chunk_id: `${row.material_number}_power`, material_number: row.material_number, chunk_kind: "power", chunk_ordinal: 1, title: `${row.trade_name} — Power`, content: "Battery and AC adapter power", field_keys_json: JSON.stringify(["power_supply"]), metadata_json: "{}" },
    { chunk_id: `${row.material_number}_physical`, material_number: row.material_number, chunk_kind: "physical", chunk_ordinal: 1, title: `${row.trade_name} — Dimensions`, content: "Width, height, and depth dimensions", field_keys_json: JSON.stringify(["dimensions_metric"]), metadata_json: "{}" },
    { chunk_id: `${row.material_number}_applications`, material_number: row.material_number, chunk_kind: "applications", chunk_ordinal: 1, title: `${row.trade_name} — Applications`, content: "Basic weighing", field_keys_json: "[]", metadata_json: "{}" },
  ]);
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return rows.filter((row) => row.material_number === parameters[1]);
    if (sql.includes("FROM master_aliases")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("WITH material_chunks AS")) return chunks;
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return rows;
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "Compare CR221 and CR5200 for capacity, readability, battery power, and dimensions.",
    identifiers: materialNumbers,
    db,
    chunkLimit: 16,
  });
  assert.ok(result.chunks.length <= 16);
  for (const materialNumber of materialNumbers) {
    const kinds = result.chunks
      .filter((chunk) => chunk.material_number === materialNumber)
      .map((chunk) => chunk.chunk_kind);
    assert.ok(kinds.includes("identity"), `${materialNumber} should retain identity`);
    assert.ok(kinds.includes("performance"), `${materialNumber} should include capacity/readability`);
    assert.ok(kinds.includes("power"), `${materialNumber} should include power`);
    assert.ok(kinds.includes("physical"), `${materialNumber} should include dimensions`);
  }
  assert.deepEqual(result.chunks.slice(0, 2).map((chunk) => chunk.chunk_kind), ["identity", "identity"]);
});

test("uses the available chunk limit only for explicit complete exact-material detail requests", async () => {
  const row = {
    material_number: "30428204",
    trade_name: "CR221",
    product_name: "Portable Balance CR221",
    record_json: JSON.stringify({ material_number: "30428204", fields: {} }),
  };
  const exactChunks = [
    { chunk_id: "mc_identity", material_number: "30428204", chunk_kind: "identity", chunk_ordinal: 1, title: "Identity", content: "CR221", field_keys_json: "[]", metadata_json: "{}" },
    ...Array.from({ length: 7 }, (_item, index) => ({
      chunk_id: `mc_detail_${index + 1}`,
      material_number: "30428204",
      chunk_kind: `detail_${index + 1}`,
      chunk_ordinal: index + 1,
      title: `Detail ${index + 1}`,
      content: `CR221 specification ${index + 1}`,
      field_keys_json: "[]",
      metadata_json: "{}",
    })),
  ];
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [row];
    if (sql.includes("FROM master_chunks_fts")) {
      return Array.from({ length: 8 }, (_item, index) => ({
        chunk_id: `mc_unrelated_${index + 1}`,
        material_number: `9999999${index}`,
        bm25_score: -10 + index,
      }));
    }
    if (sql.includes("WITH material_chunks AS")) return exactChunks;
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) {
      return Array.from({ length: 8 }, (_item, index) => ({
        chunk_id: `mc_unrelated_${index + 1}`,
        material_number: `9999999${index}`,
        chunk_kind: "discovery",
        chunk_ordinal: 1,
        title: `Unrelated ${index + 1}`,
        content: `Other product specification ${index + 1}`,
        field_keys_json: "[]",
        metadata_json: "{}",
      }));
    }
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [row];
    return [];
  });

  const complete = await retrieveMasterCatalog({
    question: "Give me all details and specifications for 30428204",
    db,
    chunkLimit: 8,
  });
  assert.equal(complete.chunks.length, 8);
  assert.ok(complete.chunks.every((chunk) => chunk.material_number === "30428204"));

  for (const exhaustiveQuestion of [
    "Tell me everything about 30428204",
    "Give me every detail for 30428204",
    "Show all available fields for 30428204",
    "Show the complete record for 30428204",
  ]) {
    const exhaustive = await retrieveMasterCatalog({ question: exhaustiveQuestion, db, chunkLimit: 8 });
    assert.equal(exhaustive.chunks.length, 8, exhaustiveQuestion);
  }

  const ordinary = await retrieveMasterCatalog({
    question: "What is 30428204?",
    db,
    chunkLimit: 8,
  });
  assert.equal(ordinary.chunks.length, 3);
});

test("drops unrelated semantic neighbors below the configured score threshold", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });
  const result = await retrieveMasterCatalog({
    question: "quantum zebra",
    db,
    ai: { async run() { return { data: [vector()] }; } },
    index: { async query() { return { matches: [{ id: "mc_unrelated", score: 0.2 }] }; } },
  });
  assert.equal(result.status, "no_results");
  assert.equal(result.retrieval.semantic.matches.length, 0);
  assert.equal(result.retrieval.semantic.discarded_below_threshold, 1);
});

test("adds narrow morphology and intent terms to lexical and semantic discovery", async () => {
  const target = {
    material_number: "83041308",
    trade_name: "BH3",
    product_name: "Bead Genie",
    parent_family: "Bead Mill Homogenizers",
    family: "Bead Genie™",
    record_json: JSON.stringify({ material_number: "83041308", fields: { application: "Cell Lysis; Soil Sample Homogenization" } }),
  };
  const chunk = {
    chunk_id: "bead_genie_applications",
    material_number: target.material_number,
    chunk_kind: "applications",
    chunk_ordinal: 1,
    title: "BH3 — Applications",
    content: "Cell Lysis; Soil Sample Homogenization; compact enough for tight biosafety cabinets",
    field_keys_json: JSON.stringify(["application"]),
    metadata_json: "{}",
  };
  let lexicalQuery = "";
  let semanticText = "";
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_chunks_fts")) {
      lexicalQuery = String(parameters[1]);
      return [{ chunk_id: chunk.chunk_id, material_number: target.material_number, bm25_score: -20 }];
    }
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return [chunk];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [target];
    return [];
  });
  const result = await retrieveMasterCatalog({
    question: "What product would help me break open cells and homogenize soil samples inside a cramped biosafety cabinet?",
    db,
    ai: { async run(_model, input) { semanticText = input.text[0]; return { data: [vector()] }; } },
    index: { async query() { return { matches: [{ id: chunk.chunk_id, score: 0.92 }] }; } },
  });

  for (const term of ["lysis", "homogenization", "sample", "compact", "tight", "cabinets"]) {
    assert.match(lexicalQuery, new RegExp(`"${term}"`));
    assert.match(semanticText, new RegExp(`\\b${term}\\b`, "i"));
  }
  assert.equal(result.chunks[0].material_number, target.material_number);
  assert.ok(result.chunks[0].retrieval.sources.includes("semantic"));
});

test("answers parent-family inventory questions from indexed catalog rows with explicit counts", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("GROUP BY m.parent_family")) return [
      { name: "Accessories", material_count: 803, total_count: 46 },
      { name: "Portable Balances", material_count: 47, total_count: 46 },
      { name: "Precision Balances", material_count: 65, total_count: 46 },
    ];
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "What parent families are available?", db });
  assert.equal(result.status, "ready");
  assert.equal(result.retrieval.strategy, "catalog_scope");
  assert.equal(result.catalog_listing.kind, "parent_families");
  assert.equal(result.catalog_listing.total_count, 46);
  assert.equal(result.catalog_listing.returned_count, 3);
  assert.equal(result.catalog_listing.truncated, true);
  assert.equal(result.prompt_context.catalog_listing.items[1].name, "Portable Balances");
  assert.equal(db.calls.some((call) => call.sql?.includes("GROUP BY m.family")), false);
});

test("lists materials in a named parent family with item numbers and deterministic truncation", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("GROUP BY m.parent_family")) return [
      { name: "Portable Balances", material_count: 47, total_count: 46 },
      { name: "Precision Balances", material_count: 65, total_count: 46 },
    ];
    if (sql.includes("m.parent_family = ?")) {
      assert.equal(parameters[1], "Portable Balances");
      assert.equal(parameters[2], 41);
      return [
        { material_number: "30253005", trade_name: "STX123", product_name: "Portable Balance STX123", parent_family: "Portable Balances", family: "Scout STX", total_count: 47 },
        { material_number: "30428204", trade_name: "CR221", product_name: "Portable Balance CR221", parent_family: "Portable Balances", family: "Compass CR", total_count: 47 },
      ];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "List portable balances", db });
  assert.equal(result.retrieval.strategy, "catalog_scope");
  assert.deepEqual(result.catalog_listing.category, { level: "parent_family", name: "Portable Balances" });
  assert.equal(result.catalog_listing.total_count, 47);
  assert.equal(result.catalog_listing.returned_count, 2);
  assert.equal(result.catalog_listing.truncated, true);
  assert.deepEqual(result.catalog_listing.items.map((item) => item.material_number), ["30253005", "30428204"]);
  assert.equal(result.prompt_context.catalog_listing.items[0].description, "Portable Balance STX123");
});

test("matches trademarked family names when customers omit the trademark symbol", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("GROUP BY m.parent_family")) return [
      { name: "Portable Balances", material_count: 47, total_count: 46 },
    ];
    if (sql.includes("GROUP BY m.family")) return [
      { name: "Compass™ CR", material_count: 4, total_count: 215 },
    ];
    if (sql.includes("m.family = ?")) {
      assert.equal(parameters[1], "Compass™ CR");
      return [
        { material_number: "30428204", trade_name: "CR221", product_name: "Portable Balance CR221", parent_family: "Portable Balances", family: "Compass™ CR", total_count: 2 },
        { material_number: "30428205", trade_name: "CR621", product_name: "Portable Balance CR621", parent_family: "Portable Balances", family: "Compass™ CR", total_count: 2 },
      ];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "Show every Compass CR model in the catalog.", db });
  assert.equal(result.retrieval.strategy, "catalog_scope");
  assert.deepEqual(result.catalog_listing.category, { level: "family", name: "Compass™ CR" });
  assert.deepEqual(result.catalog_listing.items.map((item) => item.material_number), ["30428204", "30428205"]);
});

test("resolves short numeric alternative models only when the question labels the identifier", async () => {
  const alternatives = ["30000001", "30000002", "30000003"].map((materialNumber) => ({
    material_number: materialNumber,
    trade_name: `MODEL-${materialNumber.at(-1)}`,
    product_name: `Product ${materialNumber.at(-1)}`,
    record_json: JSON.stringify({ material_number: materialNumber, fields: { alternative_model: "9123" } }),
    source_file: activeVersion.source_file,
    source_sheet: activeVersion.source_sheet,
  }));
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [];
    if (sql.includes("FROM master_aliases AS a")) return [];
    if (sql.includes("FROM master_attributes AS a") && sql.includes("alternative model")) {
      assert.equal(parameters[1], "9123");
      return alternatives;
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "What is the capacity of alternative model number 9123?", db });
  assert.equal(result.exact_matches.length, 1);
  assert.equal(result.exact_matches[0].status, "ambiguous");
  assert.deepEqual(result.exact_matches[0].candidates.map((item) => item.material_number), alternatives.map((item) => item.material_number));
});

test("does not mistake a six-digit measured capacity for a material number", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  await retrieveMasterCatalog({ question: "Find a balance with capacity at least 120000 g.", db });
  assert.equal(db.calls.some((call) => call.sql?.includes("m.material_number = ?")), false);
  assert.equal(db.calls.some((call) => call.sql?.includes("FROM master_aliases AS a")), false);
  assert.equal(db.calls.some((call) => call.sql?.includes("alternative model")), false);
});

test("does not mistake spaced domain specifications for model aliases and preserves prior-item context", async () => {
  const record = {
    material_number: "30428204",
    trade_name: "CR221",
    product_name: "Portable Balance CR221",
    parent_family: "Portable Balances",
    family: "Compass CR",
    record_json: JSON.stringify({ material_number: "30428204", fields: { ip_rating: "Not Applicable" } }),
    source_file: activeVersion.source_file,
    source_sheet: activeVersion.source_sheet,
  };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) {
      assert.equal(parameters[1], "30428204");
      return [record];
    }
    if (sql.includes("FROM master_chunks") && sql.includes("material_number IN")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  for (const question of [
    "What is its IP 65 rating?",
    "Does it have RS 232?",
    "Is it Class 1?",
    "Can it measure pH 7?",
  ]) {
    const result = await retrieveMasterCatalog({ question, contextMaterials: ["30428204"], db });
    assert.deepEqual(result.exact_matches.map((item) => item.identifier), ["30428204"], question);
  }
  assert.equal(db.calls.some((call) => call.parameters?.includes("ip 65") || call.parameters?.includes("rs 232")), false);
});

test("reconstructs explicitly labeled spaced model aliases before lexical retrieval", async () => {
  const aliases = [
    ["d 33 p 15 b 1 r 1", "30685174", "D33P15B1R1"],
    ["d 2 wqs", "30419628", "D2WQS"],
    ["r a 8 x 2 6 m", "30129559", "R-A8X2/6M"],
    ["v 12 p 3", "30539390", "V12P3"],
    ["e g 21 hp 04 c", "30680262", "E-G21HP04C"],
  ];
  const byCompactAlias = new Map(aliases.map(([alias, materialNumber, tradeName]) => [
    alias.replace(/[^a-z0-9]/gi, "").toLowerCase(),
    {
      material_number: materialNumber,
      trade_name: tradeName,
      product_name: `Product ${tradeName}`,
      record_json: JSON.stringify({ material_number: materialNumber, fields: {} }),
    },
  ]));
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [];
    if (sql.includes("FROM master_aliases AS a")) {
      const match = parameters.map(String).map((value) => value.replaceAll(" ", "")).find((value) => byCompactAlias.has(value));
      return match ? [byCompactAlias.get(match)] : [];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("WITH material_chunks AS")) return [];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) {
      return [...byCompactAlias.values()].filter((row) => parameters.includes(row.material_number));
    }
    return [];
  });

  for (const [alias, materialNumber] of aliases) {
    const result = await retrieveMasterCatalog({
      question: `Which OHAUS material corresponds to the model alias ${alias}?`,
      db,
    });
    assert.equal(result.exact_matches[0]?.status, "found", alias);
    assert.equal(result.exact_matches[0]?.record.material_number, materialNumber, alias);
  }
});

test("ranks paraphrased technical intent ahead of generic application chunks", async () => {
  const row = {
    material_number: "30031707",
    trade_name: "R31P1502",
    product_name: "Compact Scale R31P1502",
    record_json: JSON.stringify({
      material_number: "30031707",
      fields: {
        display: "LCD",
        maximum_capacity_metric: "1.5 kg",
        readability_metric: "0.05 g",
        stabilization_time: "0.5 s",
      },
    }),
  };
  const chunks = [
    { chunk_id: "technical_identity", material_number: row.material_number, chunk_kind: "identity", chunk_ordinal: 1, title: "R31P1502 — Identity", content: "Compact Scale R31P1502", field_keys_json: "[]", metadata_json: "{}" },
    { chunk_id: "technical_applications", material_number: row.material_number, chunk_kind: "applications", chunk_ordinal: 1, title: "R31P1502 — Applications", content: "Basic weighing and counting", field_keys_json: JSON.stringify(["application"]), metadata_json: "{}" },
    { chunk_id: "technical_performance", material_number: row.material_number, chunk_kind: "performance", chunk_ordinal: 1, title: "R31P1502 — Performance", content: "Maximum Capacity: 1.5 kg; Readability: 0.05 g; Stabilization Time: 0.5 s", field_keys_json: JSON.stringify(["maximum_capacity_metric", "readability_metric", "stabilization_time"]), metadata_json: "{}" },
  ];
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [];
    if (sql.includes("FROM master_aliases AS a")) return [row];
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("WITH material_chunks AS")) return chunks;
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [row];
    if (sql.includes("FROM master_attributes") && sql.includes("field_key IN")) return [
      { material_number: row.material_number, field_key: "maximum_capacity_metric", source_header: "Maximum Capacity {metric}", source_column: "GL" },
      { material_number: row.material_number, field_key: "readability_metric", source_header: "Readability {metric}", source_column: "HD" },
      { material_number: row.material_number, field_key: "stabilization_time", source_header: "Stabilization Time", source_column: "JT" },
    ];
    return [];
  });

  for (const question of [
    "How much can R31P1502 weigh at most?",
    "What is the smallest displayed increment for R31P1502?",
    "How quickly does R31P1502 stabilize?",
  ]) {
    const result = await retrieveMasterCatalog({ question, db, chunkLimit: 2 });
    assert.deepEqual(result.chunks.map((chunk) => chunk.chunk_kind), ["identity", "performance"], question);
  }
});

test("filters numeric-qualified category listings and prompt candidates to eligible materials", async () => {
  const eligible = { material_number: "30428204", trade_name: "CR221", product_name: "Portable Balance CR221", parent_family: "Portable Balances", family: "Compass CR", record_json: JSON.stringify({ material_number: "30428204", fields: {} }) };
  const ineligible = { material_number: "30253005", trade_name: "STX123", product_name: "Portable Balance STX123", parent_family: "Portable Balances", family: "Scout STX", record_json: JSON.stringify({ material_number: "30253005", fields: {} }) };
  const capacityChunk = { chunk_id: "mc_capacity_eligible", material_number: eligible.material_number, chunk_kind: "performance", chunk_ordinal: 1, title: "Capacity", content: "Maximum capacity 220 g", field_keys_json: JSON.stringify(["maximum_capacity_metric"]), metadata_json: "{}" };
  let filteredListingCall = null;
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("GROUP BY m.parent_family")) {
      return [{ name: "Portable Balances", material_count: 2, total_count: 1 }];
    }
    if (sql.includes("SELECT m.material_number") && sql.includes("AS numeric_0")) {
      return [{ material_number: eligible.material_number }];
    }
    if (sql.includes("WITH ranked_attributes AS")) {
      return [{ material_number: eligible.material_number, field_key: "maximum_capacity_metric", value_number: 220, value_unit: "g", canonical_number: 220, canonical_unit: "g", chunk_id: capacityChunk.chunk_id }];
    }
    if (sql.includes("m.parent_family = ?") && sql.includes("m.material_number IN") && sql.includes("json_each(?)")) {
      filteredListingCall = { sql, parameters };
      return [{ ...eligible, total_count: 1 }];
    }
    if (sql.includes("m.parent_family = ?")) {
      return [{ ...ineligible, total_count: 2 }, { ...eligible, total_count: 2 }];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return [capacityChunk];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [eligible];
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "List portable balances with capacity at least 220 g",
    db,
  });
  assert.deepEqual(result.retrieval.numeric.eligible_materials, [eligible.material_number]);
  assert.deepEqual(result.catalog_listing.items.map((item) => item.material_number), [eligible.material_number]);
  assert.deepEqual(result.prompt_context.catalog_listing.items.map((item) => item.material_number), [eligible.material_number]);
  assert.equal(result.catalog_listing.numeric_filter_applied, true);
  assert.ok(filteredListingCall);
  assert.deepEqual(JSON.parse(filteredListingCall.parameters[2]), [eligible.material_number]);
});

test("withholds an unfiltered category listing when numeric retrieval falls back", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("GROUP BY m.parent_family")) {
      return [{ name: "Portable Balances", material_count: 1, total_count: 1 }];
    }
    if (sql.includes("SELECT m.material_number") && sql.includes("AS numeric_0")) {
      throw new Error("numeric store unavailable");
    }
    if (sql.includes("m.parent_family = ?")) {
      return [{ material_number: "30253005", trade_name: "STX123", product_name: "Portable Balance STX123", parent_family: "Portable Balances", family: "Scout STX", total_count: 1 }];
    }
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "List portable balances with capacity at least 220 g",
    db,
  });
  assert.equal(result.retrieval.numeric.status, "fallback");
  assert.equal(result.catalog_listing.status, "fallback");
  assert.deepEqual(result.catalog_listing.items, []);
  assert.equal(result.catalog_listing.reason, "numeric_filter_unavailable");
  assert.match(result.warnings.join(" "), /unfiltered category candidates were withheld/i);
});

test("resolves full relationship subjects and supports hyphenated spare-part wording", async () => {
  assert.deepEqual(requestedMasterRelationshipTypes("Which spare-part numbers are listed?"), ["spare_parts"]);
  assert.deepEqual(requestedMasterRelationshipTypes("Which replacement-part numbers are listed?"), ["spare_parts"]);

  const cases = [
    {
      question: "Which service codes are linked to Load Cell 0785-22kg 0.18m C3?",
      alias: "Load Cell 0785-22kg 0.18m C3",
      material: "62031509",
      type: "services",
      related: "B39910002",
    },
    {
      question: "Which spare-part material numbers are listed for R-A30X2/13MS?",
      alias: "R-A30X2/13MS",
      material: "30130872",
      type: "spare_parts",
      related: "30304365",
    },
    {
      question: "Which upsell material numbers are listed for Weight Set ASTM (2)200g-1mg UC NonAd TR?",
      alias: "Weight Set ASTM (2)200g-1mg UC NonAd TR",
      material: "30390012",
      type: "upsellings",
      related: "30390016",
    },
  ];
  const rows = new Map(cases.map((entry) => [entry.material, {
    material_number: entry.material,
    trade_name: entry.alias,
    product_name: entry.alias,
    record_json: JSON.stringify({ material_number: entry.material, fields: {} }),
  }]));
  const aliases = new Map(cases.map((entry) => [normalizeCatalogIdentifier(entry.alias), rows.get(entry.material)]));
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [];
    if (sql.includes("FROM master_aliases AS a")) {
      const match = parameters.map(String).find((value) => aliases.has(value));
      return match ? [aliases.get(match)] : [];
    }
    if (sql.includes("FROM master_attributes AS a") && sql.includes("alternative model")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("WITH material_chunks AS")) return [];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) {
      return [...rows.values()].filter((row) => parameters.includes(row.material_number));
    }
    if (sql.includes("FROM master_relationships")) {
      const entry = cases.find((candidate) => parameters.includes(candidate.material));
      assert.ok(entry);
      assert.ok(parameters.includes(entry.type));
      return [{
        source_material_number: entry.material,
        relationship_type: entry.type,
        target_material_number: entry.related,
        target_resolved: 1,
      }];
    }
    return [];
  });

  for (const entry of cases) {
    const result = await retrieveMasterCatalog({ question: entry.question, db });
    assert.equal(result.exact_matches.some((match) => match.record?.material_number === entry.material), true, entry.question);
    assert.deepEqual(result.retrieval.numeric.constraints, [], entry.question);
    assert.equal(result.relationships[0]?.related_material_number, entry.related, entry.question);

    const rawQuestion = entry.question.replace(/\?$/, "");
    const expandedQuestion = `${rawQuestion} ${entry.type.replaceAll("_", " ")} relationship`;
    const routeShapedResult = await retrieveMasterCatalog({
      question: expandedQuestion,
      rawQuestion,
      db,
    });
    assert.equal(
      routeShapedResult.exact_matches.some((match) => match.record?.material_number === entry.material),
      true,
      `${entry.question} through expanded public retrieval`,
    );
    assert.deepEqual(routeShapedResult.retrieval.numeric.constraints, [], entry.question);
    assert.equal(routeShapedResult.relationships[0]?.related_material_number, entry.related, entry.question);
  }
});

test("expands only requested relationships and documents using master schema columns", async () => {
  const row = { material_number: "30253005", trade_name: "STX123", product_name: "Portable Balance STX123", record_json: JSON.stringify({ material_number: "30253005", fields: {} }) };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [row];
    if (sql.includes("FROM master_aliases")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("FROM master_chunks") && sql.includes("material_number IN")) return [];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [row];
    if (sql.includes("FROM master_relationships")) {
      assert.ok(parameters.includes("accessories"));
      return [{ source_material_number: "30253005", relationship_type: "accessories", target_material_number: "30467763", target_resolved: 1, source_field: "relationship_accessories", target_product_name: "AC Adapter" }];
    }
    if (sql.includes("FROM master_documents")) return [{ material_number: "30253005", document_type: "manual", url: "https://example.test/manual", source_field: "manual_url" }];
    return [];
  });
  const result = await retrieveMasterCatalog({ question: "What accessories and manuals are listed for STX123?", identifiers: ["30253005"], db });
  assert.equal(result.relationships[0].target_resolved, 1);
  assert.equal(result.relationships[0].target_material_number, "30467763");
  assert.equal(result.documents[0].document_type, "manual");
});

test("uses the reverse relationship index to find products that reference an accessory", async () => {
  const accessory = {
    material_number: "30467763",
    trade_name: "AC Adapter",
    product_name: "Adapter accessory",
    record_json: JSON.stringify({ material_number: "30467763", fields: {} }),
  };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return parameters[1] === "30467763" ? [accessory] : [];
    if (sql.includes("FROM master_aliases")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("FROM master_chunks") && sql.includes("material_number IN")) return [];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [accessory];
    if (sql.includes("FROM master_relationships")) {
      assert.match(sql, /r\.target_material_number IN/);
      assert.match(sql, /INDEXED BY master_relationships_target/);
      assert.doesNotMatch(sql, /AND r\.source_material_number IN/);
      assert.ok(parameters.includes("accessories"));
      return [{
        source_material_number: "30253005",
        relationship_type: "accessories",
        target_material_number: "30467763",
        target_resolved: 1,
        source_model: "STX123",
        source_product_name: "Portable Balance STX123",
        target_model: "AC Adapter",
      }];
    }
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "Which products use accessory 30467763?", db });
  assert.equal(result.relationships[0].direction, "inbound");
  assert.equal(result.relationships[0].matched_material_number, "30467763");
  assert.equal(result.relationships[0].related_material_number, "30253005");
  assert.equal(result.prompt_context.relationships[0].direction, "inbound");
  assert.equal(result.prompt_context.relationships[0].source_product_name, "Portable Balance STX123");
});

test("reserves the relationship row budget for an exact material instead of lexical neighbors", async () => {
  const requestedMaterial = "30268982";
  const noisyNeighbor = "10000000";
  const accessory = {
    material_number: requestedMaterial,
    trade_name: "RS232 Interface, Scout",
    product_name: "Scout RS232 accessory",
    record_json: JSON.stringify({ material_number: requestedMaterial, fields: {} }),
  };
  const neighbor = {
    material_number: noisyNeighbor,
    trade_name: "RS232 Cable",
    product_name: "Semantically similar cable",
    record_json: JSON.stringify({ material_number: noisyNeighbor, fields: {} }),
  };
  const neighborChunk = {
    chunk_id: "mc_noisy_rs232_neighbor",
    material_number: noisyNeighbor,
    chunk_kind: "connectivity",
    chunk_ordinal: 1,
    title: "RS232 Cable",
    content: "RS232 interface cable accessory",
    field_keys_json: "[]",
    metadata_json: "{}",
  };
  const relationshipRowsFor = (targetMaterial, sourceStart) => Array.from({ length: 80 }, (_, index) => ({
    source_material_number: String(sourceStart + index),
    relationship_type: "accessories",
    target_material_number: targetMaterial,
    target_resolved: 1,
    source_model: `MODEL-${index + 1}`,
    source_product_name: `Compatible model ${index + 1}`,
    target_model: targetMaterial === requestedMaterial ? accessory.trade_name : neighbor.trade_name,
  }));
  const exactRelationships = relationshipRowsFor(requestedMaterial, 92000000);
  const noisyRelationships = relationshipRowsFor(noisyNeighbor, 11000000);

  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return parameters[1] === requestedMaterial ? [accessory] : [];
    if (sql.includes("FROM master_chunks_fts")) {
      return [{ chunk_id: neighborChunk.chunk_id, material_number: noisyNeighbor, bm25_score: -12 }];
    }
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return [neighborChunk];
    if (sql.includes("WITH material_chunks AS")) return [];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [accessory, neighbor];
    if (sql.includes("FROM master_relationships")) {
      const requestedTargets = [requestedMaterial, noisyNeighbor].filter((material) => parameters.includes(material));
      return [...noisyRelationships, ...exactRelationships]
        .filter((row) => requestedTargets.includes(row.target_material_number))
        .sort((left, right) => left.source_material_number.localeCompare(right.source_material_number))
        .slice(0, Number(parameters.at(-1)));
    }
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: `Which models are compatible with ${requestedMaterial}?`,
    db,
    relationshipLimit: 80,
  });

  const relationshipCall = db.calls.find((call) => call.sql?.includes("FROM master_relationships"));
  assert.ok(relationshipCall);
  assert.ok(relationshipCall.parameters.includes(requestedMaterial));
  assert.equal(relationshipCall.parameters.includes(noisyNeighbor), false);
  assert.equal(result.relationships.length, 80);
  assert.ok(result.relationships.every((row) => row.matched_material_number === requestedMaterial));
  assert.equal(result.relationships_truncated, false);
});

test("keeps up to eighty relationships in model grounding context", () => {
  const relationships = Array.from({ length: 90 }, (_, index) => ({
    direction: "inbound",
    matched_material_number: "30268982",
    related_material_number: String(92000000 + index),
    source_material_number: String(92000000 + index),
    relationship_type: "accessories",
    target_material_number: "30268982",
    target_resolved: 1,
  }));
  const prompt = buildMasterCatalogPromptContext({
    version: { version_id: "test-version" },
    retrieval: { strategy: "exact", numeric: { constraints: [], matches: [] } },
    exact_matches: [],
    materials: [],
    chunks: [],
    evidence: [],
    relationships,
    documents: [],
    warnings: [],
  });
  assert.equal(prompt.relationships.length, 80);
  assert.equal(prompt.relationships[79].related_material_number, "92000079");
});

test("keeps successful optional enrichments when another enrichment fails", async () => {
  const row = { material_number: "30253005", trade_name: "STX123", product_name: "Portable Balance STX123", record_json: JSON.stringify({ material_number: "30253005", fields: {} }) };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("m.material_number = ?")) return [row];
    if (sql.includes("FROM master_aliases")) return [];
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("FROM master_chunks") && sql.includes("material_number IN")) return [];
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return [row];
    if (sql.includes("FROM master_relationships")) return [{ source_material_number: "30253005", relationship_type: "accessories", target_material_number: "30467763", target_resolved: 1 }];
    if (sql.includes("FROM master_documents")) throw new Error("document store temporarily unavailable");
    return [];
  });

  const result = await retrieveMasterCatalog({ question: "Show accessories and manuals for 30253005", db });
  assert.equal(result.relationships[0].target_material_number, "30467763");
  assert.deepEqual(result.documents, []);
  assert.match(result.warnings.join(" "), /document expansion unavailable.*temporarily unavailable/i);
});

test("compact evidence protects operational fields unless explicitly requested by the caller", () => {
  const args = {
    question: "What is the procurement type?",
    materials: [{ material_number: "30428204", model: "CR221", fields: { procurement_type: "F" } }],
    chunks: [{ material_number: "30428204", source_fields: ["procurement_type"] }],
  };
  assert.equal(selectCompactEvidence(args).some((item) => item.field === "fields.procurement_type"), false);
  assert.equal(selectCompactEvidence({ ...args, includeInternalFields: true }).some((item) => item.field === "fields.procurement_type"), true);
});

test("keeps sibling technical fields when a catalog fields map contains a display column", () => {
  const evidence = selectCompactEvidence({
    question: "What are the capacity and readability?",
    materials: [{
      material_number: "30428205",
      model: "CR621",
      fields: {
        display: "LCD",
        maximum_capacity_metric: "620 g",
        readability_metric: "0.1 g",
        wrapped_capacity: { display: "620 g", value: 620, unit: "g" },
      },
    }],
    chunks: [{
      material_number: "30428205",
      source_fields: ["maximum_capacity_metric", "readability_metric", "wrapped_capacity"],
    }],
    attributes: [
      { material_number: "30428205", field_key: "maximum_capacity_metric", source_header: "Maximum Capacity {metric}", source_column: "GL" },
      { material_number: "30428205", field_key: "readability_metric", source_header: "Readability {metric}", source_column: "HD" },
      { material_number: "30428205", field_key: "wrapped_capacity", source_header: "Wrapped Capacity", source_column: "ZZ" },
    ],
  });

  assert.equal(evidence.find((item) => item.field === "fields.maximum_capacity_metric")?.value, "620 g");
  assert.equal(evidence.find((item) => item.field === "fields.readability_metric")?.source_header, "Readability {metric}");
  assert.equal(evidence.find((item) => item.field === "fields.wrapped_capacity")?.value, "620 g");
  assert.equal(evidence.some((item) => item.field === "fields"), false);
});

test("compacts only the standard embedding prefix while preserving every value", () => {
  const text = boundedEmbeddingText([
    "Category: Balances & Scales",
    "Family: Compass CR",
    "Material number: 30428204",
    "Product: CR221 Portable Balance",
    "Section: Performance Specifications",
    "Maximum Capacity (g): 220 g",
    "Product: this body label must remain",
  ].join("\n"));

  assert.equal(
    text,
    "Balances & Scales Family: Compass CR 30428204 CR221 Portable Balance "
      + "Performance Specifications Maximum Capacity (g): 220 g Product: this body label must remain",
  );
  for (const value of [
    "Balances & Scales",
    "Compass CR",
    "30428204",
    "CR221 Portable Balance",
    "Performance Specifications",
  ]) {
    assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(text, /Category:|Material number:/);
  assert.match(text, /Family: Compass CR/);
});

test("bounds compacted embedding input by words and characters", () => {
  const prefix = [
    "Category: Balances & Scales",
    "Family: Compass CR",
    "Material number: 30428204",
    "Product: CR221 Portable Balance",
    "Section: Performance Specifications",
  ].join("\n");
  const text = boundedEmbeddingText(`${prefix}\n${Array.from({ length: 600 }, (_, index) => `field${index}`).join(" ")}`);

  assert.ok(text.split(/\s+/).length <= 420);
  assert.ok(text.length <= 1_800);
});

test("pins evidence for each item in a small filtered numeric family listing", async () => {
  const capacities = new Map([
    ["30253008", "420 g"], ["30253009", "620 g"],
    ["30253012", "420 g"], ["30253013", "620 g"],
  ]);
  const products = [...capacities].map(([materialNumber, capacity]) => ({
    material_number: materialNumber,
    trade_name: `STX-${materialNumber}`,
    product_name: `Scout STX ${materialNumber}`,
    parent_family: "Portable Balances",
    family: "Scout™ STX",
    record_json: JSON.stringify({ material_number: materialNumber, fields: { display: "LCD", maximum_capacity_metric: capacity } }),
  }));
  const chunks = products.flatMap((product) => [
    { chunk_id: `${product.material_number}_identity`, material_number: product.material_number, chunk_kind: "identity", chunk_ordinal: 1, title: "Identity", content: product.product_name, field_keys_json: "[]", metadata_json: "{}" },
    { chunk_id: `${product.material_number}_performance`, material_number: product.material_number, chunk_kind: "performance", chunk_ordinal: 1, title: "Performance", content: `Maximum Capacity: ${capacities.get(product.material_number)}`, field_keys_json: JSON.stringify(["maximum_capacity_metric"]), metadata_json: "{}" },
  ]);
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("master_attributes AS numeric_0")) {
      return products.map(({ material_number }) => ({ material_number }));
    }
    if (sql.includes("WITH ranked_attributes AS")) {
      return products.slice(0, 2).map((product) => ({
        material_number: product.material_number,
        field_key: "maximum_capacity_metric",
        value_number: Number.parseFloat(capacities.get(product.material_number)),
        value_unit: "g",
        canonical_number: Number.parseFloat(capacities.get(product.material_number)),
        canonical_unit: "g",
        chunk_id: `${product.material_number}_performance`,
      }));
    }
    if (sql.includes("GROUP BY m.parent_family")) return [];
    if (sql.includes("GROUP BY m.family")) return [{ name: "Scout™ STX", material_count: 4, total_count: 1 }];
    if (sql.includes("m.family = ?") && sql.includes("json_each(?)")) {
      const allowed = new Set(JSON.parse(parameters[2]));
      return products.filter((product) => allowed.has(product.material_number)).map((product) => ({ ...product, total_count: allowed.size }));
    }
    if (sql.includes("m.family = ?")) return products.map((product) => ({ ...product, total_count: products.length }));
    if (sql.includes("FROM master_chunks_fts")) return [];
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return chunks.filter((chunk) => parameters.includes(chunk.chunk_id));
    if (sql.includes("WITH material_chunks AS")) return chunks.filter((chunk) => parameters.includes(chunk.material_number));
    if (sql.includes("FROM master_materials AS m") && sql.includes("material_number IN")) return products.filter((product) => parameters.includes(product.material_number));
    if (sql.includes("FROM master_attributes") && sql.includes("field_key IN")) return products.map((product) => ({
      material_number: product.material_number,
      field_key: "maximum_capacity_metric",
      source_header: "Maximum Capacity {metric}",
      source_column: "GL",
    }));
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "Which Scout STX models have a maximum capacity between 400 g and 700 g?",
    db,
  });
  assert.deepEqual(result.exact_matches, []);
  assert.deepEqual(result.catalog_listing.items.map((item) => item.material_number), [...capacities.keys()]);
  for (const [materialNumber, capacity] of capacities) {
    const item = result.evidence.find((entry) => entry.material_number === materialNumber && entry.source_header === "Maximum Capacity {metric}");
    assert.equal(item?.value, capacity, materialNumber);
  }
});

test("returns proven scoped numeric emptiness without unrelated chunks", async () => {
  const familyItems = [{ material_number: "30428205", trade_name: "CR621", product_name: "Compass CR621", family: "Compass™ CR" }];
  const decoy = { chunk_id: "decoy", material_number: "80000003", chunk_kind: "performance", title: "Unrelated", content: "Capacity 740 g", field_keys_json: "[]", metadata_json: "{}" };
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("master_attributes AS numeric_0")) return [];
    if (sql.includes("GROUP BY m.parent_family")) return [];
    if (sql.includes("GROUP BY m.family")) return [{ name: "Compass™ CR", material_count: 1, total_count: 1 }];
    if (sql.includes("m.family = ?") && sql.includes("json_each(?)")) return [];
    if (sql.includes("m.family = ?")) return familyItems;
    if (sql.includes("FROM master_chunks_fts")) return [{ chunk_id: decoy.chunk_id, material_number: decoy.material_number, bm25_score: -20 }];
    if (sql.includes("FROM master_chunks") && sql.includes("chunk_id IN")) return [decoy];
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "Which Compass CR models have a maximum capacity between 700 g and 800 g?",
    db,
  });
  assert.deepEqual(result.exact_matches, []);
  assert.equal(result.status, "no_results");
  assert.equal(result.catalog_listing.status, "no_results");
  assert.deepEqual(result.chunks, []);
  assert.deepEqual(result.materials, []);
});

test("does not claim no results when fallback category filtering saw only a truncated window", async () => {
  const familyItems = Array.from({ length: 40 }, (_, index) => ({
    material_number: String(70000000 + index),
    trade_name: `CR${index + 1}`,
    product_name: `Compass CR${index + 1}`,
    family: "Compass™ CR",
    total_count: 41,
  }));
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("SELECT m.material_number") && sql.includes("master_attributes AS numeric_0")) {
      return [{ material_number: "79999999" }];
    }
    if (sql.includes("WITH ranked_attributes AS")) return [];
    if (sql.includes("GROUP BY m.parent_family")) return [];
    if (sql.includes("GROUP BY m.family")) return [{ name: "Compass™ CR", material_count: 41, total_count: 1 }];
    if (sql.includes("m.family = ?") && sql.includes("json_each(?)")) throw new Error("temporary filtered listing failure");
    if (sql.includes("m.family = ?")) return familyItems;
    if (sql.includes("FROM master_chunks_fts")) return [];
    return [];
  });

  const result = await retrieveMasterCatalog({
    question: "Which Compass CR models have a maximum capacity between 700 g and 800 g?",
    db,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.catalog_listing.status, "fallback");
  assert.equal(result.catalog_listing.reason, "numeric_category_filter_incomplete");
  assert.deepEqual(result.catalog_listing.items, []);
  assert.equal(result.prompt_context, undefined);
  assert.ok(result.retrieval.d1_health.failed_channels.includes("numeric_catalog_listing"));
});

test("seeds the pending progress queue idempotently in a deterministic namespace", async () => {
  const rows = [{
    chunk_id: "mc_30428204_spec", vector_id: "mc_30428204_spec", attempts: 0,
    material_number: "30428204", chunk_kind: "performance", parent_family: "Balances & Scales",
    family: "Compass CR", content: "CR221 maximum capacity 220 g.",
    metadata_json: JSON.stringify({ source_sheet: activeVersion.source_sheet, source_row: 122 }),
  }];
  let seeded = false;
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("JOIN master_chunks AS c") && sql.includes("p.status IN")) return seeded ? [] : rows;
    if (sql.startsWith("UPDATE master_vector_seed_progress")) {
      assert.equal(parameters[0], "seeded");
      assert.equal(parameters[3], activeVersion.version_id);
      seeded = true;
      return { success: true };
    }
    if (sql.includes("COUNT(*) AS total")) return seeded
      ? { total: 1, seeded: 1, pending: 0, failed: 0 }
      : { total: 1, seeded: 0, pending: 1, failed: 0 };
    return [];
  });
  const calls = [];
  const ai = { async run(model, input) { calls.push({ model, input }); return { data: [vector()] }; } };
  const index = { async upsert(vectors) { calls.push({ vectors }); return { mutationId: "mutation-master-1" }; } };
  const result = await seedMasterVectorizeBatch({ db, ai, index, versionId: activeVersion.version_id, batchSize: 4 });
  assert.equal(calls[0].model, MASTER_EMBEDDING_MODEL);
  assert.equal(calls[0].input.pooling, MASTER_EMBEDDING_POOLING);
  assert.equal(calls[1].vectors[0].namespace, namespace);
  assert.equal(calls[1].vectors[0].values.length, 384);
  assert.equal(result.seeded, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.complete, true);
  assert.equal(result.progress_exact, true);
  assert.equal(result.mutation_id, "mutation-master-1");
});

test("defers the full seed-progress aggregate after an ordinary full batch", async () => {
  const rows = ["one", "two"].map((suffix, index) => ({
    chunk_id: `mc_${suffix}`,
    vector_id: `mc_${suffix}`,
    attempts: 0,
    material_number: `3042820${index + 4}`,
    chunk_kind: "performance",
    parent_family: "Balances & Scales",
    family: "Compass CR",
    content: `Catalog chunk ${suffix}.`,
    metadata_json: JSON.stringify({ source_sheet: activeVersion.source_sheet, source_row: 122 + index }),
  }));
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("JOIN master_chunks AS c") && sql.includes("p.status IN")) return rows;
    if (sql.startsWith("UPDATE master_vector_seed_progress")) return { success: true };
    if (sql.includes("COUNT(*) AS total")) {
      throw new Error("ordinary batches must not scan the full seed queue");
    }
    return [];
  });
  const result = await seedMasterVectorizeBatch({
    db,
    ai: { async run() { return { data: rows.map(() => vector()) }; } },
    index: { async upsert() { return { mutationId: "mutation-master-full" }; } },
    versionId: activeVersion.version_id,
    batchSize: rows.length,
  });

  assert.equal(result.seeded, rows.length);
  assert.equal(result.complete, false);
  assert.equal(result.progress_exact, false);
  assert.equal(result.seeded_total, null);
  assert.equal(result.remaining, null);
  assert.equal(result.total, null);
  assert.equal(result.failed, null);
  assert.equal(db.calls.some((call) => call.sql?.includes("COUNT(*) AS total")), false);
});

test("uses an exact aggregate when no eligible seed rows remain", async () => {
  let progressQueries = 0;
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("JOIN master_chunks AS c") && sql.includes("p.status IN")) return [];
    if (sql.includes("COUNT(*) AS total")) {
      progressQueries += 1;
      return { total: 3, seeded: 2, pending: 0, failed: 1 };
    }
    return [];
  });
  const result = await seedMasterVectorizeBatch({
    db,
    ai: { async run() { throw new Error("empty queues must not embed"); } },
    index: { async upsert() { throw new Error("empty queues must not upsert"); } },
    versionId: activeVersion.version_id,
    batchSize: 2,
  });

  assert.equal(result.status, "stalled");
  assert.equal(result.seeded, 0);
  assert.equal(result.seeded_total, 2);
  assert.equal(result.remaining, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.complete, false);
  assert.equal(result.progress_exact, true);
  assert.equal(progressQueries, 1);
});

test("rejects overlong queued Vectorize IDs before embedding", async () => {
  const db = createDb((sql, parameters, method) => {
    const version = versionHandler(sql, parameters, method);
    if (version !== undefined) return version;
    if (sql.includes("JOIN master_chunks AS c") && sql.includes("p.status IN")) return [{ chunk_id: "mc_short", vector_id: "x".repeat(65), content: "bad id" }];
    return [];
  });
  let embedded = false;
  await assert.rejects(
    () => seedMasterVectorizeBatch({ db, ai: { async run() { embedded = true; return { data: [vector()] }; } }, index: { async upsert() {} }, versionId: activeVersion.version_id }),
    /at most 64 bytes/,
  );
  assert.equal(embedded, false);
});

function activationCounts(version, overrides = {}) {
  return {
    material_count: version.material_count,
    alias_count: version.alias_count,
    attribute_count: version.attribute_count,
    relationship_count: version.relationship_count,
    document_count: version.document_count,
    chunk_count: version.chunk_count,
    fts_count: version.chunk_count,
    seed_queue_count: version.chunk_count,
    ...overrides,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredEvaluationProfile(version) {
  const profile = {
    profile_version: "2.0.0",
    fingerprint_schema_version: "1.0.0",
    fixture_sha256: "b".repeat(64),
    fixture_schema_version: "master-catalog-retrieval-eval-v2",
    source_sha256: version.source_sha256,
    fixture_case_count: 101,
    raw_fixture_case_count: 107,
    unsupported_case_count: 6,
    retrieval_build: {
      retrieval_code_sha256: "c".repeat(64),
      code_files: [
        { path: "lib/master-catalog-rag.mjs", sha256: "d".repeat(64) },
        { path: "app/api/sales/route.ts", sha256: "e".repeat(64) },
        { path: "scripts/evaluate-master-retrieval.mjs", sha256: "f".repeat(64) },
        { path: "scripts/verify-master-retrieval-profile.mjs", sha256: "1".repeat(64) },
        { path: "scripts/build-master-retrieval-eval.py", sha256: "2".repeat(64) },
      ],
      bundle_version: MASTER_CATALOG_BUNDLE_VERSION,
      default_top_k: MASTER_DEFAULT_TOP_K,
      default_chunk_limit: MASTER_DEFAULT_CHUNK_LIMIT,
      semantic_score_threshold: MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD,
      embedding: {
        model: MASTER_EMBEDDING_MODEL,
        pooling: MASTER_EMBEDDING_POOLING,
        dimensions: MASTER_EMBEDDING_DIMENSIONS,
      },
      vectorize: {
        binding: "CATALOG_VECTORIZE",
        index_name: MASTER_VECTORIZE_INDEX,
        dimensions: MASTER_EMBEDDING_DIMENSIONS,
        metric: MASTER_VECTORIZE_METRIC,
      },
    },
  };
  const payload = {
    fingerprint_schema_version: profile.fingerprint_schema_version,
    fixture: {
      sha256: profile.fixture_sha256,
      schema_version: profile.fixture_schema_version,
      source_sha256: profile.source_sha256,
      required_case_count: profile.fixture_case_count,
      raw_case_count: profile.raw_fixture_case_count,
      unsupported_case_count: profile.unsupported_case_count,
    },
    retrieval_build: profile.retrieval_build,
  };
  profile.retrieval_profile_sha256 = createHash("sha256").update(canonicalize(payload)).digest("hex");
  return profile;
}

function passingEvaluation(version, overrides = {}) {
  const profile = requiredEvaluationProfile(version);
  return {
    version_id: version.version_id,
    fixture_sha256: profile.fixture_sha256,
    fixture_schema_version: profile.fixture_schema_version,
    source_sha256: version.source_sha256,
    retrieval_profile_sha256: profile.retrieval_profile_sha256,
    fixture_case_count: 101,
    evaluated_count: 101,
    passed_count: 101,
    failed_count: 0,
    status: "passed",
    evaluated_at: "2026-09-02T18:00:00.000Z",
    details_json: "{}",
    ...overrides,
  };
}

test("validates counts and evaluation, samples 32 vectors, then flips state in race-safe order", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  const sampleGroups = {
    earliest: Array.from({ length: 16 }, (_item, index) => ({ vector_id: `mc_early_${index}` })),
    latest: Array.from({ length: 16 }, (_item, index) => ({ vector_id: `mc_late_${index}` })),
    recent: Array.from({ length: 16 }, (_item, index) => ({ vector_id: `mc_recent_${index}` })),
  };
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?") && !sql.includes("AS target")) return stagedVersion;
    if (sql.includes("FROM master_catalog_evaluations") && sql.includes("ORDER BY evaluated_at")) return passingEvaluation(stagedVersion);
    if (sql.includes("AS seed_queue_count")) return activationCounts(stagedVersion);
    if (sql.includes("COUNT(*) AS total")) return { total: stagedVersion.chunk_count, seeded: stagedVersion.chunk_count, pending: 0, failed: 0 };
    if (sql.includes("SELECT p.vector_id")) {
      if (sql.includes("ORDER BY p.updated_at DESC")) return sampleGroups.recent;
      if (sql.includes("ORDER BY p.chunk_id DESC")) return sampleGroups.latest;
      return sampleGroups.earliest;
    }
    if (sql.includes("target.status AS target_status")) {
      return { target_status: "active", activated_at: "2026-09-02T18:01:00.000Z", active_version_id: stagedVersion.version_id, active_version_count: 1 };
    }
    return [];
  });
  let queryByIdCalls = 0;
  let sampledIds = [];
  const result = await activateMasterCatalogVersion({
    db,
    index: {
      async queryById(id, options) {
        queryByIdCalls += 1;
        sampledIds.push(id);
        assert.equal(options.namespace, namespace);
        assert.equal(options.topK, 1);
        return { matches: [{ id, namespace }] };
      },
    },
    versionId: stagedVersion.version_id,
    requiredEvaluation: requiredEvaluationProfile(stagedVersion),
    visibilityDelayMs: 0,
  });
  assert.equal(queryByIdCalls, 32);
  assert.equal(sampledIds.length, 32);
  assert.ok(sampledIds.some((id) => id.startsWith("mc_early_")));
  assert.ok(sampledIds.some((id) => id.startsWith("mc_late_")));
  assert.ok(sampledIds.some((id) => id.startsWith("mc_recent_")));
  assert.equal(result.status, "active");
  assert.equal(result.namespace, namespace);
  assert.equal(result.validated_counts.fts_count, stagedVersion.chunk_count);
  assert.equal(result.evaluation.fixture_case_count, 101);
  const batch = db.calls.find((call) => call.method === "batch");
  assert.equal(batch.statements.length, 3);
  for (const statement of batch.statements) {
    assert.equal(statement.parameters.length, statement.sql.match(/\?/g)?.length ?? 0);
  }
  assert.match(batch.statements[0].sql, /SET status = 'active'/);
  assert.match(batch.statements[0].sql, /status = 'staged'/);
  assert.match(batch.statements[0].sql, /master_catalog_evaluations/);
  assert.match(batch.statements[0].sql, /e\.fixture_schema_version = \?/);
  assert.match(batch.statements[0].sql, /e\.fixture_case_count = \?/);
  assert.match(batch.statements[0].sql, /e\.retrieval_profile_sha256 = \?/);
  assert.match(batch.statements[0].sql, /latest\.fixture_sha256 = e\.fixture_sha256/);
  assert.match(batch.statements[0].sql, /latest\.retrieval_profile_sha256 = e\.retrieval_profile_sha256/);
  assert.match(batch.statements[1].sql, /UPDATE master_catalog_state/);
  assert.match(batch.statements[1].sql, /target\.activated_at = \?/);
  assert.match(batch.statements[2].sql, /SET status = 'retired'/);
  assert.match(batch.statements[2].sql, /state\.active_version_id = \?/);
});

test("activation reports migration-required without exposing the raw D1 error", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    if (sql.includes("FROM master_catalog_evaluations")) throw new Error("D1_ERROR: no such table: master_catalog_evaluations; secret-internal-query");
    return [];
  });
  await assert.rejects(
    () => activateMasterCatalogVersion({
      db,
      index: {},
      versionId: stagedVersion.version_id,
      requiredEvaluation: requiredEvaluationProfile(stagedVersion),
    }),
    (error) => {
      assert.ok(error instanceof CatalogAdminError);
      assert.equal(error.code, "catalog_migration_required");
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /secret-internal-query/);
      return true;
    },
  );
});

test("reports incomplete Vectorize propagation with the retryable admin code", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    if (sql.includes("FROM master_catalog_evaluations")) return passingEvaluation(stagedVersion);
    if (sql.includes("AS seed_queue_count")) return activationCounts(stagedVersion);
    if (sql.includes("COUNT(*) AS total")) return { total: stagedVersion.chunk_count, seeded: stagedVersion.chunk_count, pending: 0, failed: 0 };
    if (sql.includes("SELECT p.vector_id")) {
      const bucket = sql.includes("p.updated_at DESC") ? "recent" : sql.includes("p.chunk_id DESC") ? "late" : "early";
      return Array.from({ length: 16 }, (_item, index) => ({ vector_id: `mc_${bucket}_${index}` }));
    }
    return [];
  });
  await assert.rejects(
    () => activateMasterCatalogVersion({
      db,
      index: { async getByIds(ids) { return ids.map((id) => ({ id })); } },
      versionId: stagedVersion.version_id,
      requiredEvaluation: requiredEvaluationProfile(stagedVersion),
      visibilityAttempts: 1,
      visibilityDelayMs: 0,
    }),
    (error) => error instanceof CatalogAdminError
      && error.code === "catalog_vectors_propagating"
      && error.details.provider_error === false,
  );
  assert.equal(db.calls.some((call) => call.method === "batch"), false);
});

test("activation blocks mismatched staged counts and partial passing evaluations", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  let evaluation = passingEvaluation(stagedVersion, {
    fixture_case_count: 101,
    evaluated_count: 1,
    passed_count: 1,
  });
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    if (sql.includes("FROM master_catalog_evaluations")) return evaluation;
    if (sql.includes("AS seed_queue_count")) return activationCounts(stagedVersion, { alias_count: stagedVersion.alias_count - 1 });
    return [];
  });
  await assert.rejects(
    () => activateMasterCatalogVersion({
      db,
      index: {},
      versionId: stagedVersion.version_id,
      requiredEvaluation: requiredEvaluationProfile(stagedVersion),
    }),
    (error) => error instanceof CatalogAdminError && error.code === "catalog_evaluation_not_passing",
  );

  evaluation = passingEvaluation(stagedVersion);
  await assert.rejects(
    () => activateMasterCatalogVersion({
      db,
      index: {},
      versionId: stagedVersion.version_id,
      requiredEvaluation: requiredEvaluationProfile(stagedVersion),
    }),
    (error) => {
      assert.equal(error.code, "catalog_count_mismatch");
      assert.deepEqual(error.details.mismatches, [{ component: "aliases", declared: stagedVersion.alias_count, actual: stagedVersion.alias_count - 1 }]);
      return true;
    },
  );
  assert.equal(db.calls.some((call) => call.method === "batch"), false);
});

test("records idempotent evaluations with count-derived status", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  const profile = requiredEvaluationProfile(stagedVersion);
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    return [];
  });
  const result = await recordMasterCatalogEvaluation({
    db,
    version_id: stagedVersion.version_id,
    required_profile: requiredEvaluationProfile(stagedVersion),
    fixture_sha256: "b".repeat(64),
    fixture_schema_version: profile.fixture_schema_version,
    source_sha256: stagedVersion.source_sha256,
    retrieval_profile_sha256: profile.retrieval_profile_sha256,
    fixture_case_count: 101,
    evaluated_count: 5,
    passed_count: 5,
    failed_count: 0,
    status: "incomplete",
    evaluated_at: "2026-09-02T18:00:00Z",
    details: { limit: 5 },
  });
  assert.equal(result.evaluation_status, "incomplete");
  const insert = db.calls.find((call) => call.method === "run" && call.sql.startsWith("INSERT INTO master_catalog_evaluations"));
  assert.match(insert.sql, /ON CONFLICT\(version_id, fixture_sha256, evaluated_at\) DO UPDATE/);
  assert.equal(insert.parameters[8], "incomplete");
  assert.equal(insert.parameters[9], "2026-09-02T18:00:00.000Z");
  assert.equal(insert.parameters[11], profile.retrieval_profile_sha256);

  await assert.rejects(
    () => recordMasterCatalogEvaluation({
      db,
      version_id: stagedVersion.version_id,
      required_profile: requiredEvaluationProfile(stagedVersion),
      fixture_sha256: "b".repeat(64),
      fixture_schema_version: profile.fixture_schema_version,
      source_sha256: stagedVersion.source_sha256,
      retrieval_profile_sha256: profile.retrieval_profile_sha256,
      fixture_case_count: 101,
      evaluated_count: 1,
      passed_count: 1,
      failed_count: 0,
      status: "passed",
    }),
    (error) => error.code === "catalog_evaluation_invalid" && error.details.expected_status === "incomplete",
  );

  await assert.rejects(
    () => recordMasterCatalogEvaluation({
      db,
      version_id: stagedVersion.version_id,
      required_profile: requiredEvaluationProfile(stagedVersion),
      fixture_sha256: "c".repeat(64),
      fixture_schema_version: profile.fixture_schema_version,
      source_sha256: stagedVersion.source_sha256,
      retrieval_profile_sha256: profile.retrieval_profile_sha256,
      fixture_case_count: 101,
      evaluated_count: 101,
      passed_count: 101,
      failed_count: 0,
      status: "passed",
    }),
    (error) => error.code === "catalog_evaluation_profile_mismatch",
  );
});

test("rejects a stale retrieval-build fingerprint before reading reusable evaluations", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  const staleProfile = {
    ...requiredEvaluationProfile(stagedVersion),
    retrieval_profile_sha256: "a".repeat(64),
  };
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    return [];
  });
  await assert.rejects(
    () => activateMasterCatalogVersion({
      db,
      index: {},
      versionId: stagedVersion.version_id,
      requiredEvaluation: staleProfile,
    }),
    (error) => error instanceof CatalogAdminError
      && error.code === "catalog_evaluation_profile_fingerprint_mismatch",
  );
  assert.equal(db.calls.some((call) => call.sql?.includes("FROM master_catalog_evaluations")), false);
});

test("rejects a self-consistent retrieval profile that omits a required code file", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  const truncatedProfile = requiredEvaluationProfile(stagedVersion);
  truncatedProfile.retrieval_build.code_files = truncatedProfile.retrieval_build.code_files.slice(0, -1);
  truncatedProfile.retrieval_build.retrieval_code_sha256 = createHash("sha256")
    .update(canonicalize(truncatedProfile.retrieval_build.code_files))
    .digest("hex");
  truncatedProfile.retrieval_profile_sha256 = createHash("sha256")
    .update(canonicalize({
      fingerprint_schema_version: truncatedProfile.fingerprint_schema_version,
      fixture: {
        sha256: truncatedProfile.fixture_sha256,
        schema_version: truncatedProfile.fixture_schema_version,
        source_sha256: truncatedProfile.source_sha256,
        required_case_count: truncatedProfile.fixture_case_count,
        raw_case_count: truncatedProfile.raw_fixture_case_count,
        unsupported_case_count: truncatedProfile.unsupported_case_count,
      },
      retrieval_build: truncatedProfile.retrieval_build,
    }))
    .digest("hex");
  const db = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    return [];
  });

  await assert.rejects(
    () => activateMasterCatalogVersion({
      db,
      index: {},
      versionId: stagedVersion.version_id,
      requiredEvaluation: truncatedProfile,
    }),
    (error) => error instanceof CatalogAdminError
      && error.code === "catalog_evaluation_profile_required",
  );
  assert.equal(db.calls.some((call) => call.sql?.includes("FROM master_catalog_evaluations")), false);
});

test("resets failed seed rows only while the version remains staged", async () => {
  const stagedVersion = { ...activeVersion, status: "staged" };
  let reset = false;
  const db = createDb((sql) => {
    if (sql.startsWith("UPDATE master_vector_seed_progress") && sql.includes("status = 'pending'")) {
      assert.match(sql, /v\.status = 'staged'/);
      reset = true;
      return { success: true, meta: { changes: 2 } };
    }
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return stagedVersion;
    if (sql.includes("COUNT(*) AS total")) return reset
      ? { total: 4, seeded: 2, pending: 2, failed: 0 }
      : { total: 4, seeded: 2, pending: 0, failed: 2 };
    return [];
  });
  const result = await resetFailedMasterVectorSeed({ db, versionId: stagedVersion.version_id });
  assert.equal(result.status, "reset");
  assert.equal(result.reset_count, 2);
  assert.equal(result.seed_progress.pending, 2);

  const activeDb = createDb((sql) => {
    if (sql.includes("FROM master_catalog_versions") && sql.includes("version_id = ?")) return activeVersion;
    return [];
  });
  await assert.rejects(
    () => resetFailedMasterVectorSeed({ db: activeDb, versionId: activeVersion.version_id }),
    (error) => error.code === "catalog_version_not_staged",
  );
  assert.equal(activeDb.calls.some((call) => call.method === "run"), false);
});
