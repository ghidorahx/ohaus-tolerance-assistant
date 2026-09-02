-- Bind every saved retrieval score to the exact retrieval/evaluator build.
-- The all-zero default deliberately invalidates evaluations written before
-- this migration; they must be rerun against the currently deployed profile.
PRAGMA foreign_keys = ON;

ALTER TABLE master_catalog_evaluations
  ADD COLUMN retrieval_profile_sha256 TEXT NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (
      length(retrieval_profile_sha256) = 64
      AND retrieval_profile_sha256 NOT GLOB '*[^0-9a-f]*'
    );

CREATE INDEX IF NOT EXISTS master_catalog_evaluations_build_latest
  ON master_catalog_evaluations(version_id, retrieval_profile_sha256, evaluated_at DESC);
