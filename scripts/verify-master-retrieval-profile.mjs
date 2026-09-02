import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  MASTER_CATALOG_BUNDLE_VERSION,
  MASTER_DEFAULT_CHUNK_LIMIT,
  MASTER_DEFAULT_SEMANTIC_SCORE_THRESHOLD,
  MASTER_DEFAULT_TOP_K,
  MASTER_EMBEDDING_DIMENSIONS,
  MASTER_EMBEDDING_MODEL,
  MASTER_EMBEDDING_POOLING,
  MASTER_VECTORIZE_INDEX,
  MASTER_VECTORIZE_METRIC,
} from "../lib/master-catalog-rag.mjs";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINGERPRINT_SCHEMA_VERSION = "1.0.0";
const RETRIEVAL_CODE_FILES = [
  "lib/master-catalog-rag.mjs",
  "app/api/sales/route.ts",
  "scripts/evaluate-master-retrieval.mjs",
  "scripts/verify-master-retrieval-profile.mjs",
  "scripts/build-master-retrieval-eval.py",
];

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

export function retrievalProfileFingerprintPayload(profile) {
  return {
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
}

export async function currentRetrievalBuild(appRoot = defaultAppRoot) {
  const codeFiles = await Promise.all(RETRIEVAL_CODE_FILES.map(async (relativePath) => ({
    path: relativePath,
    sha256: await fileSha256(path.join(appRoot, relativePath)),
  })));
  const deployConfig = JSON.parse(await readFile(path.join(appRoot, "wrangler.deploy.jsonc"), "utf8"));
  const catalogBindings = (deployConfig.vectorize ?? [])
    .filter((binding) => binding.binding === "CATALOG_VECTORIZE");
  if (catalogBindings.length !== 1) {
    throw new Error("Expected exactly one CATALOG_VECTORIZE binding in wrangler.deploy.jsonc.");
  }
  const configuredIndex = String(catalogBindings[0].index_name ?? "").trim();
  if (configuredIndex !== MASTER_VECTORIZE_INDEX) {
    throw new Error("CATALOG_VECTORIZE does not match MASTER_VECTORIZE_INDEX.");
  }
  return {
    retrieval_code_sha256: sha256(canonicalize(codeFiles)),
    code_files: codeFiles,
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
      index_name: configuredIndex,
      dimensions: MASTER_EMBEDDING_DIMENSIONS,
      metric: MASTER_VECTORIZE_METRIC,
    },
  };
}

export async function verifyMasterRetrievalProfile({
  appRoot = defaultAppRoot,
  fixturePath = path.join(appRoot, "data/master-retrieval-eval.json"),
  profilePath = path.join(appRoot, "data/master-retrieval-eval-profile.json"),
} = {}) {
  const [fixtureRaw, profileRaw] = await Promise.all([
    readFile(fixturePath),
    readFile(profilePath, "utf8"),
  ]);
  const fixture = JSON.parse(fixtureRaw.toString("utf8"));
  const profile = JSON.parse(profileRaw);
  const requiredCases = (fixture.cases ?? [])
    .filter((entry) => entry?.expected?.answerability !== "unsupported_live_data");
  const unsupportedCases = (fixture.cases ?? [])
    .filter((entry) => entry?.expected?.answerability === "unsupported_live_data");
  const currentBuild = await currentRetrievalBuild(appRoot);

  const mismatches = [];
  if (profile.profile_version !== "2.0.0") mismatches.push("profile_version");
  if (profile.fingerprint_schema_version !== FINGERPRINT_SCHEMA_VERSION) mismatches.push("fingerprint_schema_version");
  if (profile.fixture_file !== path.basename(fixturePath)) mismatches.push("fixture_file");
  if (profile.fixture_sha256 !== sha256(fixtureRaw)) mismatches.push("fixture_sha256");
  if (profile.fixture_schema_version !== fixture.schema_version) mismatches.push("fixture_schema_version");
  if (profile.source_sha256 !== fixture.source?.sha256) mismatches.push("source_sha256");
  if (profile.fixture_case_count !== requiredCases.length) mismatches.push("fixture_case_count");
  if (profile.raw_fixture_case_count !== fixture.cases?.length) mismatches.push("raw_fixture_case_count");
  if (profile.unsupported_case_count !== unsupportedCases.length) mismatches.push("unsupported_case_count");
  if (canonicalize(profile.retrieval_build) !== canonicalize(currentBuild)) mismatches.push("retrieval_build");

  const expectedFingerprint = sha256(canonicalize(retrievalProfileFingerprintPayload({
    ...profile,
    retrieval_build: currentBuild,
  })));
  if (profile.retrieval_profile_sha256 !== expectedFingerprint) mismatches.push("retrieval_profile_sha256");
  if (mismatches.length > 0) {
    throw new Error(
      `Master retrieval profile is stale or invalid (${mismatches.join(", ")}). `
      + "Rebuild it with scripts/build-master-retrieval-eval.py before building or deploying.",
    );
  }
  return {
    fixture_sha256: profile.fixture_sha256,
    retrieval_profile_sha256: profile.retrieval_profile_sha256,
    required_case_count: requiredCases.length,
    raw_case_count: fixture.cases.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyMasterRetrievalProfile();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
