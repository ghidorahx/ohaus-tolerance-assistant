-- Reconcile the historical staged catalog after the version-safe alias delta.
-- The guarded count check makes this a no-op on every other catalog/version.
PRAGMA foreign_keys = ON;

UPDATE master_catalog_versions
SET alias_count = 15800
WHERE version_id = 'mcv_f3213eb213a5f28d58e5f3ab'
  AND schema_version = 'master-catalog-v1'
  AND source_sha256 = '5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb'
  AND status = 'staged'
  AND alias_count = 14293
  AND 15800 = (
    SELECT COUNT(*)
    FROM master_aliases
    WHERE version_id = 'mcv_f3213eb213a5f28d58e5f3ab'
  );
