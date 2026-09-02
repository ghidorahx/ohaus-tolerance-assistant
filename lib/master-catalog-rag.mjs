/**
 * Runtime retrieval for the full MMMDF catalog.
 *
 * This module deliberately contains no workbook or generated-catalog imports.
 * Catalog rows and retrieval chunks are supplied through an injected D1 binding;
 * Workers AI and Vectorize are injected so the module remains straightforward to
 * exercise with deterministic mocks.
 *
 * The table names in this file intentionally match migrations/0001_master_catalog.sql.
 * A catalog version is activated by changing master_catalog_state; Vectorize
 * namespaces are derived from the immutable version ID instead of stored in D1.
 */

export const MASTER_VECTORIZE_INDEX = "ohaus-master-catalog-fast-v1";
export const MASTER_EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const MASTER_EMBEDDING_POOLING = "cls";
export const MASTER_EMBEDDING_DIMENSIONS = 384;
export const MASTER_VECTORIZE_METRIC = "cosine";
export const MASTER_DEFAULT_TOP_K = 30;
export const MASTER_DEFAULT_CHUNK_LIMIT = 8;
export const MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD = 0.45;
export const MASTER_MAX_VECTOR_ID_BYTES = 64;
export const MASTER_CATALOG_BUNDLE_VERSION = "master-catalog-rag-v1";

const MASTER_CATEGORY_NAME_LIMIT = 80;
const MASTER_CATEGORY_MATERIAL_LIMIT = 40;

export const MASTER_CATALOG_TABLES = Object.freeze({
  versions: "master_catalog_versions",
  state: "master_catalog_state",
  materials: "master_materials",
  aliases: "master_aliases",
  attributes: "master_attributes",
  chunks: "master_chunks",
  fullTextChunks: "master_chunks_fts",
  relationships: "master_relationships",
  documents: "master_documents",
  vectorSeedProgress: "master_vector_seed_progress",
  evaluations: "master_catalog_evaluations",
});

const MASTER_ACTIVATION_COMPONENTS = Object.freeze([
  { name: "materials", declared: "material_count", actual: "material_count" },
  { name: "aliases", declared: "alias_count", actual: "alias_count" },
  { name: "attributes", declared: "attribute_count", actual: "attribute_count" },
  { name: "relationships", declared: "relationship_count", actual: "relationship_count" },
  { name: "documents", declared: "document_count", actual: "document_count" },
  { name: "chunks", declared: "chunk_count", actual: "chunk_count" },
  { name: "full_text_chunks", declared: "chunk_count", actual: "fts_count" },
  { name: "vector_seed_queue", declared: "chunk_count", actual: "seed_queue_count" },
]);

const MASTER_VECTOR_VISIBILITY_SAMPLE_LIMIT = 32;
const MASTER_VECTOR_VISIBILITY_BUCKET_LIMIT = 16;
const MASTER_VECTOR_QUERY_BATCH_SIZE = 8;
const MASTER_EVALUATION_DETAILS_MAX_BYTES = 24_000;

/**
 * Expected, operator-actionable catalog rollout failure. Route handlers may
 * safely expose these fields to authenticated administrators. Raw database or
 * provider errors are deliberately never copied into the public properties.
 */
export class CatalogAdminError extends Error {
  constructor(code, message, { status = 409, details = null, cause = null } = {}) {
    super(String(message));
    this.name = "CatalogAdminError";
    this.code = String(code);
    this.status = clampInteger(status, 409, 400, 599);
    this.details = sanitizeAdminDetails(details);
    if (cause !== null && cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, configurable: true, writable: true });
    }
  }
}

const FTS_STOP_WORDS = new Set([
  "a", "about", "all", "an", "and", "are", "as", "at", "be", "can", "do", "does", "for", "from",
  "give", "has", "have", "how", "i", "in", "is", "it", "me", "need", "of", "on", "or", "our", "show",
  "tell", "that", "the", "their", "there", "these", "this", "to", "us", "want", "what", "which", "with",
]);

const INTERNAL_FIELD_PREFIXES = [
  "fields.sales_organization",
  "fields.sales_org",
  "fields.main_delivering_plant",
  "fields.delivering_plant",
  "fields.procurement_type",
  "fields.commodity_code",
  "fields.order_notes",
  "commercial.sales_organization",
  "commercial.delivering_plant",
  "commercial.procurement_type",
  "commercial.commodity_code",
  "order_notes",
];

const IDENTITY_FIELDS = ["material_number", "model", "trade_name", "product_name", "parent_family", "family"];

const EMPTY_CATALOG_LISTING = Object.freeze({
  requested: false,
  status: "skipped",
  kind: null,
  category: null,
  total_count: 0,
  returned_count: 0,
  truncated: false,
  items: [],
});

function clampInteger(value, fallback, minimum, maximum) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function resultRows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.results) ? result.results : [];
}

async function queryAll(db, sql, parameters = []) {
  const statement = db.prepare(sql).bind(...parameters);
  return resultRows(await statement.all());
}

async function queryFirst(db, sql, parameters = []) {
  const statement = db.prepare(sql).bind(...parameters);
  if (typeof statement.first === "function") return await statement.first();
  return resultRows(await statement.all())[0] ?? null;
}

async function runStatement(db, sql, parameters = []) {
  return await db.prepare(sql).bind(...parameters).run();
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeAdminDetails(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 4) return "[truncated]";
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(/[\r\n\t]+/g, " ").slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeAdminDetails(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 32)) {
      output[String(key).slice(0, 80)] = sanitizeAdminDetails(child, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 240);
}

function adminError(code, message, status = 409, details = null, cause = null) {
  return new CatalogAdminError(code, message, { status, details, cause });
}

function isMissingEvaluationTable(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("master_catalog_evaluations")
    && (message.includes("no such table") || message.includes("does not exist") || message.includes("not found"));
}

function isMissingEvaluationFingerprint(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("retrieval_profile_sha256")
    && (message.includes("no such column") || message.includes("has no column") || message.includes("not found"));
}

function requiredNonnegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw adminError(
      "catalog_evaluation_invalid",
      "Evaluation counts must be non-negative whole numbers.",
      400,
      { field },
    );
  }
  return number;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) {
    throw adminError(
      "catalog_evaluation_profile_unavailable",
      "The runtime cannot validate the deployed retrieval profile fingerprint.",
      503,
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function retrievalProfileFingerprintPayload(profile) {
  return {
    fingerprint_schema_version: profile?.fingerprint_schema_version,
    fixture: {
      sha256: profile?.fixture_sha256,
      schema_version: profile?.fixture_schema_version,
      source_sha256: profile?.source_sha256,
      required_case_count: profile?.fixture_case_count,
      raw_case_count: profile?.raw_fixture_case_count,
      unsupported_case_count: profile?.unsupported_case_count,
    },
    retrieval_build: profile?.retrieval_build,
  };
}

function deployedRetrievalConfigurationMatches(build) {
  return build?.bundle_version === MASTER_CATALOG_BUNDLE_VERSION
    && Number(build?.default_top_k) === MASTER_DEFAULT_TOP_K
    && Number(build?.default_chunk_limit) === MASTER_DEFAULT_CHUNK_LIMIT
    && Number(build?.semantic_score_threshold) === MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD
    && build?.embedding?.model === MASTER_EMBEDDING_MODEL
    && build?.embedding?.pooling === MASTER_EMBEDDING_POOLING
    && Number(build?.embedding?.dimensions) === MASTER_EMBEDDING_DIMENSIONS
    && build?.vectorize?.binding === "CATALOG_VECTORIZE"
    && build?.vectorize?.index_name === MASTER_VECTORIZE_INDEX
    && Number(build?.vectorize?.dimensions) === MASTER_EMBEDDING_DIMENSIONS
    && build?.vectorize?.metric === MASTER_VECTORIZE_METRIC;
}

const REQUIRED_RETRIEVAL_PROFILE_CODE_FILES = [
  "app/api/sales/route.ts",
  "lib/master-catalog-rag.mjs",
  "scripts/build-master-retrieval-eval.py",
  "scripts/evaluate-master-retrieval.mjs",
  "scripts/verify-master-retrieval-profile.mjs",
];

function deployedRetrievalCodeFilesMatch(codeFiles) {
  if (!Array.isArray(codeFiles) || codeFiles.length !== REQUIRED_RETRIEVAL_PROFILE_CODE_FILES.length) {
    return false;
  }
  const paths = codeFiles.map((file) => String(file?.path ?? "")).sort();
  return paths.every((filePath, index) => filePath === REQUIRED_RETRIEVAL_PROFILE_CODE_FILES[index])
    && codeFiles.every((file) => /^[a-f0-9]{64}$/.test(String(file?.sha256 ?? "")));
}

async function requiredEvaluationProfile(value, version) {
  const profile = value && typeof value === "object" ? value : null;
  const fixtureSha256 = String(profile?.fixture_sha256 ?? profile?.fixtureSha256 ?? "").trim().toLowerCase();
  const fixtureSchemaVersion = String(profile?.fixture_schema_version ?? profile?.fixtureSchemaVersion ?? "").trim();
  const sourceSha256 = String(profile?.source_sha256 ?? profile?.sourceSha256 ?? "").trim().toLowerCase();
  const fixtureCaseCount = Number(profile?.fixture_case_count ?? profile?.fixtureCaseCount);
  const retrievalProfileSha256 = String(
    profile?.retrieval_profile_sha256 ?? profile?.retrievalProfileSha256 ?? "",
  ).trim().toLowerCase();
  const rawFixtureCaseCount = Number(profile?.raw_fixture_case_count);
  const unsupportedCaseCount = Number(profile?.unsupported_case_count);
  const codeFiles = profile?.retrieval_build?.code_files;
  if (
    profile?.profile_version !== "2.0.0"
    || profile?.fingerprint_schema_version !== "1.0.0"
    || !/^[a-f0-9]{64}$/.test(fixtureSha256)
    || !fixtureSchemaVersion
    || fixtureSchemaVersion.length > 80
    || !/^[a-f0-9]{64}$/.test(sourceSha256)
    || !/^[a-f0-9]{64}$/.test(retrievalProfileSha256)
    || !Number.isInteger(fixtureCaseCount)
    || fixtureCaseCount <= 0
    || !Number.isInteger(rawFixtureCaseCount)
    || rawFixtureCaseCount < fixtureCaseCount
    || !Number.isInteger(unsupportedCaseCount)
    || unsupportedCaseCount < 0
    || rawFixtureCaseCount - unsupportedCaseCount !== fixtureCaseCount
    || !/^[a-f0-9]{64}$/.test(String(profile?.retrieval_build?.retrieval_code_sha256 ?? ""))
    || !deployedRetrievalCodeFilesMatch(codeFiles)
    || !deployedRetrievalConfigurationMatches(profile?.retrieval_build)
  ) {
    throw adminError(
      "catalog_evaluation_profile_required",
      "A valid deployed retrieval-evaluation profile is required for this catalog action.",
      503,
    );
  }
  if (sourceSha256 !== String(version.source_sha256 ?? "").toLowerCase()) {
    throw adminError(
      "catalog_evaluation_profile_source_mismatch",
      "The deployed retrieval-evaluation profile does not match this catalog source.",
      409,
      { version_id: version.version_id },
    );
  }
  const computedProfileSha256 = await sha256Hex(canonicalJson(retrievalProfileFingerprintPayload(profile)));
  if (computedProfileSha256 !== retrievalProfileSha256) {
    throw adminError(
      "catalog_evaluation_profile_fingerprint_mismatch",
      "The deployed retrieval-evaluation profile fingerprint is invalid. Rebuild and redeploy the profile before evaluating or activating.",
      503,
      { version_id: version.version_id },
    );
  }
  return {
    fixtureSha256,
    fixtureSchemaVersion,
    sourceSha256,
    fixtureCaseCount,
    retrievalProfileSha256,
    rawFixtureCaseCount,
    unsupportedCaseCount,
  };
}

function boundedDetailsJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value && typeof value === "object" ? value : {});
  } catch {
    throw adminError(
      "catalog_evaluation_invalid",
      "Evaluation details must be JSON serializable.",
      400,
      { field: "details" },
    );
  }
  if (textBytes(serialized) > MASTER_EVALUATION_DETAILS_MAX_BYTES) {
    throw adminError(
      "catalog_evaluation_invalid",
      `Evaluation details must not exceed ${MASTER_EVALUATION_DETAILS_MAX_BYTES} bytes.`,
      400,
      { field: "details", maximum_bytes: MASTER_EVALUATION_DETAILS_MAX_BYTES },
    );
  }
  return serialized;
}

function textBytes(value) {
  return new TextEncoder().encode(String(value ?? "")).length;
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replaceAll("™", "")
    .replaceAll("®", "")
    .toLowerCase();
}

export function normalizeCatalogIdentifier(value) {
  // Keep this byte-for-byte compatible with import-master-catalog.py's
  // normalize_alias(): aliases are lowercase words separated by one space.
  return String(value ?? "")
    .replaceAll("\u00a0", " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function masterCatalogNamespace(versionId) {
  const normalized = String(versionId ?? "").trim();
  return normalized ? `master-${normalized}` : "";
}

function searchTokens(value, maximum = 16) {
  return [...new Set(normalizedText(value).match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => token.length > 1 && !FTS_STOP_WORDS.has(token))
    .slice(0, maximum);
}

function buildFtsQuery(question) {
  const tokens = searchTokens(question, 14);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function safeJson(value, fallback) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function truncate(value, maximum = 1_600) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return truncate(value.map(displayValue).filter(Boolean).join("; "), 640);
  if (typeof value === "object" && "display" in value) return truncate(value.display, 640);
  if (typeof value === "object") return truncate(JSON.stringify(value), 640);
  return truncate(value, 640);
}

function flattenScalars(value, prefix = "", output = []) {
  if (value === null || value === undefined || value === "") return output;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object")) output.push({ path: prefix, value });
    else value.forEach((item) => flattenScalars(item, prefix, output));
    return output;
  }
  if (typeof value === "object") {
    if ("display" in value && value.display !== null && value.display !== "") {
      output.push({ path: prefix, value: value.display });
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      flattenScalars(child, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }
  output.push({ path: prefix, value });
  return output;
}

function parseMaterialRow(row) {
  const parsed = safeJson(row?.record_json, {});
  const tradeName = parsed.trade_name ?? row?.trade_name ?? null;
  return {
    ...parsed,
    material_number: String(parsed.material_number ?? row?.material_number ?? ""),
    model: parsed.model ?? tradeName ?? parsed.product_name ?? row?.product_name ?? null,
    trade_name: tradeName,
    product_name: parsed.product_name ?? row?.product_name ?? null,
    parent_family: parsed.parent_family ?? row?.parent_family ?? null,
    family: parsed.family ?? row?.family ?? null,
    fields: parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {},
    source: {
      ...(parsed.source ?? {}),
      ...(row?.source_file ? { file: row.source_file } : {}),
      ...(row?.source_sheet ? { sheet: row.source_sheet } : {}),
      ...(row?.source_row ? { row: row.source_row } : {}),
    },
  };
}

function compactMaterial(record) {
  return {
    material_number: String(record?.material_number ?? ""),
    model: record?.model ?? record?.trade_name ?? null,
    product_name: record?.product_name ?? null,
    parent_family: record?.parent_family ?? null,
    family: record?.family ?? null,
    record,
  };
}

async function activeVersion(db) {
  const row = await queryFirst(db, `
    SELECT v.version_id, v.schema_version, v.source_file, v.source_sha256,
           v.source_sheet, v.source_rows, v.source_columns, v.material_count,
           v.alias_count, v.attribute_count, v.chunk_count,
           v.relationship_count, v.document_count, v.status,
           v.generated_at, v.staged_at, v.activated_at
    FROM master_catalog_state AS s
    JOIN master_catalog_versions AS v
      ON v.version_id = s.active_version_id
    WHERE s.singleton_id = 1
    LIMIT 1
  `);
  return row ? { ...row, namespace: masterCatalogNamespace(row.version_id) } : null;
}

async function versionById(db, versionId) {
  const row = await queryFirst(db, `
    SELECT version_id, schema_version, source_file, source_sha256, source_sheet,
           source_rows, source_columns, material_count, alias_count,
           attribute_count, chunk_count, relationship_count, document_count,
           status, generated_at, staged_at, activated_at
    FROM master_catalog_versions
    WHERE version_id = ?
    LIMIT 1
  `, [versionId]);
  return row ? { ...row, namespace: masterCatalogNamespace(row.version_id) } : null;
}

async function latestMatchingEvaluation(db, version, profile) {
  try {
    return await queryFirst(db, `
      SELECT version_id, fixture_sha256, fixture_schema_version, source_sha256,
             retrieval_profile_sha256,
             fixture_case_count, evaluated_count, passed_count, failed_count,
             status, evaluated_at, details_json
      FROM master_catalog_evaluations
      WHERE version_id = ? AND source_sha256 = ?
        AND fixture_sha256 = ?
        AND fixture_schema_version = ?
        AND fixture_case_count = ?
        AND retrieval_profile_sha256 = ?
      ORDER BY evaluated_at DESC, fixture_sha256 DESC
      LIMIT 1
    `, [
      version.version_id,
      profile.sourceSha256,
      profile.fixtureSha256,
      profile.fixtureSchemaVersion,
      profile.fixtureCaseCount,
      profile.retrievalProfileSha256,
    ]);
  } catch (error) {
    if (isMissingEvaluationTable(error)) {
      throw adminError(
        "catalog_migration_required",
        "Catalog evaluation storage is not installed. Apply migration 0002 before activation.",
        503,
        { migration: "0002", table: MASTER_CATALOG_TABLES.evaluations },
        error,
      );
    }
    if (isMissingEvaluationFingerprint(error)) {
      throw adminError(
        "catalog_migration_required",
        "Catalog evaluation build fingerprinting is not installed. Apply migration 0004 before activation.",
        503,
        { migration: "0004", table: MASTER_CATALOG_TABLES.evaluations },
        error,
      );
    }
    throw adminError(
      "catalog_evaluation_unavailable",
      "The saved catalog evaluation could not be read. Retry before activation.",
      503,
      { version_id: version.version_id },
      error,
    );
  }
}

async function requirePassingEvaluation(db, version, requiredProfile) {
  const profile = await requiredEvaluationProfile(requiredProfile, version);
  const evaluation = await latestMatchingEvaluation(db, version, profile);
  if (!evaluation) {
    throw adminError(
      "catalog_evaluation_required",
      "A complete passing retrieval evaluation must be saved before activation.",
      409,
      {
        version_id: version.version_id,
        source_sha256: version.source_sha256,
        fixture_sha256: profile.fixtureSha256,
        retrieval_profile_sha256: profile.retrievalProfileSha256,
        fixture_case_count: profile.fixtureCaseCount,
      },
    );
  }
  const fixtureCaseCount = Number(evaluation.fixture_case_count) || 0;
  const evaluatedCount = Number(evaluation.evaluated_count) || 0;
  const passedCount = Number(evaluation.passed_count) || 0;
  const failedCount = Number(evaluation.failed_count) || 0;
  const passes = evaluation.source_sha256 === version.source_sha256
    && evaluation.retrieval_profile_sha256 === profile.retrievalProfileSha256
    && evaluation.status === "passed"
    && fixtureCaseCount > 0
    && evaluatedCount === fixtureCaseCount
    && failedCount === 0
    && passedCount === evaluatedCount;
  if (!passes) {
    throw adminError(
      "catalog_evaluation_not_passing",
      "The latest retrieval evaluation is failed or incomplete. Run the full required fixture and save a passing result before activation.",
      409,
      {
        version_id: version.version_id,
        fixture_sha256: evaluation.fixture_sha256,
        retrieval_profile_sha256: evaluation.retrieval_profile_sha256,
        fixture_case_count: fixtureCaseCount,
        evaluated_count: evaluatedCount,
        passed_count: passedCount,
        failed_count: failedCount,
        evaluation_status: evaluation.status,
        evaluated_at: evaluation.evaluated_at,
      },
    );
  }
  return {
    ...evaluation,
    fixture_case_count: fixtureCaseCount,
    evaluated_count: evaluatedCount,
    passed_count: passedCount,
    failed_count: failedCount,
  };
}

async function catalogActualCounts(db, versionId) {
  const row = await queryFirst(db, `
    SELECT
      (SELECT COUNT(*) FROM master_materials WHERE version_id = ?) AS material_count,
      (SELECT COUNT(*) FROM master_aliases WHERE version_id = ?) AS alias_count,
      (SELECT COUNT(*) FROM master_attributes WHERE version_id = ?) AS attribute_count,
      (SELECT COUNT(*) FROM master_relationships WHERE version_id = ?) AS relationship_count,
      (SELECT COUNT(*) FROM master_documents WHERE version_id = ?) AS document_count,
      (SELECT COUNT(*) FROM master_chunks WHERE version_id = ?) AS chunk_count,
      (SELECT COUNT(*) FROM master_chunks_fts WHERE version_id = ?) AS fts_count,
      (SELECT COUNT(*) FROM master_vector_seed_progress WHERE version_id = ?) AS seed_queue_count
  `, Array.from({ length: 8 }, () => versionId));
  return Object.fromEntries(MASTER_ACTIVATION_COMPONENTS.map(({ actual }) => [
    actual,
    Number(row?.[actual]) || 0,
  ]));
}

async function requireMatchingCatalogCounts(db, version) {
  let actual;
  try {
    actual = await catalogActualCounts(db, version.version_id);
  } catch (error) {
    throw adminError(
      "catalog_validation_unavailable",
      "Catalog staging counts could not be validated. Retry before activation.",
      503,
      { version_id: version.version_id },
      error,
    );
  }
  const mismatches = MASTER_ACTIVATION_COMPONENTS.flatMap((component) => {
    const declared = Number(version[component.declared]) || 0;
    const observed = Number(actual[component.actual]) || 0;
    return declared === observed ? [] : [{ component: component.name, declared, actual: observed }];
  });
  if (mismatches.length > 0) {
    throw adminError(
      "catalog_count_mismatch",
      "Catalog staging counts do not match the declared artifact. Repair or re-import the listed components before activation.",
      409,
      { version_id: version.version_id, mismatches },
    );
  }
  return actual;
}

/**
 * Persist an evaluator result used by the activation gate. Both camelCase and
 * API-style snake_case field names are accepted so route wiring stays explicit
 * without making the evaluator payload part of public retrieval.
 */
export async function recordMasterCatalogEvaluation(options = {}) {
  const db = options.db ?? null;
  const versionId = String(options.versionId ?? options.version_id ?? "").trim();
  if (!db) {
    throw adminError(
      "catalog_admin_configuration_required",
      "A D1 binding is required to save a catalog evaluation.",
      503,
    );
  }
  if (!versionId) {
    throw adminError("catalog_version_required", "A catalog version ID is required.", 400);
  }
  let version;
  try {
    version = await versionById(db, versionId);
  } catch (error) {
    throw adminError(
      "catalog_validation_unavailable",
      "The catalog version could not be validated before saving its evaluation.",
      503,
      { version_id: versionId },
      error,
    );
  }
  if (!version) {
    throw adminError("catalog_version_not_found", "The requested catalog version was not found.", 404, { version_id: versionId });
  }
  if (version.status !== "staged") {
    throw adminError(
      "catalog_version_not_staged",
      "Evaluations may only be saved for a staged catalog version.",
      409,
      { version_id: version.version_id, version_status: version.status },
    );
  }

  const requiredProfile = await requiredEvaluationProfile(
    options.requiredProfile ?? options.required_profile,
    version,
  );

  const fixtureSha256 = String(options.fixtureSha256 ?? options.fixture_sha256 ?? "").trim().toLowerCase();
  const fixtureSchemaVersion = String(options.fixtureSchemaVersion ?? options.fixture_schema_version ?? "").trim();
  const sourceSha256 = String(options.sourceSha256 ?? options.source_sha256 ?? "").trim().toLowerCase();
  const retrievalProfileSha256 = String(
    options.retrievalProfileSha256 ?? options.retrieval_profile_sha256 ?? "",
  ).trim().toLowerCase();
  const requestedStatus = String(options.status ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fixtureSha256)) {
    throw adminError("catalog_evaluation_invalid", "A valid fixture SHA-256 is required.", 400, { field: "fixture_sha256" });
  }
  if (!fixtureSchemaVersion || fixtureSchemaVersion.length > 80) {
    throw adminError("catalog_evaluation_invalid", "A valid fixture schema version is required.", 400, { field: "fixture_schema_version" });
  }
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || sourceSha256 !== String(version.source_sha256).toLowerCase()) {
    throw adminError(
      "catalog_evaluation_source_mismatch",
      "The evaluation source hash does not match the staged catalog source.",
      409,
      { version_id: version.version_id },
    );
  }
  if (
    fixtureSha256 !== requiredProfile.fixtureSha256
    || fixtureSchemaVersion !== requiredProfile.fixtureSchemaVersion
    || sourceSha256 !== requiredProfile.sourceSha256
    || retrievalProfileSha256 !== requiredProfile.retrievalProfileSha256
  ) {
    throw adminError(
      "catalog_evaluation_profile_mismatch",
      "The evaluation does not match the deployed required fixture.",
      409,
      {
        version_id: version.version_id,
        fixture_sha256: fixtureSha256,
        fixture_schema_version: fixtureSchemaVersion,
        retrieval_profile_sha256: retrievalProfileSha256,
      },
    );
  }
  if (requestedStatus && !["passed", "failed", "incomplete"].includes(requestedStatus)) {
    throw adminError("catalog_evaluation_invalid", "Evaluation status must be passed, failed, or incomplete.", 400, { field: "status" });
  }

  const fixtureCaseCount = requiredNonnegativeInteger(options.fixtureCaseCount ?? options.fixture_case_count, "fixture_case_count");
  const evaluatedCount = requiredNonnegativeInteger(options.evaluatedCount ?? options.evaluated_count, "evaluated_count");
  const passedCount = requiredNonnegativeInteger(options.passedCount ?? options.passed_count, "passed_count");
  const failedCount = requiredNonnegativeInteger(options.failedCount ?? options.failed_count, "failed_count");
  if (fixtureCaseCount !== requiredProfile.fixtureCaseCount) {
    throw adminError(
      "catalog_evaluation_profile_mismatch",
      "The evaluation case count does not match the deployed required fixture.",
      409,
      {
        version_id: version.version_id,
        fixture_case_count: fixtureCaseCount,
        required_fixture_case_count: requiredProfile.fixtureCaseCount,
      },
    );
  }
  if (fixtureCaseCount === 0 || evaluatedCount > fixtureCaseCount || passedCount + failedCount !== evaluatedCount) {
    throw adminError(
      "catalog_evaluation_invalid",
      "Evaluation counts are inconsistent with the required fixture.",
      400,
      {
        fixture_case_count: fixtureCaseCount,
        evaluated_count: evaluatedCount,
        passed_count: passedCount,
        failed_count: failedCount,
      },
    );
  }
  const status = failedCount > 0
    ? "failed"
    : evaluatedCount < fixtureCaseCount
      ? "incomplete"
      : "passed";
  if (requestedStatus && requestedStatus !== status) {
    throw adminError(
      "catalog_evaluation_invalid",
      "Evaluation status does not match its counts.",
      400,
      {
        supplied_status: requestedStatus,
        expected_status: status,
        fixture_case_count: fixtureCaseCount,
        evaluated_count: evaluatedCount,
        passed_count: passedCount,
        failed_count: failedCount,
      },
    );
  }

  const requestedEvaluatedAt = options.evaluatedAt ?? options.evaluated_at ?? null;
  const parsedEvaluatedAt = requestedEvaluatedAt ? new Date(requestedEvaluatedAt) : new Date();
  if (!Number.isFinite(parsedEvaluatedAt.getTime())) {
    throw adminError("catalog_evaluation_invalid", "Evaluation time must be a valid timestamp.", 400, { field: "evaluated_at" });
  }
  const evaluatedAt = parsedEvaluatedAt.toISOString();
  const detailsJson = boundedDetailsJson(options.details ?? safeJson(options.details_json, {}));

  try {
    await runStatement(db, `
      INSERT INTO master_catalog_evaluations(
        version_id, fixture_sha256, fixture_schema_version, source_sha256,
        fixture_case_count, evaluated_count, passed_count, failed_count,
        status, evaluated_at, details_json, retrieval_profile_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version_id, fixture_sha256, evaluated_at) DO UPDATE SET
        fixture_schema_version = excluded.fixture_schema_version,
        source_sha256 = excluded.source_sha256,
        fixture_case_count = excluded.fixture_case_count,
        evaluated_count = excluded.evaluated_count,
        passed_count = excluded.passed_count,
        failed_count = excluded.failed_count,
        status = excluded.status,
        details_json = excluded.details_json,
        retrieval_profile_sha256 = excluded.retrieval_profile_sha256
    `, [
      version.version_id,
      fixtureSha256,
      fixtureSchemaVersion,
      sourceSha256,
      fixtureCaseCount,
      evaluatedCount,
      passedCount,
      failedCount,
      status,
      evaluatedAt,
      detailsJson,
      retrievalProfileSha256,
    ]);
  } catch (error) {
    if (isMissingEvaluationTable(error)) {
      throw adminError(
        "catalog_migration_required",
        "Catalog evaluation storage is not installed. Apply migration 0002 before recording evaluations.",
        503,
        { migration: "0002", table: MASTER_CATALOG_TABLES.evaluations },
        error,
      );
    }
    if (isMissingEvaluationFingerprint(error)) {
      throw adminError(
        "catalog_migration_required",
        "Catalog evaluation build fingerprinting is not installed. Apply migration 0004 before recording evaluations.",
        503,
        { migration: "0004", table: MASTER_CATALOG_TABLES.evaluations },
        error,
      );
    }
    throw adminError(
      "catalog_evaluation_write_failed",
      "The catalog evaluation could not be saved. Retry before activation.",
      503,
      { version_id: version.version_id },
      error,
    );
  }
  return {
    status: "recorded",
    version_id: version.version_id,
    fixture_sha256: fixtureSha256,
    fixture_schema_version: fixtureSchemaVersion,
    source_sha256: sourceSha256,
    retrieval_profile_sha256: retrievalProfileSha256,
    fixture_case_count: fixtureCaseCount,
    evaluated_count: evaluatedCount,
    passed_count: passedCount,
    failed_count: failedCount,
    evaluation_status: status,
    evaluated_at: evaluatedAt,
  };
}

export function getMasterCatalogConfiguration() {
  return {
    bundle_version: MASTER_CATALOG_BUNDLE_VERSION,
    vectorize_index: MASTER_VECTORIZE_INDEX,
    vectorize_metric: MASTER_VECTORIZE_METRIC,
    embedding_model: MASTER_EMBEDDING_MODEL,
    embedding_pooling: MASTER_EMBEDDING_POOLING,
    embedding_dimensions: MASTER_EMBEDDING_DIMENSIONS,
    default_top_k: MASTER_DEFAULT_TOP_K,
    default_chunk_limit: MASTER_DEFAULT_CHUNK_LIMIT,
    semantic_score_threshold: MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD,
    tables: MASTER_CATALOG_TABLES,
  };
}

export async function getMasterCatalogSeedStatus({ db, versionId }) {
  if (!db) return { status: "not_configured", version_id: versionId ?? null, total: 0, seeded: 0, pending: 0, failed: 0, remaining: 0, complete: false };
  if (!versionId) return { status: "not_ready", version_id: null, total: 0, seeded: 0, pending: 0, failed: 0, remaining: 0, complete: false };
  const row = await queryFirst(db, `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'seeded' THEN 1 ELSE 0 END), 0) AS seeded,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM master_vector_seed_progress
    WHERE version_id = ?
  `, [versionId]) ?? {};
  const total = Number(row.total) || 0;
  const seeded = Number(row.seeded) || 0;
  const pending = Number(row.pending) || 0;
  const failed = Number(row.failed) || 0;
  const remaining = Math.max(0, total - seeded);
  return {
    status: total > 0 && remaining === 0 ? "complete" : total > 0 ? "in_progress" : "empty",
    version_id: String(versionId),
    total,
    seeded,
    pending,
    failed,
    remaining,
    complete: total > 0 && remaining === 0,
  };
}

/**
 * @param {{
 *   db?: D1Database | null,
 *   ai?: Ai | null,
 *   index?: VectorizeIndex | null,
 *   versionId?: string | null,
 *   includeSeedProgress?: boolean,
 * }} [options]
 */
export async function getMasterCatalogStatus({
  db = null,
  ai = null,
  index = null,
  versionId = null,
  includeSeedProgress = false,
} = {}) {
  const configured = { d1: Boolean(db), workers_ai: Boolean(ai), vectorize: Boolean(index) };
  if (!db) {
    return { status: "not_configured", configured, active_version: null, catalog_version: null, seed_progress: null, ...getMasterCatalogConfiguration() };
  }
  try {
    const [active, requested] = await Promise.all([
      activeVersion(db),
      versionId ? versionById(db, versionId) : Promise.resolve(null),
    ]);
    const version = requested ?? active;
    const seedProgress = includeSeedProgress && version
      ? await getMasterCatalogSeedStatus({ db, versionId: version.version_id })
      : null;
    return {
      status: version ? "ready" : "not_ready",
      configured,
      active_version: active ?? null,
      catalog_version: version ?? null,
      seed_progress: seedProgress,
      ...getMasterCatalogConfiguration(),
    };
  } catch (error) {
    return {
      status: "unavailable",
      configured,
      active_version: null,
      catalog_version: null,
      seed_progress: null,
      error: errorMessage(error),
      ...getMasterCatalogConfiguration(),
    };
  }
}

async function exactMaterial(db, versionId, identifier) {
  const rows = await queryAll(db, `
    SELECT m.material_number, m.trade_name, m.product_name, m.parent_family,
           m.family, m.record_json, m.source_row,
           v.source_file, v.source_sheet
    FROM master_materials AS m
    JOIN master_catalog_versions AS v ON v.version_id = m.version_id
    WHERE m.version_id = ? AND m.material_number = ?
    LIMIT 2
  `, [versionId, String(identifier).trim()]);
  return rows.map(parseMaterialRow);
}

async function exactAlias(db, versionId, identifier) {
  const alias = normalizeCatalogIdentifier(identifier);
  if (!alias) return [];
  const compact = alias.replaceAll(" ", "");
  const split = compact.replace(/([a-z])([0-9])/g, "$1 $2").replace(/([0-9])([a-z])/g, "$1 $2");
  const variants = [...new Set([alias, compact, split].filter(Boolean))];
  const rows = await queryAll(db, `
    SELECT m.material_number, m.trade_name, m.product_name, m.parent_family,
           m.family, m.record_json, m.source_row, a.alias_type,
           v.source_file, v.source_sheet
    FROM master_aliases AS a
    JOIN master_materials AS m
      ON m.version_id = a.version_id AND m.material_number = a.material_number
    JOIN master_catalog_versions AS v ON v.version_id = m.version_id
    WHERE a.version_id = ? AND a.normalized_alias IN (${placeholders(variants.length)})
    ORDER BY CASE WHEN a.normalized_alias = ? THEN 0 ELSE 1 END,
      CASE a.alias_type
      WHEN 'material_number' THEN 0 WHEN 'trade_name' THEN 1 ELSE 2 END,
      m.material_number
    LIMIT 12
  `, [versionId, ...variants, alias]);
  const unique = new Map();
  for (const row of rows) unique.set(String(row.material_number), parseMaterialRow(row));
  return [...unique.values()];
}

async function exactAlternativeModel(db, versionId, identifier) {
  const alias = normalizeCatalogIdentifier(identifier);
  const compact = alias.replaceAll(" ", "");
  if (!compact) return [];
  const rows = await queryAll(db, `
    SELECT m.material_number, m.trade_name, m.product_name, m.parent_family,
           m.family, m.record_json, m.source_row,
           v.source_file, v.source_sheet
    FROM master_attributes AS a
    JOIN master_materials AS m
      ON m.version_id = a.version_id AND m.material_number = a.material_number
    JOIN master_catalog_versions AS v ON v.version_id = m.version_id
    WHERE a.version_id = ?
      AND (a.field_key LIKE 'alternative_model%' OR lower(a.source_header) LIKE 'alternative model%')
      AND lower(replace(replace(replace(replace(replace(trim(a.value_text), ' ', ''), '-', ''), '_', ''), '/', ''), '.', '')) = ?
    ORDER BY m.material_number
    LIMIT 12
  `, [versionId, compact]);
  const unique = new Map();
  for (const row of rows) unique.set(String(row.material_number), parseMaterialRow(row));
  return [...unique.values()];
}

export async function resolveMasterIdentifier({ identifier, db, versionId = null }) {
  if (!db) return { identifier, normalized: normalizeCatalogIdentifier(identifier), status: "not_configured", candidates: [] };
  const version = versionId ? await versionById(db, versionId) : await activeVersion(db);
  if (!version) return { identifier, normalized: normalizeCatalogIdentifier(identifier), status: "not_ready", candidates: [] };

  const direct = await exactMaterial(db, version.version_id, identifier);
  let candidates = direct;
  if (candidates.length === 0) candidates = await exactAlias(db, version.version_id, identifier);
  if (candidates.length === 0) candidates = await exactAlternativeModel(db, version.version_id, identifier);
  if (candidates.length === 1) {
    return {
      identifier,
      normalized: normalizeCatalogIdentifier(identifier),
      status: "found",
      version_id: version.version_id,
      record: candidates[0],
      candidates: [],
    };
  }
  return {
    identifier,
    normalized: normalizeCatalogIdentifier(identifier),
    status: candidates.length > 1 ? "ambiguous" : "not_found",
    version_id: version.version_id,
    candidates: candidates.map(compactMaterial),
  };
}

function inferredIdentifierCandidates(question) {
  const rawTokens = String(question ?? "").match(/[A-Za-z0-9][A-Za-z0-9._/-]*/g) ?? [];
  const candidates = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index].replace(/^[._/-]+|[._/-]+$/g, "");
    if (/^\d{6,12}$/.test(token) || (/[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 4)) {
      candidates.push(token);
      if (rawTokens[index + 1] && /\d/.test(rawTokens[index + 1])) candidates.push(`${token} ${rawTokens[index + 1]}`);
    }
  }
  const blockedPrefixes = new Set(["at", "least", "most", "min", "minimum", "max", "maximum", "about", "around", "under", "over", "above", "below"]);
  for (let end = 1; end < rawTokens.length; end += 1) {
    const numeric = rawTokens[end].replace(/[^0-9]/g, "");
    if (!numeric || numeric.length > 8) continue;
    for (const width of [1, 2]) {
      const start = end - width;
      if (start < 0) continue;
      const prefixes = rawTokens.slice(start, end).map((token) => normalizeCatalogIdentifier(token));
      if (prefixes.some((token) => !/^[a-z]+$/.test(token) || blockedPrefixes.has(token))) continue;
      const validPrefix = prefixes.length === 1
        ? prefixes[0].length >= 2 && prefixes[0].length <= 5
        : prefixes.every((token) => token.length === 1);
      if (validPrefix) candidates.push(`${prefixes.join(" ")} ${numeric}`);
    }
  }
  return [...new Set(candidates)].sort((left, right) => right.length - left.length).slice(0, 8);
}

async function resolveQuestionIdentifiers({ question, identifiers, contextMaterials, db, versionId }) {
  const requested = Array.isArray(identifiers) && identifiers.length > 0
    ? identifiers
    : inferredIdentifierCandidates(question);
  const resolutions = await Promise.all(requested.slice(0, 8).map((identifier) => (
    resolveMasterIdentifier({ identifier, db, versionId })
  )));
  const found = new Map();
  for (const resolution of resolutions) {
    if (resolution.status === "found") found.set(String(resolution.record.material_number), resolution.record);
  }

  const usesReference = requested.length === 0 && /\b(?:it|its|that|this|those|these|them)\b/i.test(question);
  if (usesReference) {
    const contextResolutions = await Promise.all((contextMaterials ?? []).slice(-6).map((identifier) => (
      resolveMasterIdentifier({ identifier, db, versionId })
    )));
    for (const resolution of contextResolutions) {
      if (resolution.status === "found") found.set(String(resolution.record.material_number), resolution.record);
    }
    resolutions.push(...contextResolutions);
  }

  return {
    requested,
    resolutions,
    records: [...found.values()],
  };
}

function categoryDiscoveryRequested(question) {
  return /\b(?:available|catalog|categories|category|families|family|find|have|items?|list|models?|offer|products?|show|which|what)\b/i.test(question);
}

function comparableCategoryText(value) {
  return normalizeCatalogIdentifier(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
      if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2);
      if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
      return token;
    })
    .join(" ");
}

function categoryNameInQuestion(question, rows) {
  const comparableQuestion = ` ${comparableCategoryText(question)} `;
  return (rows ?? [])
    .map((row) => ({
      ...row,
      comparable_name: comparableCategoryText(row.name),
    }))
    .filter((row) => row.comparable_name && comparableQuestion.includes(` ${row.comparable_name} `))
    .sort((left, right) => (
      right.comparable_name.length - left.comparable_name.length
      || String(left.name).localeCompare(String(right.name))
    ))[0] ?? null;
}

async function categoryGroups(db, versionId, level, limit) {
  const column = level === "parent_family" ? "parent_family" : "family";
  return await queryAll(db, `
    SELECT m.${column} AS name, COUNT(*) AS material_count,
           COUNT(*) OVER () AS total_count
    FROM master_materials AS m
    WHERE m.version_id = ? AND NULLIF(TRIM(m.${column}), '') IS NOT NULL
    GROUP BY m.${column}
    ORDER BY m.${column} COLLATE NOCASE, m.${column}
    LIMIT ?
  `, [versionId, limit]);
}

function groupedCategoryListing(kind, rows, limit) {
  const items = rows.slice(0, limit).map((row) => ({
    name: String(row.name),
    material_count: Number(row.material_count) || 0,
  }));
  const total = Number(rows[0]?.total_count) || items.length;
  return {
    requested: true,
    status: "ready",
    kind,
    category: null,
    total_count: total,
    returned_count: items.length,
    truncated: total > items.length || rows.length > limit,
    items,
  };
}

async function materialsInCategory(db, versionId, category, limit) {
  const column = category.level === "parent_family" ? "parent_family" : "family";
  const rows = await queryAll(db, `
    SELECT m.material_number, m.trade_name, m.product_name,
           m.parent_family, m.family, COUNT(*) OVER () AS total_count
    FROM master_materials AS m
    WHERE m.version_id = ? AND m.${column} = ?
    ORDER BY COALESCE(m.trade_name, ''), m.product_name, m.material_number
    LIMIT ?
  `, [versionId, category.name, limit + 1]);
  const items = rows.slice(0, limit).map((row) => ({
    material_number: String(row.material_number),
    model: row.trade_name ?? null,
    description: row.product_name ?? null,
    product_name: row.product_name ?? null,
    parent_family: row.parent_family ?? null,
    family: row.family ?? null,
  }));
  const total = Number(rows[0]?.total_count) || items.length;
  return {
    requested: true,
    status: items.length > 0 ? "ready" : "no_results",
    kind: "materials_by_category",
    category,
    total_count: total,
    returned_count: items.length,
    truncated: total > items.length || rows.length > limit,
    items,
  };
}

function catalogMaterialItem(row) {
  return {
    material_number: String(row.material_number),
    model: row.trade_name ?? row.model ?? null,
    description: row.product_name ?? row.description ?? null,
    product_name: row.product_name ?? row.description ?? null,
    parent_family: row.parent_family ?? null,
    family: row.family ?? null,
  };
}

function locallyFilterCatalogListing(listing, eligibleMaterials) {
  const eligible = new Set(eligibleMaterials.map(String));
  const items = (listing.items ?? [])
    .filter((item) => eligible.has(String(item.material_number)))
    .map(catalogMaterialItem);
  return {
    ...listing,
    status: items.length > 0 ? "ready" : "no_results",
    total_count: items.length,
    returned_count: items.length,
    // The original category query is capped, so a local fallback cannot prove
    // that there are no additional eligible rows beyond the returned window.
    truncated: Boolean(listing.truncated),
    items,
    numeric_filter_applied: true,
  };
}

async function filterCatalogListingByEligibleMaterials({ db, versionId, listing, eligibleMaterials }) {
  if (listing.kind !== "materials_by_category" || !listing.category) return listing;
  if (eligibleMaterials.length === 0) {
    return {
      ...listing,
      status: "no_results",
      total_count: 0,
      returned_count: 0,
      truncated: false,
      items: [],
      numeric_filter_applied: true,
    };
  }
  const column = listing.category.level === "parent_family" ? "parent_family" : "family";
  const rows = await queryAll(db, `
    SELECT m.material_number, m.trade_name, m.product_name,
           m.parent_family, m.family, COUNT(*) OVER () AS total_count
    FROM master_materials AS m
    WHERE m.version_id = ? AND m.${column} = ?
      AND m.material_number IN (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      )
    ORDER BY COALESCE(m.trade_name, ''), m.product_name, m.material_number
    LIMIT ?
  `, [
    versionId,
    listing.category.name,
    JSON.stringify(eligibleMaterials.map(String)),
    MASTER_CATEGORY_MATERIAL_LIMIT + 1,
  ]);
  const items = rows.slice(0, MASTER_CATEGORY_MATERIAL_LIMIT).map(catalogMaterialItem);
  const total = Number(rows[0]?.total_count) || items.length;
  return {
    ...listing,
    status: items.length > 0 ? "ready" : "no_results",
    total_count: total,
    returned_count: items.length,
    truncated: total > items.length || rows.length > MASTER_CATEGORY_MATERIAL_LIMIT,
    items,
    numeric_filter_applied: true,
  };
}

async function catalogListingForQuestion({ question, db, versionId }) {
  if (!categoryDiscoveryRequested(question) || inferredIdentifierCandidates(question).length > 0) {
    return { ...EMPTY_CATALOG_LISTING };
  }

  // The category index starts with (version_id, parent_family, family). Reading
  // the small name inventory lets us resolve natural wording to an exact value;
  // the actual material query can then stay on an indexed equality predicate.
  const parentRows = await categoryGroups(db, versionId, "parent_family", 128);
  const parentMatch = categoryNameInQuestion(question, parentRows);
  if (parentMatch) {
    return await materialsInCategory(db, versionId, {
      level: "parent_family",
      name: String(parentMatch.name),
    }, MASTER_CATEGORY_MATERIAL_LIMIT);
  }

  const parentInventoryRequested = /\b(?:parent\s+famil(?:y|ies)|top[ -]level\s+categor(?:y|ies)|product\s+categor(?:y|ies))\b/i.test(question)
    && /\b(?:all|available|catalog|exist|have|list|offer|show|what|which)\b/i.test(question);
  if (parentInventoryRequested || /\b(?:what|which|list|show)\b[^?]*\bcategories\b/i.test(question)) {
    return groupedCategoryListing("parent_families", parentRows, MASTER_CATEGORY_NAME_LIMIT);
  }

  const familyRows = await categoryGroups(db, versionId, "family", 320);
  const familyMatch = categoryNameInQuestion(question, familyRows);
  if (familyMatch) {
    return await materialsInCategory(db, versionId, {
      level: "family",
      name: String(familyMatch.name),
    }, MASTER_CATEGORY_MATERIAL_LIMIT);
  }

  const familyInventoryRequested = /\bfamilies\b/i.test(question)
    && /\b(?:all|available|catalog|exist|have|list|offer|show|what|which)\b/i.test(question);
  if (familyInventoryRequested) {
    return groupedCategoryListing("families", familyRows, MASTER_CATEGORY_NAME_LIMIT);
  }
  return { ...EMPTY_CATALOG_LISTING };
}

async function lexicalSearch({ question, db, versionId, topK }) {
  if (!db) return { status: "not_configured", matches: [] };
  const ftsQuery = buildFtsQuery(question);
  if (!ftsQuery) return { status: "skipped", reason: "no_search_terms", matches: [] };
  try {
    const rows = await queryAll(db, `
      SELECT c.chunk_id, c.material_number, c.chunk_kind, c.parent_family, c.family,
             bm25(master_chunks_fts, 0.0, 0.0, 0.0, 5.0, 1.0) AS bm25_score
      FROM master_chunks_fts
      JOIN master_chunks AS c
        ON c.chunk_id = master_chunks_fts.chunk_id
      WHERE c.version_id = ? AND master_chunks_fts MATCH ?
      ORDER BY bm25_score ASC, c.chunk_id ASC
      LIMIT ?
    `, [versionId, ftsQuery, topK]);
    return {
      status: "ready",
      query: ftsQuery,
      matches: rows.map((row, index) => ({
        id: String(row.chunk_id),
        material_number: row.material_number ? String(row.material_number) : null,
        rank: index + 1,
        score: Number(row.bm25_score),
      })),
    };
  } catch (error) {
    return { status: "fallback", reason: errorMessage(error), matches: [] };
  }
}

const NUMERIC_FIELD_GROUPS = Object.freeze([
  {
    name: "capacity",
    pattern: /\b(?:capacity|load)\b/gi,
    hints: ["capacity", "load"],
    keys: ["capacity_text", "hanger_weight_capacity", "maximum_capacity_imp", "maximum_capacity_metric", "maximum_capacity_rotor", "maximum_loading_weight", "set_capacity", "weigh_beam_capacity"],
    prefixes: ["maximum_capacity_", "set_capacity_"],
  },
  {
    name: "readability",
    pattern: /\b(?:readability|resolution|increment|division)\b/gi,
    hints: ["readability", "resolution", "increment", "division"],
    keys: ["counting_resolution", "measurement_resolution", "readability_imp", "readability_metric", "resolution", "resolution_certified", "temperature_increments"],
    prefixes: ["readability_", "resolution_"],
  },
  {
    name: "speed",
    pattern: /\b(?:speed|rpm|rotation|stirring)\b/gi,
    hints: ["speed", "rpm", "rotation", "stirring"],
    keys: ["maximum_speed", "multiple_maximum_speeds", "rocking_speed", "rotating_speed", "stirring_speed"],
    prefixes: ["speed_"],
  },
  {
    name: "temperature",
    pattern: /\b(?:temperature|temp|heating|cooling)\b/gi,
    hints: ["temperature", "temp", "heating", "cooling"],
    keys: ["accuracy_plus_minus_temperature", "cooling_rate", "operating_range_temp_metric", "storage_temperature_range"],
    prefixes: ["measurement_range_temperature_", "set_temperature_", "temp_", "temperature_"],
  },
  {
    name: "weight",
    pattern: /\b(?:weight|mass)\b/gi,
    hints: ["weight", "mass"],
    keys: ["gross_weight", "maximum_loading_weight", "net_weight", "test_weight", "weight_value"],
    prefixes: ["gross_weight_", "hanger_weight_", "minimum_start_weight_", "minimum_weight_", "net_weight_", "weight_"],
  },
  {
    name: "dimension",
    pattern: /\b(?:dimension|width|height|depth|length|diameter|platform|pan)\b/gi,
    hints: ["dimension", "width", "height", "depth", "length", "diameter", "platform", "pan"],
    keys: ["height", "length", "slot_width", "tube_diameter_without_adapter", "well_depth", "width"],
    prefixes: ["arm_diameter_", "arm_length_", "cable_length_", "dimensions_", "height_", "inner_dimensions_", "length_", "magnetic_platform_size_", "pan_size_", "plate_size_", "platform_size_", "rod_diameter_", "rod_length_", "tray_size_", "well_diameter_", "width_"],
  },
  {
    name: "moisture",
    pattern: /\b(?:humidity|moisture|relative\s+humidity)\b/gi,
    hints: ["humidity", "moisture", "percent"],
    keys: ["moisture_range", "readability_moisture_content", "recommended_moisture_content_mc"],
    prefixes: ["moisture_", "recommended_moisture_"],
  },
]);

const NUMERIC_VALUE_SOURCE = String.raw`-?\d[\d,]*(?:\.\d+)?`;
const NUMERIC_UNIT_SOURCE = String.raw`(?:kg|kilograms?|g|grams?|mg|milligrams?|lb|lbs|pounds?|oz|ounces?|rpm|r\/min|°?c|celsius|°?f|fahrenheit|mm|millimeters?|cm|centimeters?|m|meters?|inches?|inch|in\.?|%|percent|v|volts?|w|watts?|hz)`;
const NUMERIC_UNIT_END_SOURCE = String.raw`(?=$|[^a-z0-9]|rh\b)`;
const NUMERIC_COMPARATOR_SOURCE = String.raw`(?:at\s+least|no\s+less\s+than|minimum|min\.?|greater\s+than|more\s+than|over|above|>=|>|at\s+most|no\s+more\s+than|maximum|max\.?|less\s+than|under|below|up\s+to|<=|<|exactly|equal\s+to|=|about|around|approximately|approx\.?)`;
const NUMERIC_RANGE = new RegExp(
  String.raw`\b(?:between\s+(${NUMERIC_VALUE_SOURCE})\s*(${NUMERIC_UNIT_SOURCE})?\s+and\s+(${NUMERIC_VALUE_SOURCE})\s*(${NUMERIC_UNIT_SOURCE})|from\s+(${NUMERIC_VALUE_SOURCE})\s*(${NUMERIC_UNIT_SOURCE})?\s+to\s+(${NUMERIC_VALUE_SOURCE})\s*(${NUMERIC_UNIT_SOURCE}))${NUMERIC_UNIT_END_SOURCE}`,
  "gi",
);
const NUMERIC_MEASUREMENT = new RegExp(
  String.raw`(?:(${NUMERIC_COMPARATOR_SOURCE})\s*)?(${NUMERIC_VALUE_SOURCE})\s*(${NUMERIC_UNIT_SOURCE})${NUMERIC_UNIT_END_SOURCE}`,
  "gi",
);

function comparatorName(value) {
  const normalized = normalizeCatalogIdentifier(value);
  if (["at least", "no less than", "minimum", "min"].includes(normalized) || value === ">=") return "at_least";
  if (["greater than", "more than", "over", "above"].includes(normalized) || value === ">") return "greater_than";
  if (["at most", "no more than", "maximum", "max", "up to"].includes(normalized) || value === "<=") return "at_most";
  if (["less than", "under", "below"].includes(normalized) || value === "<") return "less_than";
  if (["about", "around", "approximately", "approx"].includes(normalized)) return "approximately";
  return "exact";
}

function nearestNumericField(question, measurementIndex) {
  let nearest = null;
  for (const group of NUMERIC_FIELD_GROUPS) {
    group.pattern.lastIndex = 0;
    for (const match of String(question).matchAll(group.pattern)) {
      const distance = Math.abs((match.index ?? 0) - measurementIndex);
      if (distance <= 80 && (!nearest || distance < nearest.distance)) nearest = { ...group, distance };
    }
  }
  return nearest;
}

function normalizedUnit(value) {
  const unit = normalizedText(value).replace(/[^a-z%]+/g, "");
  const aliases = {
    kilogram: "kg", kilograms: "kg", gram: "g", grams: "g", milligram: "mg", milligrams: "mg",
    lbs: "lb", pound: "lb", pounds: "lb", ounce: "oz", ounces: "oz", rmin: "rpm",
    celsius: "c", fahrenheit: "f", millimeter: "mm", millimeters: "mm",
    centimeter: "cm", centimeters: "cm", meter: "m", meters: "m",
    inch: "in", inches: "in", percent: "%", volt: "v", volts: "v", watt: "w", watts: "w",
  };
  return aliases[unit] ?? unit;
}

export function parseMasterNumericConstraints(question) {
  const text = String(question ?? "");
  const constraints = [];
  const rangeSpans = [];
  NUMERIC_RANGE.lastIndex = 0;
  for (const match of text.matchAll(NUMERIC_RANGE)) {
    const isBetween = match[1] !== undefined;
    const lowerText = isBetween ? match[1] : match[5];
    const lowerUnitText = isBetween ? match[2] : match[6];
    const upperText = isBetween ? match[3] : match[7];
    const upperUnitText = isBetween ? match[4] : match[8];
    const field = nearestNumericField(text, match.index ?? 0);
    const lower = Number(String(lowerText).replaceAll(",", ""));
    const upper = Number(String(upperText).replaceAll(",", ""));
    const lowerUnit = normalizedUnit(lowerUnitText ?? upperUnitText);
    const upperUnit = normalizedUnit(upperUnitText ?? lowerUnitText);
    if (!field || !Number.isFinite(lower) || !Number.isFinite(upper) || !lowerUnit || !upperUnit) continue;
    constraints.push({
      field: field.name,
      field_hints: field.hints,
      comparator: "at_least",
      value: lower,
      unit: lowerUnit,
      text: match[0],
    }, {
      field: field.name,
      field_hints: field.hints,
      comparator: "at_most",
      value: upper,
      unit: upperUnit,
      text: match[0],
    });
    rangeSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    if (constraints.length >= 3) return constraints.slice(0, 3);
  }

  NUMERIC_MEASUREMENT.lastIndex = 0;
  for (const match of text.matchAll(NUMERIC_MEASUREMENT)) {
    const measurementIndex = match.index ?? 0;
    if (rangeSpans.some(([start, end]) => measurementIndex >= start && measurementIndex < end)) continue;
    const field = nearestNumericField(text, measurementIndex);
    if (!field) continue;
    const number = Number(String(match[2]).replaceAll(",", ""));
    if (!Number.isFinite(number)) continue;
    constraints.push({
      field: field.name,
      field_hints: field.hints,
      comparator: comparatorName(match[1] ?? ""),
      value: number,
      unit: normalizedUnit(match[3]),
      text: match[0],
    });
    if (constraints.length >= 3) break;
  }
  return constraints;
}

function canonicalConstraint(constraint) {
  const mass = { kg: 1_000, g: 1, mg: 0.001, lb: 453.59237, oz: 28.349523125 };
  if (mass[constraint.unit]) return { value: constraint.value * mass[constraint.unit], unit: "g" };
  const length = { m: 1_000, cm: 10, mm: 1, in: 25.4 };
  if (length[constraint.unit]) return { value: constraint.value * length[constraint.unit], unit: "mm" };
  if (constraint.field === "temperature" && constraint.unit === "c") return { value: constraint.value, unit: "c" };
  if (constraint.field === "temperature" && constraint.unit === "f") return { value: (constraint.value - 32) * 5 / 9, unit: "c" };
  return null;
}

function compareNumber(value, target, comparator) {
  const epsilon = Math.max(Math.abs(target) * 0.000_001, 1e-9);
  if (comparator === "at_least") return value >= target;
  if (comparator === "greater_than") return value > target;
  if (comparator === "at_most") return value <= target;
  if (comparator === "less_than") return value < target;
  if (comparator === "approximately") return Math.abs(value - target) <= Math.max(Math.abs(target) * 0.1, epsilon);
  return Math.abs(value - target) <= epsilon;
}

function numericComparison(constraint, row) {
  const canonical = canonicalConstraint(constraint);
  const canonicalValue = Number(row?.canonical_number);
  if (canonical && Number.isFinite(canonicalValue) && normalizedUnit(row?.canonical_unit) === canonical.unit) {
    return compareNumber(canonicalValue, canonical.value, constraint.comparator);
  }
  const value = Number(row?.value_number);
  if (!Number.isFinite(value) || normalizedUnit(row?.value_unit) !== constraint.unit) return false;
  return compareNumber(value, constraint.value, constraint.comparator);
}

function rawUnitAliases(unit) {
  const aliases = {
    kg: ["kg", "kilogram", "kilograms"], g: ["g", "gram", "grams"], mg: ["mg", "milligram", "milligrams"],
    lb: ["lb", "lbs", "pound", "pounds"], oz: ["oz", "ounce", "ounces"], rpm: ["rpm", "r/min"],
    c: ["c", "°c", "celsius"], f: ["f", "°f", "fahrenheit"],
    mm: ["mm", "millimeter", "millimeters"], cm: ["cm", "centimeter", "centimeters"],
    m: ["m", "meter", "meters"], in: ["in", "in.", "inch", "inches"],
    "%": ["%", "percent"], v: ["v", "volt", "volts"], w: ["w", "watt", "watts"], hz: ["hz"],
  };
  return aliases[unit] ?? [unit];
}

function comparisonSql(column, constraint, target) {
  if (constraint.comparator === "at_least") return { clause: `${column} >= ?`, parameters: [target] };
  if (constraint.comparator === "greater_than") return { clause: `${column} > ?`, parameters: [target] };
  if (constraint.comparator === "at_most") return { clause: `${column} <= ?`, parameters: [target] };
  if (constraint.comparator === "less_than") return { clause: `${column} < ?`, parameters: [target] };
  const tolerance = constraint.comparator === "approximately"
    ? Math.max(Math.abs(target) * 0.1, 1e-9)
    : Math.max(Math.abs(target) * 0.000_001, 1e-9);
  return { clause: `${column} BETWEEN ? AND ?`, parameters: [target - tolerance, target + tolerance] };
}

function nativeNumericSql(constraint, alias = "a") {
  const aliases = rawUnitAliases(constraint.unit);
  const unitClause = `lower(trim(${alias}.value_unit)) IN (${placeholders(aliases.length)})`;
  const raw = comparisonSql(`${alias}.value_number`, constraint, constraint.value);
  const canonical = canonicalConstraint(constraint);
  if (!canonical) return { clause: `${unitClause} AND ${raw.clause}`, parameters: [...aliases, ...raw.parameters] };
  const canonicalRange = comparisonSql(`${alias}.canonical_number`, constraint, canonical.value);
  return {
    clause: `((${alias}.canonical_unit = ? AND ${canonicalRange.clause}) OR (${alias}.canonical_number IS NULL AND ${unitClause} AND ${raw.clause}))`,
    parameters: [canonical.unit === "c" ? "°C" : canonical.unit, ...canonicalRange.parameters, ...aliases, ...raw.parameters],
  };
}

function numericFieldPredicate(constraint, alias = "a") {
  const group = NUMERIC_FIELD_GROUPS.find((candidate) => candidate.name === constraint.field);
  const keys = [...new Set(group?.keys ?? [])];
  const prefixes = [...new Set(group?.prefixes ?? [])];
  const clauses = [];
  const parameters = [];
  if (keys.length > 0) {
    clauses.push(`${alias}.field_key IN (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )`);
    parameters.push(JSON.stringify(keys));
  }
  // Range predicates are equivalent to a trailing-prefix match for normalized
  // field keys. Packing ranges into one JSON parameter keeps the combined
  // three-constraint query well below D1's bound-parameter limit.
  if (prefixes.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(?) AS prefix_range
      WHERE ${alias}.field_key >= json_extract(prefix_range.value, '$[0]')
        AND ${alias}.field_key < json_extract(prefix_range.value, '$[1]')
    )`);
    parameters.push(JSON.stringify(prefixes.map((prefix) => [prefix, `${prefix}\uffff`])));
  }
  return { clause: clauses.length > 0 ? clauses.join(" OR ") : "0", parameters };
}

function numericEligibilityPredicate(constraints, materialAlias = "m") {
  const clauses = [];
  const parameters = [];
  for (const [index, constraint] of constraints.entries()) {
    const alias = `numeric_${index}`;
    const fieldPredicate = numericFieldPredicate(constraint, alias);
    const valuePredicate = nativeNumericSql(constraint, alias);
    clauses.push(`EXISTS (
      SELECT 1
      FROM master_attributes AS ${alias}
      WHERE ${alias}.version_id = ${materialAlias}.version_id
        AND ${alias}.material_number = ${materialAlias}.material_number
        AND ${alias}.value_number IS NOT NULL
        AND (${fieldPredicate.clause})
        AND ${valuePredicate.clause}
    )`);
    parameters.push(...fieldPredicate.parameters, ...valuePredicate.parameters);
  }
  return { clause: clauses.length > 0 ? clauses.join(" AND ") : "1", parameters };
}

async function nativeNumericEligibleMaterials(db, versionId, constraints) {
  const predicate = numericEligibilityPredicate(constraints);
  const rows = await queryAll(db, `
    SELECT m.material_number
    FROM master_materials AS m
    WHERE m.version_id = ?
      AND ${predicate.clause}
    ORDER BY m.material_number
  `, [versionId, ...predicate.parameters]);
  return [...new Set(rows.map((row) => String(row.material_number)).filter(Boolean))];
}

async function nativeNumericRowsForConstraint({ db, versionId, constraint, eligibleMaterials, topK }) {
  if (eligibleMaterials.length === 0) return [];
  const fieldPredicate = numericFieldPredicate(constraint);
  const valuePredicate = nativeNumericSql(constraint);
  const canonical = canonicalConstraint(constraint);
  const orderColumn = canonical ? "COALESCE(a.canonical_number, a.value_number)" : "a.value_number";
  const orderTarget = canonical?.value ?? constraint.value;
  return await queryAll(db, `
    WITH ranked_attributes AS (
      SELECT a.material_number, a.field_key, a.source_header, a.source_column,
             a.source_ordinal, a.value_number, a.value_unit, a.canonical_number,
             a.canonical_unit, ABS(${orderColumn} - ?) AS numeric_distance,
             ROW_NUMBER() OVER (
               PARTITION BY a.material_number
               ORDER BY ABS(${orderColumn} - ?), a.source_ordinal, a.field_key
             ) AS material_rank
      FROM master_attributes AS a
      WHERE a.version_id = ?
        AND a.material_number IN (
          SELECT CAST(value AS TEXT) FROM json_each(?)
        )
        AND a.value_number IS NOT NULL
        AND (${fieldPredicate.clause})
        AND ${valuePredicate.clause}
    )
    SELECT a.material_number, a.field_key, a.source_header, a.source_column,
           a.value_number, a.value_unit, a.canonical_number, a.canonical_unit,
           (
             SELECT c.chunk_id
             FROM master_chunks AS c
             WHERE c.version_id = ? AND c.material_number = a.material_number
               AND EXISTS (
                 SELECT 1 FROM json_each(c.field_keys_json) AS field_key
                 WHERE field_key.value = a.field_key
               )
             ORDER BY c.chunk_kind, c.chunk_ordinal, c.chunk_id
             LIMIT 1
           ) AS chunk_id
    FROM ranked_attributes AS a
    WHERE a.material_rank = 1
    ORDER BY a.numeric_distance, a.material_number, a.field_key
    LIMIT ?
  `, [
    orderTarget,
    orderTarget,
    versionId,
    JSON.stringify(eligibleMaterials),
    ...fieldPredicate.parameters,
    ...valuePredicate.parameters,
    versionId,
    topK,
  ]);
}

async function resolverNumericRowsForConstraint({ db, versionId, constraint, resolver }) {
  const fieldPredicate = numericFieldPredicate(constraint);
  const canonical = canonicalConstraint(constraint);
  const orderColumn = canonical ? "COALESCE(a.canonical_number, a.value_number)" : "a.value_number";
  const orderTarget = canonical?.value ?? constraint.value;
  const rows = await queryAll(db, `
    SELECT a.material_number, a.field_key, a.source_header, a.source_column,
           a.source_ordinal, a.value_number, a.value_unit, a.canonical_number,
           a.canonical_unit, ABS(${orderColumn} - ?) AS numeric_distance
    FROM master_attributes AS a
    WHERE a.version_id = ? AND a.value_number IS NOT NULL
      AND (${fieldPredicate.clause})
    ORDER BY numeric_distance, a.material_number, a.source_ordinal, a.field_key
  `, [orderTarget, versionId, ...fieldPredicate.parameters]);
  const decisions = await Promise.all(rows.map(async (row) => {
    const defaultMatch = numericComparison(constraint, row);
    const decision = await resolver({ constraint, attribute: row, defaultMatch });
    return decision === undefined ? defaultMatch : Boolean(decision?.matches ?? decision);
  }));
  return rows.filter((_row, index) => decisions[index]);
}

async function hydrateNumericChunkIds(db, versionId, rows) {
  const pairs = [];
  const pairKeys = new Set();
  for (const row of rows) {
    const key = `${row.material_number}|${row.field_key}`;
    if (pairKeys.has(key)) continue;
    pairKeys.add(key);
    pairs.push(row);
  }
  if (pairs.length === 0) return [];
  const clauses = pairs.map(() => `(c.material_number = ? AND field_key.value = ?)`);
  const parameters = pairs.flatMap((row) => [String(row.material_number), String(row.field_key)]);
  const chunks = await queryAll(db, `
    SELECT c.chunk_id, c.material_number, field_key.value AS field_key
    FROM master_chunks AS c, json_each(c.field_keys_json) AS field_key
    WHERE c.version_id = ? AND (${clauses.join(" OR ")})
    ORDER BY c.material_number, c.chunk_kind, c.chunk_ordinal, c.chunk_id
  `, [versionId, ...parameters]);
  const chunkByPair = new Map();
  for (const chunk of chunks) {
    const key = `${chunk.material_number}|${chunk.field_key}`;
    if (!chunkByPair.has(key)) chunkByPair.set(key, String(chunk.chunk_id));
  }
  return pairs.map((row) => ({
    ...row,
    chunk_id: chunkByPair.get(`${row.material_number}|${row.field_key}`) ?? null,
  }));
}

async function numericConstraintSearch({ question, db, versionId, topK, resolver = null }) {
  const constraints = parseMasterNumericConstraints(question);
  if (constraints.length === 0) return { status: "skipped", constraints: [], eligible_materials: [], matches: [] };
  try {
    let eligibleMaterialNumbers;
    let perConstraint;
    if (typeof resolver === "function") {
      const resolvedRows = await Promise.all(constraints.map((constraint) => (
        resolverNumericRowsForConstraint({ db, versionId, constraint, resolver })
      )));
      const materialSets = resolvedRows.map((rows) => new Set(rows.map((row) => String(row.material_number))));
      const eligible = materialSets.length === 0
        ? new Set()
        : new Set([...materialSets[0]].filter((material) => materialSets.slice(1).every((set) => set.has(material))));
      eligibleMaterialNumbers = [...eligible].sort();
      perConstraint = await Promise.all(resolvedRows.map(async (rows) => {
        const bestByMaterial = new Map();
        for (const row of rows) {
          const material = String(row.material_number);
          if (eligible.has(material) && !bestByMaterial.has(material)) bestByMaterial.set(material, row);
        }
        return await hydrateNumericChunkIds(db, versionId, [...bestByMaterial.values()].slice(0, topK));
      }));
    } else {
      // Determine the complete intersection first. Per-constraint evidence is
      // ranked and limited only after all hard requirements have been applied.
      eligibleMaterialNumbers = await nativeNumericEligibleMaterials(db, versionId, constraints);
      perConstraint = await Promise.all(constraints.map((constraint) => (
        nativeNumericRowsForConstraint({
          db,
          versionId,
          constraint,
          eligibleMaterials: eligibleMaterialNumbers,
          topK,
        })
      )));
    }
    const eligibleMaterials = new Set(eligibleMaterialNumbers);
    const matches = [];
    const seen = new Set();
    const maximumRows = Math.max(0, ...perConstraint.map((rows) => rows.length));
    for (let rowIndex = 0; rowIndex < maximumRows && matches.length < topK; rowIndex += 1) {
      for (const rows of perConstraint) {
        const row = rows[rowIndex];
        if (!row) continue;
        if (!eligibleMaterials.has(String(row.material_number))) continue;
        const id = String(row.chunk_id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        matches.push({
          id,
          material_number: String(row.material_number),
          field_key: row.field_key,
          rank: matches.length + 1,
          score: 1,
        });
        if (matches.length >= topK) break;
      }
    }
    return { status: "ready", constraints, eligible_materials: eligibleMaterialNumbers, matches };
  } catch (error) {
    return { status: "fallback", constraints, eligible_materials: [], matches: [], reason: errorMessage(error) };
  }
}

function embeddingVectors(response, expectedCount) {
  const vectors = Array.isArray(response?.data) ? response.data : [];
  if (vectors.length !== expectedCount) throw new Error("Workers AI returned an unexpected embedding count.");
  return vectors.map((entry) => {
    const vector = Array.isArray(entry) ? entry : entry?.embedding;
    if (!Array.isArray(vector) || vector.length !== MASTER_EMBEDDING_DIMENSIONS) {
      throw new Error(`Workers AI embeddings must contain ${MASTER_EMBEDDING_DIMENSIONS} dimensions.`);
    }
    return vector;
  });
}

async function semanticSearch({ question, ai, index, namespace, topK, minimumScore }) {
  if (!ai || !index) return { status: "not_configured", matches: [] };
  if (!namespace) return { status: "not_ready", reason: "missing_namespace", matches: [] };
  try {
    const response = await ai.run(MASTER_EMBEDDING_MODEL, {
      // BGE small accepts 512 input tokens. This conservative word/character cap
      // keeps natural-language catalog questions below the model limit.
      text: [String(question).trim().split(/\s+/).slice(0, 420).join(" ").slice(0, 1_800)],
      pooling: MASTER_EMBEDDING_POOLING,
    });
    const [queryVector] = embeddingVectors(response, 1);
    const result = await index.query(queryVector, {
      namespace,
      topK,
      returnMetadata: "none",
      returnValues: false,
    });
    const rawMatches = result?.matches ?? [];
    const matches = rawMatches
      .filter((match) => (Number(match.score) || 0) >= minimumScore)
      .map((match, indexValue) => ({
        id: String(match.id),
        rank: indexValue + 1,
        score: Number(match.score) || 0,
      }));
    return {
      status: "ready",
      minimum_score: minimumScore,
      discarded_below_threshold: rawMatches.length - matches.length,
      matches,
    };
  } catch (error) {
    return { status: "fallback", reason: errorMessage(error), matches: [] };
  }
}

export function reciprocalRankFuse(resultLists, { constant = 60, limit = 48 } = {}) {
  const fused = new Map();
  for (const list of resultLists ?? []) {
    const weight = Number(list?.weight) || 1;
    for (const [index, match] of (list?.matches ?? []).entries()) {
      const id = String(match?.id ?? "");
      if (!id) continue;
      const rank = Number(match.rank) || index + 1;
      const item = fused.get(id) ?? { id, score: 0, sources: [], source_scores: {} };
      item.score += weight / (constant + rank);
      item.sources.push(list.name);
      item.source_scores[list.name] = Number(match.score) || 0;
      fused.set(id, item);
    }
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

async function chunksByIds(db, versionId, ranked) {
  if (ranked.length === 0) return [];
  const ids = ranked.map((item) => item.id).slice(0, 48);
  const rankById = new Map(ranked.map((item, index) => [item.id, { ...item, fused_rank: index + 1 }]));
  const rows = await queryAll(db, `
    SELECT chunk_id, material_number, chunk_kind, chunk_ordinal, parent_family,
           family, title, content, field_keys_json, metadata_json
    FROM master_chunks
    WHERE version_id = ? AND chunk_id IN (${placeholders(ids.length)})
  `, [versionId, ...ids]);
  return rows
    .map((row) => {
      const metadata = safeJson(row.metadata_json, {});
      return {
        ...row,
        chunk_id: String(row.chunk_id),
        material_number: row.material_number ? String(row.material_number) : null,
        content: truncate(row.content, 1_800),
        field_keys: safeJson(row.field_keys_json, []),
        source_fields: safeJson(row.field_keys_json, []),
        metadata,
        source_file: metadata.source_file ?? null,
        source_sheet: metadata.source_sheet ?? null,
        source_row: metadata.source_row ?? null,
        retrieval: rankById.get(String(row.chunk_id)),
      };
    })
    .filter((row) => row.retrieval)
    .sort((left, right) => left.retrieval.fused_rank - right.retrieval.fused_rank);
}

function exactChunkQueryTerms(question) {
  const terms = new Set(searchTokens(question, 24));
  const text = String(question ?? "");
  const expansions = [
    [/communicat|connect|interface|usb|serial|wifi|ethernet|bluetooth/i, ["connectivity", "communication", "usb", "rs232", "wifi", "ethernet", "bluetooth"]],
    [/dimension|size|width|height|depth|diameter|pan|platform/i, ["physical", "dimension", "width", "height", "depth", "diameter", "pan", "platform"]],
    [/accuracy|capacity|readability|resolution|repeatability|linearity/i, ["performance", "capacity", "readability", "resolution", "repeatability", "linearity"]],
    [/temperature|humidity|environment/i, ["environment", "temperature", "humidity"]],
    [/compliance|certificate|approval|legal|metrology/i, ["compliance", "certificate", "approval", "metrology"]],
    [/application|mode|weigh|count|percent/i, ["applications", "application", "weigh", "count", "percent"]],
    [/\b(?:battery|power|adapter|mains|voltage|ac|dc)\b/i, ["power", "battery", "adapter", "mains", "voltage", "ac", "dc"]],
  ];
  for (const [pattern, additions] of expansions) {
    if (pattern.test(text)) additions.forEach((term) => terms.add(term));
  }
  return [...terms];
}

function exhaustiveMaterialDetailsRequested(question) {
  const text = String(question ?? "");
  // Keep this vocabulary aligned with the agent's expanded-output gate so a
  // request that earns a larger answer also receives the supporting chunks.
  return /\b(?:everything|every detail|all (?:available )?(?:details?|information|specifications?|specs?|fields?)|complete (?:record|specification|details?))\b/i.test(text)
    || /\bfull (?:record|details?|information|specifications?|specs?|fields?)\b/i.test(text);
}

function exactChunkScore(chunk, terms) {
  const kind = normalizedText(chunk.chunk_kind);
  const title = normalizedText(chunk.title);
  const content = normalizedText(chunk.content);
  let score = kind === "identity" ? 1_000 : 0;
  for (const term of terms) {
    if (kind.includes(term)) score += 80;
    if (title.includes(term)) score += 24;
    if (content.includes(term)) score += 6;
  }
  return score;
}

async function chunksForMaterials(db, versionId, materialNumbers, question, perMaterialLimit = 3) {
  if (materialNumbers.length === 0) return [];
  const rows = await queryAll(db, `
    WITH material_chunks AS (
      SELECT chunk_id, material_number, chunk_kind, chunk_ordinal, parent_family,
             family, title, content, field_keys_json, metadata_json,
             ROW_NUMBER() OVER (
               PARTITION BY material_number ORDER BY chunk_kind, chunk_ordinal, chunk_id
             ) AS material_rank
      FROM master_chunks
      WHERE version_id = ? AND material_number IN (${placeholders(materialNumbers.length)})
    )
    SELECT chunk_id, material_number, chunk_kind, chunk_ordinal, parent_family,
           family, title, content, field_keys_json, metadata_json
    FROM material_chunks
    WHERE material_rank <= 24
    ORDER BY material_number, material_rank
  `, [versionId, ...materialNumbers]);
  const terms = exactChunkQueryTerms(question);
  const grouped = new Map();
  for (const row of rows) {
    const material = String(row.material_number);
    const group = grouped.get(material) ?? [];
    group.push(row);
    grouped.set(material, group);
  }
  const rankedRows = [];
  for (const material of materialNumbers.map(String)) {
    const group = grouped.get(material) ?? [];
    const identity = group.filter((row) => row.chunk_kind === "identity").sort((left, right) => left.chunk_ordinal - right.chunk_ordinal)[0];
    const relevant = group
      .filter((row) => row !== identity)
      .map((row) => ({ row, score: exactChunkScore(row, terms) }))
      .sort((left, right) => right.score - left.score || left.row.chunk_ordinal - right.row.chunk_ordinal || String(left.row.chunk_id).localeCompare(String(right.row.chunk_id)))
      .map((entry) => entry.row);
    rankedRows.push(...[identity, ...relevant].filter(Boolean).slice(0, perMaterialLimit));
  }
  return rankedRows.map((row, index) => {
    const metadata = safeJson(row.metadata_json, {});
    return {
      ...row,
      chunk_id: String(row.chunk_id),
      material_number: String(row.material_number),
      content: truncate(row.content, 1_800),
      field_keys: safeJson(row.field_keys_json, []),
      source_fields: safeJson(row.field_keys_json, []),
      metadata,
      source_file: metadata.source_file ?? null,
      source_sheet: metadata.source_sheet ?? null,
      source_row: metadata.source_row ?? null,
      retrieval: { id: String(row.chunk_id), score: 1, sources: ["exact"], source_scores: {}, fused_rank: index + 1 },
    };
  });
}

function materialChunkGroups(chunks) {
  const order = [];
  const groups = new Map();
  for (const chunk of chunks) {
    const material = String(chunk.material_number ?? `family:${chunk.family ?? chunk.chunk_id}`);
    if (!groups.has(material)) {
      groups.set(material, []);
      order.push(material);
    }
    groups.get(material).push(chunk);
  }
  return { order, groups };
}

function roundRobinChunks(chunks, preferredOrder = []) {
  const { order, groups } = materialChunkGroups(chunks);
  const materialOrder = [...new Set([...preferredOrder.map(String), ...order])]
    .filter((material) => groups.has(material));
  const interleaved = [];
  const maximumRows = Math.max(0, ...materialOrder.map((material) => groups.get(material).length));
  for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
    for (const material of materialOrder) {
      const chunk = groups.get(material)[rowIndex];
      if (chunk) interleaved.push(chunk);
    }
  }
  return interleaved;
}

function selectChunks(exactChunks, numericChunks, rankedChunks, maximum, exactPerMaterialLimit = 3) {
  const selected = [];
  const selectedIds = new Set();
  const perMaterial = new Map();
  const exactMaterials = new Set(exactChunks.map((chunk) => String(chunk.material_number ?? "")).filter(Boolean));
  const add = (chunk, materialMaximum) => {
    if (selected.length >= maximum || selectedIds.has(chunk.chunk_id)) return false;
    const material = String(chunk.material_number ?? `family:${chunk.family ?? chunk.chunk_id}`);
    if ((perMaterial.get(material) ?? 0) >= materialMaximum) return false;
    selected.push(chunk);
    selectedIds.add(chunk.chunk_id);
    perMaterial.set(material, (perMaterial.get(material) ?? 0) + 1);
    return true;
  };

  if (exactChunks.length > 0) {
    const { order, groups } = materialChunkGroups(exactChunks);
    const identities = [];
    const details = [];
    for (const material of order) {
      const group = groups.get(material);
      const identity = group.find((chunk) => chunk.chunk_kind === "identity") ?? group[0];
      if (identity) identities.push(identity);
      details.push(...group.filter((chunk) => chunk !== identity));
    }
    const cap = clampInteger(exactPerMaterialLimit, 3, 1, maximum);
    for (const chunk of [...identities, ...roundRobinChunks(details, order), ...numericChunks, ...rankedChunks]) {
      if (selected.length >= maximum) break;
      add(chunk, exactMaterials.has(String(chunk.material_number ?? "")) ? cap : 2);
    }
    return selected;
  }

  if (numericChunks.length > 0) {
    const numericMaterials = new Set(
      numericChunks.map((chunk) => String(chunk.material_number ?? "")).filter(Boolean),
    );
    const allMaterialOrder = [...new Set(
      [...rankedChunks, ...numericChunks]
        .map((chunk) => String(chunk.material_number ?? ""))
        .filter((material) => material && numericMaterials.has(material)),
    )];
    // Reserve room for both qualifying numeric proof and another requested
    // property (for example battery or power) for each leading candidate.
    const shortlisted = allMaterialOrder.slice(0, Math.max(1, Math.floor(maximum / 2)));
    const numericGroups = materialChunkGroups(numericChunks).groups;
    const rankedGroups = materialChunkGroups(rankedChunks).groups;
    for (const material of shortlisted) {
      const numeric = numericGroups.get(material)?.[0];
      if (numeric) add(numeric, 3);
      const complementary = (rankedGroups.get(material) ?? []).find((chunk) => !selectedIds.has(chunk.chunk_id));
      if (complementary && selected.length < maximum) add(complementary, 3);
    }
    const remaining = roundRobinChunks([...numericChunks, ...rankedChunks], shortlisted);
    for (const chunk of remaining) {
      if (selected.length >= maximum) break;
      add(chunk, shortlisted.includes(String(chunk.material_number ?? "")) ? 3 : 1);
    }
    return selected;
  }

  for (const chunk of rankedChunks) {
    if (selected.length >= maximum) break;
    add(chunk, 2);
  }
  return selected;
}

async function materialsByNumbers(db, versionId, materialNumbers) {
  const unique = [...new Set(materialNumbers.map(String).filter(Boolean))].slice(0, 24);
  if (unique.length === 0) return [];
  const rows = await queryAll(db, `
    SELECT m.material_number, m.trade_name, m.product_name, m.parent_family,
           m.family, m.record_json, m.source_row,
           v.source_file, v.source_sheet
    FROM master_materials AS m
    JOIN master_catalog_versions AS v ON v.version_id = m.version_id
    WHERE m.version_id = ? AND m.material_number IN (${placeholders(unique.length)})
  `, [versionId, ...unique]);
  const byMaterial = new Map(rows.map((row) => [String(row.material_number), parseMaterialRow(row)]));
  return unique.flatMap((material) => byMaterial.has(material) ? [byMaterial.get(material)] : []);
}

async function attributesForEvidence(db, versionId, chunks) {
  const materialNumbers = [...new Set((chunks ?? []).map((chunk) => String(chunk.material_number ?? "")).filter(Boolean))].slice(0, 12);
  const fieldKeys = [...new Set((chunks ?? []).flatMap((chunk) => (
    Array.isArray(chunk.field_keys) ? chunk.field_keys : []
  )).map((field) => String(field).replace(/^fields\./, "")).filter(Boolean))].slice(0, 64);
  if (materialNumbers.length === 0 || fieldKeys.length === 0) return [];
  return await queryAll(db, `
    SELECT material_number, field_key, source_header, source_column,
           source_ordinal, value_text, value_number, value_unit, value_json
    FROM master_attributes
    WHERE version_id = ?
      AND material_number IN (${placeholders(materialNumbers.length)})
      AND field_key IN (${placeholders(fieldKeys.length)})
    ORDER BY material_number, source_ordinal
  `, [versionId, ...materialNumbers, ...fieldKeys]);
}

function sourceFieldPaths(chunk) {
  return (Array.isArray(chunk?.source_fields) ? chunk.source_fields : []).flatMap((entry) => {
    if (typeof entry === "string") return [{ path: `fields.${entry}`, field_key: entry, source_column: entry }];
    if (!entry || typeof entry !== "object") return [];
    const fieldKey = String(entry.field_key ?? entry.path ?? entry.field ?? "").replace(/^fields\./, "").trim();
    const path = fieldKey ? `fields.${fieldKey}` : "";
    return path ? [{ path, field_key: fieldKey, source_column: entry.source_column ?? entry.column ?? fieldKey }] : [];
  });
}

function isAllowedEvidenceField(path, includeInternalFields) {
  if (!path || /^(?:source(?:\.|$)|schema_version$|ai_search_index$)/i.test(path)) return false;
  if (/(?:^|\.)(?:relationships|documents|image|image_url)(?:\.|$)/i.test(path)) return false;
  return includeInternalFields || !INTERNAL_FIELD_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

function fieldScore(path, value, queryTokens, preferredPaths) {
  const normalizedPath = normalizedText(path).replace(/[^a-z0-9]+/g, " ");
  const normalizedValue = normalizedText(displayValue(value));
  let score = preferredPaths.has(path) ? 50 : 0;
  if (IDENTITY_FIELDS.includes(path) || IDENTITY_FIELDS.includes(path.replace(/^fields\./, ""))) score += 8;
  for (const token of queryTokens) {
    if (normalizedPath.includes(token)) score += 12;
    if (normalizedValue.includes(token)) score += 2;
  }
  return score;
}

export function selectCompactEvidence({ question, materials, chunks, attributes = [], limit = 16, includeInternalFields = false }) {
  const maximum = clampInteger(limit, 16, 1, 48);
  const queryTokens = searchTokens(question, 18);
  const chunkPathsByMaterial = new Map();
  for (const chunk of chunks ?? []) {
    if (!chunk.material_number) continue;
    const paths = chunkPathsByMaterial.get(String(chunk.material_number)) ?? [];
    paths.push(...sourceFieldPaths(chunk));
    chunkPathsByMaterial.set(String(chunk.material_number), paths);
  }

  const candidates = [];
  const attributeByMaterialPath = new Map((attributes ?? []).map((attribute) => [
    `${attribute.material_number}|fields.${attribute.field_key}`,
    attribute,
  ]));
  for (const record of materials ?? []) {
    const material = String(record.material_number ?? "");
    if (!material) continue;
    const preferredEntries = chunkPathsByMaterial.get(material) ?? [];
    const preferredPaths = new Set(preferredEntries.map((entry) => entry.path));
    const sourceColumnByPath = new Map(preferredEntries.map((entry) => [entry.path, entry.source_column]));
    const flattened = flattenScalars(record);
    for (const { path, value } of flattened) {
      if (!isAllowedEvidenceField(path, includeInternalFields)) continue;
      const displayed = displayValue(value);
      if (displayed === null) continue;
      const score = fieldScore(path, value, queryTokens, preferredPaths);
      if (score <= 0 && !preferredPaths.has(path)) continue;
      const attribute = attributeByMaterialPath.get(`${material}|${path}`);
      candidates.push({
        material_number: material,
        model_or_item: record.model ?? record.trade_name ?? record.product_name ?? material,
        field: path,
        value: displayed,
        source_file: record.source?.file ?? null,
        source_sheet: record.source?.sheet ?? null,
        source_row: record.source?.row ?? null,
        source_header: attribute?.source_header ?? null,
        source_column: attribute?.source_column ?? sourceColumnByPath.get(path) ?? path.replace(/^fields\./, ""),
        score,
      });
    }
  }

  const selected = [];
  const keys = new Set();
  for (const item of candidates.sort((left, right) => right.score - left.score || left.field.localeCompare(right.field))) {
    const key = `${item.material_number}|${item.field}`;
    if (keys.has(key)) continue;
    keys.add(key);
    selected.push(item);
    if (selected.length >= maximum) break;
  }
  return selected.map((item) => ({
    material_number: item.material_number,
    model_or_item: item.model_or_item,
    field: item.field,
    value: item.value,
    source_file: item.source_file,
    source_sheet: item.source_sheet,
    source_row: item.source_row,
    source_header: item.source_header,
    source_column: item.source_column,
  }));
}

function requestedRelationshipTypes(question) {
  const types = [];
  if (/accessor|compatible/i.test(question)) types.push("accessories");
  if (/spare\s*part|replacement\s*part/i.test(question)) types.push("spare_parts");
  if (/cross[ -]?sell/i.test(question)) types.push("cross_selling");
  if (/upsell/i.test(question)) types.push("upsellings");
  if (/replacement/i.test(question)) types.push("replacements");
  if (/service/i.test(question)) types.push("services");
  if (types.length === 0 && /relationship|related/i.test(question)) return ["all"];
  return [...new Set(types)];
}

function requestedRelationshipDirections(question) {
  const asksWhichSourceProduct = /\b(?:which|what)\s+(?:products?|models?|items?|balances?|scales?|instruments?)\b/i.test(question)
    && /\b(?:accept|compatible|fit|fits|support|supports|take|takes|use|uses|using|work|works)\b/i.test(question);
  const explicitReverse = /\b(?:accepted|supported|used)\s+by\b|\bfor\s+(?:which|what)\s+(?:products?|models?|items?)\b/i.test(question);
  const asksForward = /\b(?:accessories|spare\s*parts?|replacement\s*parts?|services?)\b[^?]{0,60}\b(?:for|of|with)\b/i.test(question);
  if (asksWhichSourceProduct || explicitReverse) return ["inbound"];
  if (/\b(?:relationships?|related)\b/i.test(question) && !asksForward) return ["outbound", "inbound"];
  return ["outbound"];
}

async function relationshipRows({ db, versionId, materialNumbers, types, direction, limit }) {
  const matchedColumn = direction === "inbound" ? "r.target_material_number" : "r.source_material_number";
  const relationshipIndex = direction === "inbound" ? "master_relationships_target" : "master_relationships_source";
  const parameters = [versionId, ...materialNumbers];
  let typeClause = "";
  if (!types.includes("all")) {
    typeClause = `AND r.relationship_type IN (${placeholders(types.length)})`;
    parameters.push(...types.map((type) => type.toLowerCase()));
  }
  parameters.push(limit + 1);
  const rows = await queryAll(db, `
    SELECT r.source_material_number, r.relationship_type, r.target_material_number,
           r.target_resolved, r.source_field, r.source_ordinal,
           source.trade_name AS source_model, source.product_name AS source_product_name,
           source.parent_family AS source_parent_family, source.family AS source_family,
           target.trade_name AS target_model, target.product_name AS target_product_name,
           target.parent_family AS target_parent_family, target.family AS target_family
    FROM master_relationships AS r INDEXED BY ${relationshipIndex}
    LEFT JOIN master_materials AS source
      ON source.version_id = r.version_id AND source.material_number = r.source_material_number
    LEFT JOIN master_materials AS target
      ON target.version_id = r.version_id AND target.material_number = r.target_material_number
    WHERE r.version_id = ?
      AND ${matchedColumn} IN (${placeholders(materialNumbers.length)})
      ${typeClause}
    ORDER BY r.relationship_type, r.source_material_number, r.target_material_number
    LIMIT ?
  `, parameters);
  return rows.map((row) => ({
    ...row,
    direction,
    matched_material_number: direction === "inbound" ? String(row.target_material_number) : String(row.source_material_number),
    related_material_number: direction === "inbound" ? String(row.source_material_number) : String(row.target_material_number),
  }));
}

async function expandRelationships({ question, db, versionId, materialNumbers, limit }) {
  const types = requestedRelationshipTypes(question);
  if (materialNumbers.length === 0 || types.length === 0) return { requested: false, results: [], truncated: false };
  const directions = requestedRelationshipDirections(question);
  const settlements = await Promise.allSettled(directions.map((direction) => relationshipRows({
    db,
    versionId,
    materialNumbers,
    types,
    direction,
    limit,
  })));
  const rows = settlements.flatMap((settlement) => settlement.status === "fulfilled" ? settlement.value : []);
  const warnings = settlements.flatMap((settlement, index) => settlement.status === "rejected"
    ? [`${directions[index]} relationship lookup unavailable: ${errorMessage(settlement.reason)}`]
    : []);
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.direction}|${row.source_material_number}|${row.relationship_type}|${row.target_material_number}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  const results = [...unique.values()]
    .sort((left, right) => (
      left.direction.localeCompare(right.direction)
      || String(left.relationship_type).localeCompare(String(right.relationship_type))
      || String(left.source_material_number).localeCompare(String(right.source_material_number))
      || String(left.target_material_number).localeCompare(String(right.target_material_number))
    ));
  return {
    requested: true,
    directions,
    results: results.slice(0, limit),
    truncated: results.length > limit || rows.length > limit,
    warnings,
  };
}

function documentsRequested(question) {
  return /document|manual|data\s*sheet|datasheet|user\s*guide|certificate|brochure/i.test(question);
}

async function expandDocuments({ question, db, versionId, materialNumbers, limit }) {
  if (!documentsRequested(question) || materialNumbers.length === 0) return { requested: false, results: [], truncated: false };
  const rows = await queryAll(db, `
    SELECT material_number, document_type, url, source_field, source_ordinal
    FROM master_documents
    WHERE version_id = ? AND material_number IN (${placeholders(materialNumbers.length)})
    ORDER BY material_number, document_type, url
    LIMIT ?
  `, [versionId, ...materialNumbers, limit + 1]);
  return { requested: true, results: rows.slice(0, limit), truncated: rows.length > limit };
}

function retrievalStrategy(exactCount, lexical, numeric, semantic, catalogListing = null) {
  if (catalogListing?.requested && catalogListing.status === "ready") return "catalog_scope";
  const activeSignals = [lexical, numeric, semantic].filter((signal) => signal.matches.length > 0).length;
  if (activeSignals > 1) return "hybrid_rrf";
  if (numeric.matches.length > 0) return "numeric";
  if (semantic.matches.length > 0) return "semantic";
  if (lexical.matches.length > 0) return "lexical";
  if (exactCount > 0) return "exact";
  return "none";
}

export function buildMasterCatalogPromptContext(bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  const version = bundle.version ?? {};
  return {
    bundle_version: bundle.bundle_version ?? MASTER_CATALOG_BUNDLE_VERSION,
    catalog_scope: {
      version_id: version.version_id ?? null,
      status: version.status ?? null,
      source_file: version.source_file ?? null,
      source_sheet: version.source_sheet ?? null,
      material_count: Number(version.material_count) || 0,
      materials: Number(version.material_count) || 0,
      chunk_count: Number(version.chunk_count) || 0,
      chunks: Number(version.chunk_count) || 0,
      relationship_count: Number(version.relationship_count) || 0,
      relationships: Number(version.relationship_count) || 0,
      document_count: Number(version.document_count) || 0,
      documents: Number(version.document_count) || 0,
    },
    retrieval_strategy: bundle.retrieval?.strategy ?? "none",
    numeric_constraints: (bundle.retrieval?.numeric?.constraints ?? []).slice(0, 3),
    numeric_matches: (bundle.retrieval?.numeric?.matches ?? []).slice(0, 16).map((match) => ({
      material_number: match.material_number,
      field_key: match.field_key,
    })),
    catalog_listing: bundle.catalog_listing?.requested ? {
      status: bundle.catalog_listing.status,
      kind: bundle.catalog_listing.kind,
      category: bundle.catalog_listing.category,
      total_count: Number(bundle.catalog_listing.total_count) || 0,
      returned_count: Number(bundle.catalog_listing.returned_count) || 0,
      truncated: Boolean(bundle.catalog_listing.truncated),
      items: (bundle.catalog_listing.items ?? []).slice(0, MASTER_CATEGORY_NAME_LIMIT),
    } : null,
    exact_matches: (bundle.exact_matches ?? []).slice(0, 8).map((match) => ({
      identifier: match.identifier,
      normalized: match.normalized,
      status: match.status,
      material: match.record ? {
        material_number: match.record.material_number,
        model: match.record.model,
        product_name: match.record.product_name,
      } : null,
      candidates: (match.candidates ?? []).slice(0, 8).map((candidate) => ({
        material_number: candidate.material_number,
        model: candidate.model,
        product_name: candidate.product_name,
      })),
    })),
    materials: (bundle.materials ?? []).slice(0, 12).map((material) => ({
      material_number: material.material_number,
      model: material.model,
      product_name: material.product_name,
      parent_family: material.parent_family,
      family: material.family,
    })),
    chunks: (bundle.chunks ?? []).slice(0, 16).map((chunk) => ({
      chunk_id: chunk.chunk_id,
      material_number: chunk.material_number,
      chunk_kind: chunk.chunk_kind,
      title: chunk.title,
      content: chunk.content,
    })),
    evidence: (bundle.evidence ?? []).slice(0, 24),
    relationships: (bundle.relationships ?? []).slice(0, 40).map((relationship) => ({
      direction: relationship.direction ?? "outbound",
      matched_material_number: relationship.matched_material_number ?? relationship.source_material_number,
      related_material_number: relationship.related_material_number ?? relationship.target_material_number,
      source_material_number: relationship.source_material_number,
      source_model: relationship.source_model ?? null,
      source_product_name: relationship.source_product_name ?? null,
      relationship_type: relationship.relationship_type,
      target_material_number: relationship.target_material_number,
      target_model: relationship.target_model ?? null,
      target_product_name: relationship.target_product_name ?? null,
      target_resolved: relationship.target_resolved,
    })),
    documents: (bundle.documents ?? []).slice(0, 12),
    truncated: {
      relationships: Boolean(bundle.relationships_truncated),
      documents: Boolean(bundle.documents_truncated),
      catalog_listing: Boolean(bundle.catalog_listing?.truncated),
    },
    warnings: (bundle.warnings ?? []).slice(0, 8),
  };
}

/**
 * @param {{
 *   question?: string,
 *   identifiers?: string[],
 *   contextMaterials?: string[],
 *   db?: D1Database | null,
 *   ai?: Ai | null,
 *   index?: VectorizeIndex | null,
 *   versionId?: string | null,
 *   topK?: number,
 *   chunkLimit?: number,
 *   evidenceLimit?: number,
 *   relationshipLimit?: number,
 *   documentLimit?: number,
 *   includeInternalFields?: boolean,
 *   numericConstraintResolver?: ((input: {
 *     constraint: Record<string, unknown>,
 *     attribute: Record<string, unknown>,
 *     defaultMatch: boolean,
 *   }) => boolean | {matches?: boolean} | undefined | Promise<boolean | {matches?: boolean} | undefined>) | null,
 *   semanticScoreThreshold?: number,
 * }} [options]
 */
export async function retrieveMasterCatalog({
  question,
  identifiers = [],
  contextMaterials = [],
  db = null,
  ai = null,
  index = null,
  versionId = null,
  topK = MASTER_DEFAULT_TOP_K,
  chunkLimit = MASTER_DEFAULT_CHUNK_LIMIT,
  evidenceLimit = 16,
  relationshipLimit = 40,
  documentLimit = 12,
  includeInternalFields = false,
  numericConstraintResolver = null,
  semanticScoreThreshold = MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD,
} = {}) {
  const query = String(question ?? "").trim();
  if (!query) return { bundle_version: MASTER_CATALOG_BUNDLE_VERSION, status: "skipped", reason: "empty_question", question: query };
  if (!db) {
    return {
      bundle_version: MASTER_CATALOG_BUNDLE_VERSION,
      status: "not_configured",
      question: query,
      version: null,
      retrieval: { strategy: "none", lexical: { status: "not_configured", matches: [] }, numeric: { status: "not_configured", constraints: [], matches: [] }, semantic: { status: "not_configured", matches: [] } },
      exact_matches: [], catalog_listing: { ...EMPTY_CATALOG_LISTING }, chunks: [], materials: [], evidence: [], relationships: [], documents: [], warnings: ["D1 catalog binding is not configured."],
    };
  }

  const version = versionId ? await versionById(db, versionId) : await activeVersion(db);
  if (!version) {
    return {
      bundle_version: MASTER_CATALOG_BUNDLE_VERSION,
      status: "not_ready",
      question: query,
      version: null,
      retrieval: { strategy: "none", lexical: { status: "not_ready", matches: [] }, numeric: { status: "not_ready", constraints: [], matches: [] }, semantic: { status: "not_ready", matches: [] } },
      exact_matches: [], catalog_listing: { ...EMPTY_CATALOG_LISTING }, chunks: [], materials: [], evidence: [], relationships: [], documents: [], warnings: ["No active master catalog version is available."],
    };
  }

  const requestedTopK = clampInteger(topK, MASTER_DEFAULT_TOP_K, 1, 50);
  const maximumChunks = clampInteger(chunkLimit, MASTER_DEFAULT_CHUNK_LIMIT, 1, 16);
  const warnings = [];
  const inferredIdentifiers = inferredIdentifierCandidates(query);
  const explicitIdentifierLookup = Array.isArray(identifiers) && identifiers.length > 0;
  const contextualIdentifierLookup = !explicitIdentifierLookup
    && inferredIdentifiers.length === 0
    && /\b(?:it|its|that|this|those|these|them)\b/i.test(query)
    && Array.isArray(contextMaterials)
    && contextMaterials.length > 0;
  const identifierLookupAttempted = explicitIdentifierLookup
    || inferredIdentifiers.length > 0
    || contextualIdentifierLookup;
  const lexicalLookupAttempted = Boolean(buildFtsQuery(query));
  const d1Channels = [];
  const candidateHydrationChannels = [];
  const noteD1Channel = (name, succeeded) => {
    d1Channels.push({ name, succeeded: Boolean(succeeded) });
  };
  const noteCandidateHydration = (name, succeeded) => {
    const channel = { name, succeeded: Boolean(succeeded) };
    candidateHydrationChannels.push(channel);
    d1Channels.push(channel);
  };
  const initialSettlements = await Promise.allSettled([
    resolveQuestionIdentifiers({ question: query, identifiers, contextMaterials, db, versionId: version.version_id }),
    lexicalSearch({ question: query, db, versionId: version.version_id, topK: requestedTopK }),
    numericConstraintSearch({
      question: query,
      db,
      versionId: version.version_id,
      topK: requestedTopK,
      resolver: numericConstraintResolver,
    }),
    semanticSearch({
      question: query,
      ai,
      index,
      namespace: version.namespace,
      topK: requestedTopK,
      minimumScore: Math.max(0, Math.min(1, Number(semanticScoreThreshold) || MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD)),
    }),
    catalogListingForQuestion({ question: query, db, versionId: version.version_id }),
  ]);
  const resolved = initialSettlements[0].status === "fulfilled"
    ? initialSettlements[0].value
    : { requested: [], resolutions: [], records: [] };
  const lexical = initialSettlements[1].status === "fulfilled"
    ? initialSettlements[1].value
    : { status: "fallback", reason: errorMessage(initialSettlements[1].reason), matches: [] };
  const numeric = initialSettlements[2].status === "fulfilled"
    ? initialSettlements[2].value
    : { status: "fallback", reason: errorMessage(initialSettlements[2].reason), constraints: [], eligible_materials: [], matches: [] };
  const semantic = initialSettlements[3].status === "fulfilled"
    ? initialSettlements[3].value
    : { status: "fallback", reason: errorMessage(initialSettlements[3].reason), matches: [] };
  let catalogListing = initialSettlements[4].status === "fulfilled"
    ? initialSettlements[4].value
    : { ...EMPTY_CATALOG_LISTING, status: "fallback", reason: errorMessage(initialSettlements[4].reason) };
  if (initialSettlements[0].status === "rejected") {
    warnings.push(`Identifier resolution unavailable: ${errorMessage(initialSettlements[0].reason)}`);
  }
  if (initialSettlements[4].status === "rejected") {
    warnings.push(`Catalog listing unavailable: ${errorMessage(initialSettlements[4].reason)}`);
  }

  const numericConstraints = numeric.constraints ?? [];
  const numericEligible = new Set((numeric.eligible_materials ?? []).map(String));
  const numericRequirementsPresent = numericConstraints.length > 0;
  const hardNumericFilter = numeric.status === "ready" && numericRequirementsPresent;
  if (identifierLookupAttempted) {
    noteD1Channel("identifier_resolution", initialSettlements[0].status === "fulfilled");
  }
  if (lexicalLookupAttempted) {
    noteD1Channel("lexical_search", initialSettlements[1].status === "fulfilled" && lexical.status === "ready");
  }
  if (numericRequirementsPresent) {
    noteD1Channel("numeric_search", initialSettlements[2].status === "fulfilled" && numeric.status === "ready");
  }
  if (initialSettlements[4].status === "rejected") {
    noteD1Channel("catalog_listing", false);
  } else if (catalogListing.requested) {
    noteD1Channel("catalog_listing", catalogListing.status === "ready" || catalogListing.status === "no_results");
  }
  if (hardNumericFilter && catalogListing.kind === "materials_by_category") {
    try {
      catalogListing = await filterCatalogListingByEligibleMaterials({
        db,
        versionId: version.version_id,
        listing: catalogListing,
        eligibleMaterials: [...numericEligible],
      });
    } catch (error) {
      // Never expose the unfiltered category rows as candidates when a hard
      // numeric requirement was understood. The local subset is conservative.
      catalogListing = locallyFilterCatalogListing(catalogListing, [...numericEligible]);
      warnings.push(`Numeric catalog listing hydration fallback: ${errorMessage(error)}`);
    }
  } else if (numericRequirementsPresent && catalogListing.kind === "materials_by_category") {
    // A broad category list must never masquerade as a numerically qualified
    // result if deterministic constraint retrieval was unavailable.
    catalogListing = {
      ...catalogListing,
      status: "fallback",
      reason: "numeric_filter_unavailable",
      total_count: 0,
      returned_count: 0,
      truncated: false,
      items: [],
      numeric_filter_applied: false,
    };
    warnings.push("Numeric catalog filtering was unavailable; unfiltered category candidates were withheld.");
  }

  const fused = reciprocalRankFuse([
    { name: "lexical", weight: 1.1, matches: lexical.matches },
    { name: "numeric", weight: 1.35, matches: numeric.matches },
    { name: "semantic", weight: 1.0, matches: semantic.matches },
  ], { limit: Math.min(48, requestedTopK * 2) });

  let rankedChunks = [];
  let exactChunks = [];
  let numericChunks = [];
  const exactMaterialCount = resolved.records.length;
  const exhaustiveExactLookup = exactMaterialCount > 0 && exhaustiveMaterialDetailsRequested(query);
  const balancedMultiMaterialLookup = exactMaterialCount > 1;
  const exactPerMaterialLimit = exhaustiveExactLookup || balancedMultiMaterialLookup
    ? Math.max(1, Math.floor(maximumChunks / exactMaterialCount))
    : Math.min(3, maximumChunks);
  const selectedChunkLimit = exactMaterialCount === 1 && !exhaustiveExactLookup
    ? Math.min(3, maximumChunks)
    : maximumChunks;
  const chunkSettlements = await Promise.allSettled([
    chunksByIds(db, version.version_id, fused),
    chunksForMaterials(
      db,
      version.version_id,
      resolved.records.map((record) => String(record.material_number)),
      query,
      exactPerMaterialLimit,
    ),
    chunksByIds(db, version.version_id, numeric.matches.map((match, index) => ({
      ...match,
      score: 1,
      sources: ["numeric"],
      source_scores: { numeric: 1 },
      fused_rank: index + 1,
    }))),
  ]);
  if (chunkSettlements[0].status === "fulfilled") rankedChunks = chunkSettlements[0].value;
  else warnings.push(`Ranked chunk hydration unavailable: ${errorMessage(chunkSettlements[0].reason)}`);
  if (chunkSettlements[1].status === "fulfilled") exactChunks = chunkSettlements[1].value;
  else warnings.push(`Exact chunk hydration unavailable: ${errorMessage(chunkSettlements[1].reason)}`);
  if (chunkSettlements[2].status === "fulfilled") numericChunks = chunkSettlements[2].value;
  else warnings.push(`Numeric chunk hydration unavailable: ${errorMessage(chunkSettlements[2].reason)}`);
  if (fused.length > 0) noteCandidateHydration("ranked_chunk_hydration", chunkSettlements[0].status === "fulfilled");
  if (resolved.records.length > 0) noteD1Channel("exact_chunk_hydration", chunkSettlements[1].status === "fulfilled");
  if (numeric.matches.length > 0) noteCandidateHydration("numeric_chunk_hydration", chunkSettlements[2].status === "fulfilled");

  // Parsed numeric requirements are hard constraints for discovery questions,
  // not merely ranking hints. Preserve an explicitly requested SKU so the model
  // can explain why it does or does not qualify, but prevent unrelated semantic
  // neighbors from entering a selection result.
  const eligibleRankedChunks = hardNumericFilter
    ? rankedChunks.filter((chunk) => numericEligible.has(String(chunk.material_number ?? "")))
    : rankedChunks;
  // Exact and deterministic numeric hits are pinned before the fused semantic /
  // lexical list. Per-material caps still prevent one SKU from taking the bundle.
  const chunks = selectChunks(
    exactChunks,
    numericChunks,
    eligibleRankedChunks,
    selectedChunkLimit,
    exactPerMaterialLimit,
  );
  const materialNumbers = [
    ...resolved.records.map((record) => String(record.material_number)),
    ...chunks.map((chunk) => chunk.material_number).filter(Boolean),
  ];
  let materials = resolved.records;
  let materialHydrationSucceeded = false;
  try {
    const hydrated = await materialsByNumbers(db, version.version_id, materialNumbers);
    const byMaterial = new Map([...resolved.records, ...hydrated].map((record) => [String(record.material_number), record]));
    materials = [...new Set(materialNumbers)].flatMap((material) => byMaterial.has(material) ? [byMaterial.get(material)] : []).slice(0, 12);
    materialHydrationSucceeded = true;
  } catch (error) {
    warnings.push(`Material hydration fallback: ${errorMessage(error)}`);
  }
  if (materialNumbers.length > 0) noteD1Channel("material_hydration", materialHydrationSucceeded);

  const expansionMaterials = [...new Set([
    ...resolved.records.map((record) => String(record.material_number)),
    ...materials.map((record) => String(record.material_number)),
  ])].slice(0, 6);
  const relationshipMaterials = [...new Set([
    ...expansionMaterials,
    ...(resolved.requested ?? []).map((identifier) => String(identifier).trim()).filter((identifier) => /^\d{6,12}$/.test(identifier)),
  ])].slice(0, 8);
  let relationshipExpansion = { requested: false, results: [], truncated: false, warnings: [] };
  let documentExpansion = { requested: false, results: [], truncated: false };
  let attributes = [];
  const enrichmentSettlements = await Promise.allSettled([
    expandRelationships({
      question: query,
      db,
      versionId: version.version_id,
      materialNumbers: relationshipMaterials,
      limit: clampInteger(relationshipLimit, 40, 1, 80),
    }),
    expandDocuments({
      question: query,
      db,
      versionId: version.version_id,
      materialNumbers: expansionMaterials,
      limit: clampInteger(documentLimit, 12, 1, 24),
    }),
    attributesForEvidence(db, version.version_id, chunks),
  ]);
  if (enrichmentSettlements[0].status === "fulfilled") {
    relationshipExpansion = enrichmentSettlements[0].value;
    warnings.push(...(relationshipExpansion.warnings ?? []));
  } else {
    warnings.push(`Relationship expansion unavailable: ${errorMessage(enrichmentSettlements[0].reason)}`);
  }
  if (enrichmentSettlements[1].status === "fulfilled") documentExpansion = enrichmentSettlements[1].value;
  else warnings.push(`Document expansion unavailable: ${errorMessage(enrichmentSettlements[1].reason)}`);
  if (enrichmentSettlements[2].status === "fulfilled") attributes = enrichmentSettlements[2].value;
  else warnings.push(`Evidence attribute expansion unavailable: ${errorMessage(enrichmentSettlements[2].reason)}`);

  if (lexical.status === "fallback") warnings.push(`Lexical retrieval unavailable: ${lexical.reason}`);
  if (numeric.status === "fallback") warnings.push(`Numeric constraint retrieval unavailable: ${numeric.reason}`);
  if (semantic.status === "fallback") warnings.push(`Semantic retrieval unavailable: ${semantic.reason}`);
  if (semantic.status === "not_configured") warnings.push("Workers AI or Vectorize is not configured; lexical retrieval was used.");

  const evidence = selectCompactEvidence({
    question: query,
    materials,
    chunks,
    attributes,
    limit: evidenceLimit,
    includeInternalFields,
  });
  const strategy = retrievalStrategy(resolved.records.length, lexical, numeric, semantic, catalogListing);
  const hasResults = resolved.records.length > 0
    || chunks.length > 0
    || materials.length > 0
    || (catalogListing.items?.length ?? 0) > 0
    || relationshipExpansion.results.length > 0;
  const succeededD1Channels = d1Channels.filter((channel) => channel.succeeded).map((channel) => channel.name);
  const failedD1Channels = d1Channels.filter((channel) => !channel.succeeded).map((channel) => channel.name);
  const candidateHydrationUnavailable = !hasResults
    && candidateHydrationChannels.length > 0
    && candidateHydrationChannels.every((channel) => !channel.succeeded);
  const d1RetrievalUnavailable = !hasResults
    && ((d1Channels.length > 0 && succeededD1Channels.length === 0) || candidateHydrationUnavailable);
  const result = {
    bundle_version: MASTER_CATALOG_BUNDLE_VERSION,
    status: d1RetrievalUnavailable
      ? "unavailable"
      : hasResults
        ? "ready"
        : strategy === "none" ? "no_results" : "ready",
    ...(d1RetrievalUnavailable ? { reason: "catalog_retrieval_unavailable" } : {}),
    question: query,
    version,
    retrieval: {
      strategy,
      lexical,
      numeric,
      semantic,
      fused_candidates: fused.length,
      selected_chunks: chunks.length,
      hard_numeric_filter_applied: hardNumericFilter,
      d1_health: {
        status: d1RetrievalUnavailable ? "unavailable" : d1Channels.length > 0 ? "available" : "not_needed",
        attempted_channels: d1Channels.map((channel) => channel.name),
        succeeded_channels: succeededD1Channels,
        failed_channels: failedD1Channels,
      },
    },
    exact_matches: resolved.resolutions,
    catalog_listing: catalogListing,
    chunks,
    materials: materials.map(compactMaterial),
    evidence,
    relationships: relationshipExpansion.results,
    relationships_truncated: relationshipExpansion.truncated,
    documents: documentExpansion.results,
    documents_truncated: documentExpansion.truncated,
    warnings,
  };
  if (d1RetrievalUnavailable) return result;
  return { ...result, prompt_context: buildMasterCatalogPromptContext(result) };
}

async function seedChunkBatch(db, versionId, batchSize, maxAttempts) {
  return await queryAll(db, `
    SELECT p.chunk_id, p.vector_id, p.attempts,
           c.material_number, c.chunk_kind, c.parent_family, c.family,
           c.title, c.content, c.metadata_json
    FROM master_vector_seed_progress AS p
    JOIN master_chunks AS c
      ON c.version_id = p.version_id AND c.chunk_id = p.chunk_id
    WHERE p.version_id = ?
      AND p.status IN ('pending', 'failed')
      AND p.attempts < ?
    ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.chunk_id
    LIMIT ?
  `, [versionId, maxAttempts, batchSize]);
}

function vectorMetadata(row, versionId) {
  const short = (value) => truncate(value, 60);
  const stored = safeJson(row.metadata_json, {});
  return {
    version_id: short(versionId),
    chunk_kind: short(row.chunk_kind ?? "content"),
    material_number: short(row.material_number ?? ""),
    parent_family: short(row.parent_family ?? ""),
    family: short(row.family ?? ""),
    source_sheet: short(stored.source_sheet ?? ""),
    source_row: Number(stored.source_row) || 0,
  };
}

const MASTER_EMBEDDING_PREFIX_FIELDS = Object.freeze([
  { label: "Category", retainLabel: false },
  { label: "Family", retainLabel: true },
  { label: "Material number", retainLabel: false },
  { label: "Product", retainLabel: false },
  { label: "Section", retainLabel: false },
]);

/**
 * Remove labels that duplicate the generated chunk structure before sending
 * text to Workers AI. All five prefix lines must match the importer contract,
 * in order, so similarly named fields in the chunk body remain untouched.
 * Family keeps its label because that distinction helps semantic retrieval.
 */
export function boundedEmbeddingText(value) {
  const source = String(value ?? "").trim();
  const lines = source.split(/\r?\n/);
  const prefixValues = MASTER_EMBEDDING_PREFIX_FIELDS.map(({ label }, index) => {
    const prefix = `${label}:`;
    const line = lines[index] ?? "";
    return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
  });
  if (prefixValues.every((entry) => entry !== null)) {
    for (let index = 0; index < MASTER_EMBEDDING_PREFIX_FIELDS.length; index += 1) {
      const field = MASTER_EMBEDDING_PREFIX_FIELDS[index];
      const fieldValue = prefixValues[index];
      lines[index] = field.retainLabel ? `${field.label}: ${fieldValue}` : fieldValue;
    }
  }
  return lines.join("\n").split(/\s+/).slice(0, 420).join(" ").slice(0, 1_800);
}

async function markSeedRows(db, versionId, rows, { status, mutationId = null, lastError = null }) {
  if (rows.length === 0) return;
  const ids = rows.map((row) => String(row.chunk_id));
  await runStatement(db, `
    UPDATE master_vector_seed_progress
    SET status = ?, attempts = attempts + 1, mutation_id = ?, last_error = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE version_id = ? AND chunk_id IN (${placeholders(ids.length)})
  `, [status, mutationId, lastError, versionId, ...ids]);
}

/**
 * Make exhausted or transiently failed seed rows eligible for another indexing
 * pass. The staged-version predicate is repeated inside the UPDATE so an
 * activation racing this administrative action cannot reset an active catalog.
 */
export async function resetFailedMasterVectorSeed({ db, versionId } = {}) {
  if (!db) {
    throw adminError(
      "catalog_admin_configuration_required",
      "A D1 binding is required to reset failed vector seed rows.",
      503,
    );
  }
  const requestedVersionId = String(versionId ?? "").trim();
  if (!requestedVersionId) {
    throw adminError("catalog_version_required", "A catalog version ID is required.", 400);
  }
  let version;
  try {
    version = await versionById(db, requestedVersionId);
  } catch (error) {
    throw adminError(
      "catalog_validation_unavailable",
      "The catalog version could not be validated before resetting seed rows.",
      503,
      { version_id: requestedVersionId },
      error,
    );
  }
  if (!version) {
    throw adminError("catalog_version_not_found", "The requested catalog version was not found.", 404, { version_id: requestedVersionId });
  }
  if (version.status !== "staged") {
    throw adminError(
      "catalog_version_not_staged",
      "Failed vector seed rows may only be reset for a staged catalog version.",
      409,
      { version_id: version.version_id, version_status: version.status },
    );
  }

  let before;
  try {
    before = await getMasterCatalogSeedStatus({ db, versionId: version.version_id });
    await runStatement(db, `
      UPDATE master_vector_seed_progress
      SET status = 'pending', attempts = 0, mutation_id = NULL, last_error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE version_id = ? AND status = 'failed'
        AND EXISTS (
          SELECT 1 FROM master_catalog_versions AS v
          WHERE v.version_id = ? AND v.status = 'staged'
        )
    `, [version.version_id, version.version_id]);
  } catch (error) {
    throw adminError(
      "catalog_seed_reset_failed",
      "Failed vector seed rows could not be reset. Retry while the version remains staged.",
      503,
      { version_id: version.version_id },
      error,
    );
  }

  let currentVersion;
  let progress;
  try {
    [currentVersion, progress] = await Promise.all([
      versionById(db, version.version_id),
      getMasterCatalogSeedStatus({ db, versionId: version.version_id }),
    ]);
  } catch (error) {
    throw adminError(
      "catalog_seed_reset_verification_failed",
      "Seed rows were updated but the final staged state could not be verified. Inspect seed status before retrying.",
      503,
      { version_id: version.version_id },
      error,
    );
  }
  if (currentVersion?.status !== "staged") {
    throw adminError(
      "catalog_version_not_staged",
      "The catalog version changed state before failed seed rows could be reset.",
      409,
      { version_id: version.version_id, version_status: currentVersion?.status ?? "missing" },
    );
  }
  const resetCount = Math.max(0, Number(before.failed) - Number(progress.failed));
  return {
    status: resetCount > 0 ? "reset" : "unchanged",
    version_id: version.version_id,
    reset_count: resetCount,
    seed_progress: progress,
  };
}

/**
 * @param {{
 *   db: D1Database,
 *   ai: Ai,
 *   index: VectorizeIndex,
 *   versionId: string,
 *   namespace?: string | null,
 *   batchSize?: number,
 *   maxAttempts?: number,
 * }} options
 */
export async function seedMasterVectorizeBatch({
  db,
  ai,
  index,
  versionId,
  namespace = null,
  batchSize = 64,
  maxAttempts = 3,
}) {
  if (!db || !ai || !index) throw new Error("D1, Workers AI, and Vectorize bindings are required for indexing.");
  if (!versionId) throw new Error("A catalog version ID is required for indexing.");
  const version = await versionById(db, versionId);
  if (!version) throw new Error(`Catalog version ${versionId} was not found.`);
  const targetNamespace = masterCatalogNamespace(version.version_id);
  if (namespace && String(namespace).trim() !== targetNamespace) {
    throw new Error(`Catalog namespace must be ${targetNamespace}.`);
  }

  const size = clampInteger(batchSize, 64, 1, 96);
  const attempts = clampInteger(maxAttempts, 3, 1, 10);
  const rows = await seedChunkBatch(db, version.version_id, size, attempts);
  if (rows.length === 0) {
    const progress = await getMasterCatalogSeedStatus({ db, versionId: version.version_id });
    return {
      status: progress.complete ? "complete" : progress.remaining > 0 ? "stalled" : "empty",
      version_id: version.version_id,
      namespace: targetNamespace,
      processed: 0,
      seeded: 0,
      seeded_total: progress.seeded,
      remaining: progress.remaining,
      total: progress.total,
      failed: progress.failed,
      complete: progress.complete,
      progress_exact: true,
      mutation_id: null,
    };
  }
  for (const row of rows) {
    const id = String(row.vector_id ?? "");
    if (!id || textBytes(id) > MASTER_MAX_VECTOR_ID_BYTES) {
      throw new Error(`Vector ID must be non-empty and at most ${MASTER_MAX_VECTOR_ID_BYTES} bytes: ${id || "<empty>"}`);
    }
  }

  let mutation;
  try {
    const embeddingResponse = await ai.run(MASTER_EMBEDDING_MODEL, {
      text: rows.map((row) => boundedEmbeddingText(row.content)),
      pooling: MASTER_EMBEDDING_POOLING,
    });
    const vectors = embeddingVectors(embeddingResponse, rows.length);
    mutation = await index.upsert(rows.map((row, rowIndex) => ({
      id: String(row.vector_id),
      values: vectors[rowIndex],
      namespace: targetNamespace,
      metadata: vectorMetadata(row, version.version_id),
    })));
    await markSeedRows(db, version.version_id, rows, {
      status: "seeded",
      mutationId: mutation?.mutationId ?? mutation?.mutation_id ?? null,
      lastError: null,
    });
  } catch (error) {
    try {
      await markSeedRows(db, version.version_id, rows, {
        status: "failed",
        lastError: truncate(errorMessage(error), 1_000),
      });
    } catch {
      // The original indexing error is more actionable; an unchanged pending row
      // is safe because Vectorize upsert is idempotent for the same vector ID.
    }
    throw error;
  }
  // Counting every seed state after every batch makes a large queue quadratic
  // in D1 rows read. A full-size batch proves that work was available, so defer
  // the exact aggregate until a short final batch (or the next empty request).
  // Activation performs its own exact aggregate and is unaffected by this
  // maintenance-path optimization.
  const progress = rows.length < size
    ? await getMasterCatalogSeedStatus({ db, versionId: version.version_id })
    : null;
  return {
    status: progress?.complete ? "complete" : "in_progress",
    version_id: version.version_id,
    namespace: targetNamespace,
    processed: rows.length,
    seeded: rows.length,
    seeded_total: progress?.seeded ?? null,
    remaining: progress?.remaining ?? null,
    total: progress?.total ?? null,
    failed: progress?.failed ?? null,
    complete: progress?.complete ?? false,
    progress_exact: Boolean(progress),
    mutation_id: mutation?.mutationId ?? mutation?.mutation_id ?? null,
  };
}

async function vectorVisibilitySampleIds(db, versionId) {
  const queries = [
    "ORDER BY p.chunk_id ASC",
    "ORDER BY p.chunk_id DESC",
    "ORDER BY p.updated_at DESC, p.chunk_id DESC",
  ];
  const groups = await Promise.all(queries.map((ordering) => queryAll(db, `
    SELECT p.vector_id
    FROM master_vector_seed_progress AS p
    WHERE p.version_id = ? AND p.status = 'seeded'
    ${ordering}
    LIMIT ?
  `, [versionId, MASTER_VECTOR_VISIBILITY_BUCKET_LIMIT])));
  const sample = [];
  const seen = new Set();
  for (let position = 0; position < MASTER_VECTOR_VISIBILITY_BUCKET_LIMIT; position += 1) {
    for (const group of groups) {
      const vectorId = String(group[position]?.vector_id ?? "");
      if (!vectorId || seen.has(vectorId)) continue;
      seen.add(vectorId);
      sample.push(vectorId);
      if (sample.length >= MASTER_VECTOR_VISIBILITY_SAMPLE_LIMIT) return sample;
    }
  }
  return sample;
}

async function queryVisibleVectorIds(index, vectorIds, namespace) {
  let queryByIdError = null;
  if (typeof index.queryById === "function") {
    try {
      const visibleIds = new Set();
      for (let offset = 0; offset < vectorIds.length; offset += MASTER_VECTOR_QUERY_BATCH_SIZE) {
        const batch = vectorIds.slice(offset, offset + MASTER_VECTOR_QUERY_BATCH_SIZE);
        const results = await Promise.all(batch.map((vectorId) => index.queryById(vectorId, {
          namespace,
          topK: 1,
          returnValues: false,
          returnMetadata: "none",
        })));
        for (const result of results) {
          for (const match of result?.matches ?? []) {
            const id = String(match?.id ?? "");
            // queryById is explicitly scoped to the required namespace. When a
            // provider also returns namespace metadata, reject contradictory data.
            if (id && (match?.namespace == null || String(match.namespace) === namespace)) visibleIds.add(id);
          }
        }
      }
      return visibleIds;
    } catch (error) {
      queryByIdError = error;
    }
  }
  if (typeof index.getByIds === "function") {
    try {
      const vectors = await index.getByIds(vectorIds);
      // getByIds is not namespace-scoped. Only explicit provider metadata can
      // establish that an ID is visible in the catalog version's namespace.
      return new Set((Array.isArray(vectors) ? vectors : [])
        .filter((vector) => String(vector?.namespace ?? "") === namespace)
        .map((vector) => String(vector?.id ?? ""))
        .filter(Boolean));
    } catch (error) {
      if (!queryByIdError) throw error;
    }
  }
  if (queryByIdError) throw queryByIdError;
  throw new Error("No namespace-verifiable Vectorize visibility method is available.");
}

/**
 * @param {{
 *   db: D1Database,
 *   index: VectorizeIndex,
 *   versionId: string,
 *   requiredEvaluation: {
 *     fixture_sha256: string,
 *     fixture_schema_version: string,
 *     source_sha256: string,
 *     fixture_case_count: number,
 *     retrieval_profile_sha256: string,
 *   },
 *   verifyVectorVisibility?: boolean,
 *   visibilityAttempts?: number,
 *   visibilityDelayMs?: number,
 * }} options
 */
export async function activateMasterCatalogVersion({
  db,
  index,
  versionId,
  requiredEvaluation,
  verifyVectorVisibility = true,
  visibilityAttempts = 4,
  visibilityDelayMs = 500,
}) {
  if (!db) {
    throw adminError(
      "catalog_admin_configuration_required",
      "A D1 binding is required to activate a catalog version.",
      503,
    );
  }
  const requestedVersionId = String(versionId ?? "").trim();
  if (!requestedVersionId) {
    throw adminError("catalog_version_required", "A catalog version ID is required for activation.", 400);
  }
  let version;
  try {
    version = await versionById(db, requestedVersionId);
  } catch (error) {
    throw adminError(
      "catalog_validation_unavailable",
      "The catalog version could not be validated before activation.",
      503,
      { version_id: requestedVersionId },
      error,
    );
  }
  if (!version) {
    throw adminError("catalog_version_not_found", "The requested catalog version was not found.", 404, { version_id: requestedVersionId });
  }
  if (version.status !== "staged") {
    throw adminError(
      "catalog_version_not_staged",
      "Only a staged catalog version can be activated.",
      409,
      { version_id: version.version_id, version_status: version.status },
    );
  }

  const evaluation = await requirePassingEvaluation(db, version, requiredEvaluation);
  const actualCounts = await requireMatchingCatalogCounts(db, version);
  const namespace = masterCatalogNamespace(version.version_id);
  let progress;
  try {
    progress = await getMasterCatalogSeedStatus({ db, versionId: version.version_id });
  } catch (error) {
    throw adminError(
      "catalog_validation_unavailable",
      "Vector seed progress could not be validated. Retry before activation.",
      503,
      { version_id: version.version_id },
      error,
    );
  }
  if (progress.total === 0) {
    throw adminError(
      "catalog_seed_queue_empty",
      "The staged catalog has no queued retrieval chunks.",
      409,
      { version_id: version.version_id },
    );
  }
  if (!progress.complete || progress.failed > 0 || progress.pending > 0) {
    throw adminError(
      "catalog_vectors_not_seeded",
      "Catalog vectors are not fully seeded. Finish indexing or reset failed seed rows before activation.",
      409,
      {
        version_id: version.version_id,
        total: progress.total,
        seeded: progress.seeded,
        pending: progress.pending,
        failed: progress.failed,
        remaining: progress.remaining,
      },
    );
  }

  if (verifyVectorVisibility) {
    if (!index || (typeof index.queryById !== "function" && typeof index.getByIds !== "function")) {
      throw adminError(
        "catalog_vector_visibility_required",
        "A Vectorize binding with visibility lookup support is required before activation.",
        503,
        { version_id: version.version_id },
      );
    }
    let sentinelIds;
    try {
      sentinelIds = await vectorVisibilitySampleIds(db, version.version_id);
    } catch (error) {
      throw adminError(
        "catalog_validation_unavailable",
        "Vector visibility samples could not be selected. Retry before activation.",
        503,
        { version_id: version.version_id },
        error,
      );
    }
    const expectedSampleCount = Math.min(MASTER_VECTOR_VISIBILITY_SAMPLE_LIMIT, progress.total);
    if (sentinelIds.length !== expectedSampleCount) {
      throw adminError(
        "catalog_vector_sample_incomplete",
        "The vector seed queue could not provide the required deterministic visibility sample.",
        409,
        {
          version_id: version.version_id,
          expected_sample_count: expectedSampleCount,
          actual_sample_count: sentinelIds.length,
        },
      );
    }
    const attempts = clampInteger(visibilityAttempts, 4, 1, 6);
    const baseDelay = clampInteger(visibilityDelayMs, 500, 0, 5_000);
    let isVisible = false;
    let visibilityError = null;
    let missingIds = sentinelIds;
    for (let attempt = 0; attempt < attempts && !isVisible; attempt += 1) {
      try {
        const visibleIds = await queryVisibleVectorIds(index, sentinelIds, namespace);
        missingIds = sentinelIds.filter((vectorId) => !visibleIds.has(vectorId));
        isVisible = sentinelIds.every((vectorId) => visibleIds.has(vectorId));
      } catch (error) {
        visibilityError = error;
      }
      if (!isVisible && attempt + 1 < attempts && baseDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, baseDelay * (2 ** attempt))));
      }
    }
    if (!isVisible) {
      throw adminError(
        "catalog_vectors_propagating",
        "The staged Vectorize namespace is not fully query-visible yet. Wait for indexing propagation and retry activation.",
        409,
        {
          version_id: version.version_id,
          sample_count: sentinelIds.length,
          missing_count: missingIds.length,
          attempts,
          provider_error: Boolean(visibilityError),
        },
        visibilityError,
      );
    }
  }

  if (typeof db.batch !== "function") {
    throw adminError(
      "catalog_admin_configuration_required",
      "D1 batch support is required for atomic catalog activation.",
      503,
      { version_id: version.version_id },
    );
  }
  const activatedAt = new Date().toISOString();
  const activate = db.prepare(`
    UPDATE master_catalog_versions
    SET status = 'active', activated_at = ?
    WHERE version_id = ? AND status = 'staged'
      AND material_count = (SELECT COUNT(*) FROM master_materials WHERE version_id = ?)
      AND alias_count = (SELECT COUNT(*) FROM master_aliases WHERE version_id = ?)
      AND attribute_count = (SELECT COUNT(*) FROM master_attributes WHERE version_id = ?)
      AND relationship_count = (SELECT COUNT(*) FROM master_relationships WHERE version_id = ?)
      AND document_count = (SELECT COUNT(*) FROM master_documents WHERE version_id = ?)
      AND chunk_count = (SELECT COUNT(*) FROM master_chunks WHERE version_id = ?)
      AND chunk_count = (SELECT COUNT(*) FROM master_chunks_fts WHERE version_id = ?)
      AND chunk_count = (SELECT COUNT(*) FROM master_vector_seed_progress WHERE version_id = ?)
      AND chunk_count = (
        SELECT COUNT(*) FROM master_vector_seed_progress
        WHERE version_id = ? AND status = 'seeded'
      )
      AND EXISTS (
        SELECT 1
        FROM master_catalog_evaluations AS e
        WHERE e.version_id = master_catalog_versions.version_id
          AND e.source_sha256 = master_catalog_versions.source_sha256
          AND e.fixture_sha256 = ?
          AND e.fixture_schema_version = ?
          AND e.fixture_case_count = ?
          AND e.retrieval_profile_sha256 = ?
          AND e.evaluated_at = ?
          AND e.status = 'passed'
          AND e.fixture_case_count > 0
          AND e.evaluated_count = e.fixture_case_count
          AND e.passed_count = e.evaluated_count
          AND e.failed_count = 0
          AND NOT EXISTS (
            SELECT 1
            FROM master_catalog_evaluations AS latest
            WHERE latest.version_id = master_catalog_versions.version_id
              AND latest.source_sha256 = master_catalog_versions.source_sha256
              AND latest.fixture_sha256 = e.fixture_sha256
              AND latest.fixture_schema_version = e.fixture_schema_version
              AND latest.fixture_case_count = e.fixture_case_count
              AND latest.retrieval_profile_sha256 = e.retrieval_profile_sha256
              AND (
                latest.evaluated_at > e.evaluated_at
                OR (latest.evaluated_at = e.evaluated_at AND latest.fixture_sha256 > e.fixture_sha256)
              )
          )
      )
  `).bind(
    activatedAt,
    version.version_id,
    ...Array.from({ length: 9 }, () => version.version_id),
    evaluation.fixture_sha256,
    evaluation.fixture_schema_version,
    evaluation.fixture_case_count,
    evaluation.retrieval_profile_sha256,
    evaluation.evaluated_at,
  );
  const pointState = db.prepare(`
    UPDATE master_catalog_state
    SET active_version_id = ?,
        staged_version_id = CASE WHEN staged_version_id = ? THEN NULL ELSE staged_version_id END,
        updated_at = ?
    WHERE singleton_id = 1
      AND EXISTS (
        SELECT 1 FROM master_catalog_versions AS target
        WHERE target.version_id = ? AND target.status = 'active' AND target.activated_at = ?
      )
  `).bind(version.version_id, version.version_id, activatedAt, version.version_id, activatedAt);
  const retireOthers = db.prepare(`
    UPDATE master_catalog_versions
    SET status = 'retired'
    WHERE status = 'active' AND version_id <> ?
      AND EXISTS (
        SELECT 1
        FROM master_catalog_state AS state
        JOIN master_catalog_versions AS target
          ON target.version_id = state.active_version_id
        WHERE state.singleton_id = 1
          AND state.active_version_id = ?
          AND target.status = 'active'
          AND target.activated_at = ?
      )
  `).bind(version.version_id, version.version_id, activatedAt);
  try {
    const results = await db.batch([activate, pointState, retireOthers]);
    if (Array.isArray(results) && results.some((result) => result?.success === false)) {
      throw new Error("D1 activation batch reported an unsuccessful statement.");
    }
  } catch (error) {
    throw adminError(
      "catalog_activation_write_failed",
      "The atomic catalog activation did not complete. The prior active catalog remains authoritative; retry after checking D1 health.",
      503,
      { version_id: version.version_id },
      error,
    );
  }

  let finalState;
  try {
    finalState = await queryFirst(db, `
      SELECT target.status AS target_status, target.activated_at,
             state.active_version_id,
             (SELECT COUNT(*) FROM master_catalog_versions WHERE status = 'active') AS active_version_count
      FROM master_catalog_versions AS target
      JOIN master_catalog_state AS state ON state.singleton_id = 1
      WHERE target.version_id = ?
      LIMIT 1
    `, [version.version_id]);
  } catch (error) {
    throw adminError(
      "catalog_activation_verification_failed",
      "Catalog activation was written but its final state could not be verified. Inspect catalog status before retrying.",
      503,
      { version_id: version.version_id },
      error,
    );
  }
  const finalActiveCount = Number(finalState?.active_version_count) || 0;
  if (finalState?.target_status !== "active" || finalState?.active_version_id !== version.version_id) {
    throw adminError(
      "catalog_activation_conflict",
      "Another catalog activation won the publish race. Refresh catalog status before retrying.",
      409,
      {
        version_id: version.version_id,
        target_status: finalState?.target_status ?? "missing",
        active_version_id: finalState?.active_version_id ?? null,
      },
    );
  }
  if (finalActiveCount !== 1) {
    throw adminError(
      "catalog_activation_inconsistent",
      "Catalog activation did not converge to exactly one active version. Stop rollout and inspect catalog state.",
      500,
      { version_id: version.version_id, active_version_count: finalActiveCount },
    );
  }
  return {
    status: "active",
    version_id: version.version_id,
    namespace,
    activated_at: finalState.activated_at ?? activatedAt,
    validated_counts: actualCounts,
    evaluation: {
      fixture_sha256: evaluation.fixture_sha256,
      retrieval_profile_sha256: evaluation.retrieval_profile_sha256,
      fixture_case_count: evaluation.fixture_case_count,
      evaluated_at: evaluation.evaluated_at,
    },
  };
}
