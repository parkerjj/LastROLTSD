PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_upload_at INTEGER,
  last_full_snapshot_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  vendor_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  name_normalized TEXT NOT NULL DEFAULT '',
  map_name TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 0 CHECK (x >= 0),
  y INTEGER NOT NULL DEFAULT 0 CHECK (y >= 0),
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, vendor_key)
);

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  shop_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  title_normalized TEXT NOT NULL DEFAULT '',
  shop_type TEXT NOT NULL CHECK (shop_type IN ('buy','sell')),
  map_name TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 0 CHECK (x >= 0),
  y INTEGER NOT NULL DEFAULT 0 CHECK (y >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','closed')),
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, shop_key)
);

CREATE TABLE IF NOT EXISTS shop_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  client_run_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER,
  initial_sync_complete INTEGER NOT NULL DEFAULT 0 CHECK (initial_sync_complete IN (0,1)),
  last_complete_snapshot_id TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_session_id INTEGER NOT NULL REFERENCES shop_sessions(id) ON DELETE CASCADE,
  item_fingerprint TEXT NOT NULL,
  item_key TEXT,
  item_id INTEGER NOT NULL CHECK (item_id >= 0),
  item_name TEXT NOT NULL,
  item_name_normalized TEXT NOT NULL,
  upgrade INTEGER NOT NULL DEFAULT 0 CHECK (upgrade >= 0),
  slots INTEGER NOT NULL DEFAULT 0 CHECK (slots >= 0),
  card0 INTEGER NOT NULL DEFAULT 0,
  card1 INTEGER NOT NULL DEFAULT 0,
  card2 INTEGER NOT NULL DEFAULT 0,
  card3 INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL CHECK (price >= 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  last_quantity INTEGER NOT NULL CHECK (last_quantity >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','missing','sold_out','expired')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  missing_streak INTEGER NOT NULL DEFAULT 0 CHECK (missing_streak >= 0),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  last_batch_id TEXT,
  UNIQUE(shop_session_id, item_fingerprint)
);

CREATE TABLE IF NOT EXISTS listing_options (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL CHECK (option_index >= 0),
  option_type INTEGER NOT NULL,
  option_value INTEGER NOT NULL,
  option_param INTEGER NOT NULL,
  display_value TEXT,
  PRIMARY KEY(listing_id, option_index)
);

CREATE TABLE IF NOT EXISTS option_dictionary (
  version TEXT NOT NULL,
  option_type INTEGER NOT NULL,
  option_value INTEGER NOT NULL,
  option_param INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  search_tokens TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(version, option_type, option_value, option_param)
);

CREATE TABLE IF NOT EXISTS listing_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('first_seen','price_changed','quantity_changed','status_changed')),
  batch_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sold_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sold_quantity INTEGER NOT NULL CHECK (sold_quantity > 0),
  from_quantity INTEGER NOT NULL CHECK (from_quantity >= 0),
  to_quantity INTEGER NOT NULL CHECK (to_quantity >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('quantity_decrease','missing_streak','sold_out')),
  observed_at INTEGER NOT NULL,
  transition_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS upload_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK (part_index >= 0 AND part_index < 16),
  part_count INTEGER NOT NULL CHECK (part_count >= 1 AND part_count <= 16),
  snapshot_mode TEXT NOT NULL CHECK (snapshot_mode IN ('full','delta','heartbeat')),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected','processing')),
  processed_shops INTEGER NOT NULL DEFAULT 0 CHECK (processed_shops >= 0),
  processed_listings INTEGER NOT NULL DEFAULT 0 CHECK (processed_listings >= 0),
  changed_listings INTEGER NOT NULL DEFAULT 0 CHECK (changed_listings >= 0),
  sold_events INTEGER NOT NULL DEFAULT 0 CHECK (sold_events >= 0),
  response_json TEXT,
  received_at INTEGER NOT NULL,
  UNIQUE(source_id, batch_id),
  UNIQUE(source_id, snapshot_id, part_index)
);
