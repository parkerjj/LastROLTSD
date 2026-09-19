PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS item_catalog (
  item_id INTEGER PRIMARY KEY,
  canonical_name_zh TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_aliases (
  item_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK (alias_kind IN ('legacy','common','variant','approved')),
  data_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, alias_normalized),
  UNIQUE(alias_normalized),
  FOREIGN KEY (item_id) REFERENCES item_catalog(item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_versions (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  alias_count INTEGER NOT NULL CHECK (alias_count >= 0),
  option_count INTEGER NOT NULL DEFAULT 0 CHECK (option_count >= 0),
  importer_version TEXT NOT NULL,
  output_checksum TEXT NOT NULL,
  UNIQUE(version)
);

CREATE TABLE IF NOT EXISTS catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_version TEXT NOT NULL REFERENCES catalog_versions(version),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_catalog_name_normalized
  ON item_catalog(name_normalized, item_id);
CREATE INDEX IF NOT EXISTS idx_item_aliases_normalized
  ON item_aliases(alias_normalized, item_id);
