/**
 * Source-of-truth names and D1 schema for the versioned master product catalog.
 *
 * Executable migrations live in `migrations/`. Keeping the statements here as
 * plain SQL avoids adding an ORM solely for an offline, append-only import
 * pipeline.
 */

export const masterCatalogTables = {
  versions: "master_catalog_versions",
  evaluations: "master_catalog_evaluations",
  state: "master_catalog_state",
  materials: "master_materials",
  aliases: "master_aliases",
  attributes: "master_attributes",
  relationships: "master_relationships",
  documents: "master_documents",
  chunks: "master_chunks",
  chunksFts: "master_chunks_fts",
  vectorSeedProgress: "master_vector_seed_progress",
} as const;

export type MasterCatalogTable = typeof masterCatalogTables[keyof typeof masterCatalogTables];

export const masterCatalogSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS master_catalog_versions (
    version_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    generator_version TEXT NOT NULL DEFAULT 'legacy',
    source_file TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_bytes INTEGER NOT NULL,
    source_sheet TEXT NOT NULL,
    source_rows INTEGER NOT NULL,
    source_columns INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('loading', 'staged', 'active', 'retired', 'failed')),
    material_count INTEGER NOT NULL DEFAULT 0,
    alias_count INTEGER NOT NULL DEFAULT 0,
    attribute_count INTEGER NOT NULL DEFAULT 0,
    relationship_count INTEGER NOT NULL DEFAULT 0,
    document_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    generated_at TEXT NOT NULL,
    staged_at TEXT,
    activated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS master_catalog_evaluations (
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    fixture_sha256 TEXT NOT NULL CHECK (length(fixture_sha256) = 64 AND fixture_sha256 NOT GLOB '*[^0-9a-f]*'),
    fixture_schema_version TEXT NOT NULL CHECK (length(fixture_schema_version) > 0),
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
    fixture_case_count INTEGER NOT NULL CHECK (fixture_case_count > 0),
    evaluated_count INTEGER NOT NULL CHECK (evaluated_count >= 0 AND evaluated_count <= fixture_case_count),
    passed_count INTEGER NOT NULL CHECK (passed_count >= 0),
    failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'incomplete')),
    evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) > 0),
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    retrieval_profile_sha256 TEXT NOT NULL
      DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
      CHECK (length(retrieval_profile_sha256) = 64 AND retrieval_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (version_id, fixture_sha256, evaluated_at),
    CHECK (passed_count + failed_count = evaluated_count),
    CHECK (
      (status = 'passed' AND evaluated_count = fixture_case_count AND failed_count = 0)
      OR (status = 'failed' AND failed_count > 0)
      OR (status = 'incomplete' AND evaluated_count < fixture_case_count AND failed_count = 0)
    )
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS master_catalog_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    active_version_id TEXT REFERENCES master_catalog_versions(version_id),
    staged_version_id TEXT REFERENCES master_catalog_versions(version_id),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS master_materials (
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    material_number TEXT NOT NULL,
    product_name TEXT NOT NULL,
    parent_family TEXT,
    family TEXT,
    trade_name TEXT,
    ai_summary TEXT,
    ai_search_index TEXT,
    source_row INTEGER NOT NULL,
    record_sha256 TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    PRIMARY KEY (version_id, material_number)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS master_aliases (
    alias_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    material_number TEXT NOT NULL,
    alias_type TEXT NOT NULL,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    FOREIGN KEY (version_id, material_number) REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
    UNIQUE (version_id, material_number, alias_type, normalized_alias)
  )`,
  `CREATE TABLE IF NOT EXISTS master_attributes (
    attribute_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    material_number TEXT NOT NULL,
    field_key TEXT NOT NULL,
    source_header TEXT NOT NULL,
    source_column TEXT NOT NULL,
    source_ordinal INTEGER NOT NULL,
    value_text TEXT NOT NULL,
    value_number REAL,
    value_unit TEXT,
    canonical_number REAL,
    canonical_unit TEXT,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    FOREIGN KEY (version_id, material_number) REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
    UNIQUE (version_id, material_number, field_key)
  )`,
  `CREATE TABLE IF NOT EXISTS master_relationships (
    relationship_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    source_material_number TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    target_material_number TEXT NOT NULL,
    target_resolved INTEGER NOT NULL CHECK (target_resolved IN (0, 1)),
    source_field TEXT NOT NULL,
    source_ordinal INTEGER NOT NULL,
    FOREIGN KEY (version_id, source_material_number) REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
    UNIQUE (version_id, source_material_number, relationship_type, target_material_number)
  )`,
  `CREATE TABLE IF NOT EXISTS master_documents (
    document_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    material_number TEXT NOT NULL,
    document_type TEXT NOT NULL,
    url TEXT NOT NULL,
    source_field TEXT NOT NULL,
    source_ordinal INTEGER NOT NULL,
    FOREIGN KEY (version_id, material_number) REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
    UNIQUE (version_id, material_number, document_type, url)
  )`,
  `CREATE TABLE IF NOT EXISTS master_chunks (
    chunk_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    material_number TEXT NOT NULL,
    parent_family TEXT,
    family TEXT,
    chunk_kind TEXT NOT NULL,
    chunk_ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    field_keys_json TEXT NOT NULL CHECK (json_valid(field_keys_json)),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    FOREIGN KEY (version_id, material_number) REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
    UNIQUE (version_id, material_number, chunk_kind, chunk_ordinal)
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS master_chunks_fts USING fts5(
    chunk_id UNINDEXED,
    version_id UNINDEXED,
    material_number UNINDEXED,
    title,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
  )`,
  `CREATE TABLE IF NOT EXISTS master_vector_seed_progress (
    version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
    chunk_id TEXT NOT NULL REFERENCES master_chunks(chunk_id) ON DELETE CASCADE,
    vector_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'seeded', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    mutation_id TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (version_id, chunk_id)
  ) WITHOUT ROWID`,
] as const;
