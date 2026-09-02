-- Versioned, category-aware master catalog storage for the Ask assistant.
-- Applying this migration does not activate or otherwise expose a catalog.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS master_catalog_versions (
  version_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
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
);

CREATE UNIQUE INDEX IF NOT EXISTS master_catalog_versions_source
  ON master_catalog_versions(source_sha256, schema_version);
CREATE INDEX IF NOT EXISTS master_catalog_versions_status
  ON master_catalog_versions(status);

CREATE TABLE IF NOT EXISTS master_catalog_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_version_id TEXT REFERENCES master_catalog_versions(version_id),
  staged_version_id TEXT REFERENCES master_catalog_versions(version_id),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO master_catalog_state(singleton_id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS master_materials (
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
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS master_materials_category
  ON master_materials(version_id, parent_family, family);
CREATE INDEX IF NOT EXISTS master_materials_trade_name
  ON master_materials(version_id, trade_name);

CREATE TABLE IF NOT EXISTS master_aliases (
  alias_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
  material_number TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  FOREIGN KEY (version_id, material_number)
    REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
  UNIQUE (version_id, material_number, alias_type, normalized_alias)
);

CREATE INDEX IF NOT EXISTS master_aliases_lookup
  ON master_aliases(version_id, normalized_alias, alias_type);

CREATE TABLE IF NOT EXISTS master_attributes (
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
  FOREIGN KEY (version_id, material_number)
    REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
  UNIQUE (version_id, material_number, field_key)
);

CREATE INDEX IF NOT EXISTS master_attributes_field
  ON master_attributes(version_id, field_key, material_number);
CREATE INDEX IF NOT EXISTS master_attributes_numeric
  ON master_attributes(version_id, field_key, canonical_number, canonical_unit)
  WHERE canonical_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS master_relationships (
  relationship_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
  source_material_number TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  target_material_number TEXT NOT NULL,
  target_resolved INTEGER NOT NULL CHECK (target_resolved IN (0, 1)),
  source_field TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  FOREIGN KEY (version_id, source_material_number)
    REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
  UNIQUE (version_id, source_material_number, relationship_type, target_material_number)
);

CREATE INDEX IF NOT EXISTS master_relationships_source
  ON master_relationships(version_id, source_material_number, relationship_type);
CREATE INDEX IF NOT EXISTS master_relationships_target
  ON master_relationships(version_id, target_material_number, relationship_type);

CREATE TABLE IF NOT EXISTS master_documents (
  document_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
  material_number TEXT NOT NULL,
  document_type TEXT NOT NULL,
  url TEXT NOT NULL,
  source_field TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  FOREIGN KEY (version_id, material_number)
    REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
  UNIQUE (version_id, material_number, document_type, url)
);

CREATE INDEX IF NOT EXISTS master_documents_material
  ON master_documents(version_id, material_number, document_type);

CREATE TABLE IF NOT EXISTS master_chunks (
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
  FOREIGN KEY (version_id, material_number)
    REFERENCES master_materials(version_id, material_number) ON DELETE CASCADE,
  UNIQUE (version_id, material_number, chunk_kind, chunk_ordinal)
);

CREATE INDEX IF NOT EXISTS master_chunks_scope
  ON master_chunks(version_id, parent_family, family, chunk_kind);

CREATE VIRTUAL TABLE IF NOT EXISTS master_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  version_id UNINDEXED,
  material_number UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS master_vector_seed_progress (
  version_id TEXT NOT NULL REFERENCES master_catalog_versions(version_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES master_chunks(chunk_id) ON DELETE CASCADE,
  vector_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'seeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (version_id, chunk_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS master_vector_seed_queue
  ON master_vector_seed_progress(version_id, status, attempts);

CREATE TRIGGER IF NOT EXISTS master_chunks_after_insert
AFTER INSERT ON master_chunks
BEGIN
  INSERT INTO master_chunks_fts(rowid, chunk_id, version_id, material_number, title, content)
  VALUES (new.rowid, new.chunk_id, new.version_id, new.material_number, new.title, new.content);

  INSERT OR IGNORE INTO master_vector_seed_progress(
    version_id, chunk_id, vector_id, status, attempts, updated_at
  ) VALUES (
    new.version_id, new.chunk_id, new.chunk_id, 'pending', 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER IF NOT EXISTS master_chunks_after_delete
AFTER DELETE ON master_chunks
BEGIN
  DELETE FROM master_chunks_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS master_chunks_after_update
AFTER UPDATE OF title, content ON master_chunks
BEGIN
  DELETE FROM master_chunks_fts WHERE rowid = old.rowid;
  INSERT INTO master_chunks_fts(rowid, chunk_id, version_id, material_number, title, content)
  VALUES (new.rowid, new.chunk_id, new.version_id, new.material_number, new.title, new.content);
  UPDATE master_vector_seed_progress
  SET status = 'pending', attempts = 0, mutation_id = NULL, last_error = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE version_id = new.version_id AND chunk_id = new.chunk_id;
END;
