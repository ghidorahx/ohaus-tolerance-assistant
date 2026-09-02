-- Add generator-aware catalog identity and persist retrieval evaluation runs.
-- Existing catalog versions are retained as legacy-generated artifacts.
PRAGMA foreign_keys = ON;

ALTER TABLE master_catalog_versions
  ADD COLUMN generator_version TEXT NOT NULL DEFAULT 'legacy';

-- This staged version predates generator-aware IDs, but its tracked manifest
-- records the exact importer that produced it. Preserve that provenance while
-- leaving every unknown historical version explicitly marked as legacy.
UPDATE master_catalog_versions
SET generator_version = '1.1.0'
WHERE version_id = 'mcv_f3213eb213a5f28d58e5f3ab'
  AND schema_version = 'master-catalog-v1'
  AND source_sha256 = '5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb'
  AND generator_version = 'legacy';

DROP INDEX IF EXISTS master_catalog_versions_source;
CREATE UNIQUE INDEX master_catalog_versions_source
  ON master_catalog_versions(source_sha256, schema_version, generator_version);

CREATE TABLE IF NOT EXISTS master_catalog_evaluations (
  version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
  fixture_sha256 TEXT NOT NULL
    CHECK (length(fixture_sha256) = 64 AND fixture_sha256 NOT GLOB '*[^0-9a-f]*'),
  fixture_schema_version TEXT NOT NULL CHECK (length(fixture_schema_version) > 0),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  fixture_case_count INTEGER NOT NULL CHECK (fixture_case_count > 0),
  evaluated_count INTEGER NOT NULL
    CHECK (evaluated_count >= 0 AND evaluated_count <= fixture_case_count),
  passed_count INTEGER NOT NULL CHECK (passed_count >= 0),
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'incomplete')),
  evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) > 0),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  PRIMARY KEY (version_id, fixture_sha256, evaluated_at),
  CHECK (passed_count + failed_count = evaluated_count),
  CHECK (
    (status = 'passed' AND evaluated_count = fixture_case_count AND failed_count = 0)
    OR (status = 'failed' AND failed_count > 0)
    OR (status = 'incomplete' AND evaluated_count < fixture_case_count AND failed_count = 0)
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS master_catalog_evaluations_latest
  ON master_catalog_evaluations(version_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS master_catalog_evaluations_status
  ON master_catalog_evaluations(status, evaluated_at DESC);
