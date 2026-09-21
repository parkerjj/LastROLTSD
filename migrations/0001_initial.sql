PRAGMA foreign_keys = ON;

CREATE TABLE market_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  last_upload_at INTEGER,
  last_full_snapshot_id TEXT,
  last_full_snapshot_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  public_shop_id TEXT NOT NULL,
  vendor_account_id TEXT NOT NULL,
  vendor_name TEXT NOT NULL DEFAULT '',
  vendor_name_normalized TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  title_normalized TEXT NOT NULL DEFAULT '',
  shop_type TEXT NOT NULL CHECK(shop_type IN ('buy','sell')),
  map_name TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 0 CHECK(x >= 0),
  y INTEGER NOT NULL DEFAULT 0 CHECK(y >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','closed')),
  profile_hash TEXT NOT NULL,
  full_state_hash TEXT,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  missing_full_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_full_count >= 0),
  last_missing_snapshot_id TEXT,
  last_status_observed_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT CHECK(close_reason IS NULL OR close_reason IN ('explicit_dismissed','missing_full')),
  UNIQUE(source_id, identity_hash),
  UNIQUE(source_id, public_shop_id)
);

CREATE TABLE listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  item_fingerprint TEXT NOT NULL,
  item_key TEXT,
  item_id INTEGER NOT NULL CHECK(item_id >= 0),
  upgrade INTEGER NOT NULL DEFAULT 0 CHECK(upgrade >= 0),
  slots INTEGER NOT NULL DEFAULT 0 CHECK(slots >= 0),
  card0 INTEGER NOT NULL DEFAULT 0,
  card1 INTEGER NOT NULL DEFAULT 0,
  card2 INTEGER NOT NULL DEFAULT 0,
  card3 INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL CHECK(price >= 0),
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','missing','sold_out','expired')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  missing_full_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_full_count >= 0),
  last_missing_snapshot_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  last_changed_snapshot_id TEXT NOT NULL,
  UNIQUE(shop_id, item_fingerprint)
);

CREATE TABLE listing_options (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL CHECK(option_index >= 0),
  option_type INTEGER NOT NULL,
  option_value INTEGER NOT NULL,
  option_param INTEGER NOT NULL,
  PRIMARY KEY(listing_id, option_index)
) WITHOUT ROWID;

CREATE TABLE listing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('first_seen','state_changed','missing','reappeared','expired')),
  from_price INTEGER,
  to_price INTEGER NOT NULL CHECK(to_price >= 0),
  from_quantity INTEGER,
  to_quantity INTEGER NOT NULL CHECK(to_quantity >= 0),
  sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK(sold_quantity >= 0),
  reason TEXT CHECK(reason IS NULL OR reason IN ('price','quantity_decrease','sold_out','missing_full','reappeared','shop_closed')),
  transition_key TEXT NOT NULL UNIQUE
);

CREATE TABLE upload_batches (
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 15),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 16),
  snapshot_mode TEXT NOT NULL CHECK(snapshot_mode IN ('full','delta','heartbeat')),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','accepted','rejected')),
  shop_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(shop_ids_json)),
  response_json TEXT,
  received_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(source_id, batch_id),
  UNIQUE(source_id, snapshot_id, part_index)
) WITHOUT ROWID;

CREATE INDEX idx_shops_active_directory
  ON shops(title_normalized, vendor_name_normalized, map_name, shop_type, id)
  WHERE status='active';
CREATE INDEX idx_shops_active_filter
  ON shops(map_name, shop_type, id)
  WHERE status='active';
CREATE INDEX idx_shops_source_lifecycle
  ON shops(source_id, status, missing_full_count, id);
CREATE INDEX idx_listings_active_item_price
  ON listings(item_id, price, id)
  WHERE status='active';
CREATE INDEX idx_listings_active_shop_price
  ON listings(shop_id, price, id)
  WHERE status='active';
CREATE INDEX idx_listings_active_price
  ON listings(price, id)
  WHERE status='active';
CREATE INDEX idx_listings_shop_status
  ON listings(shop_id, status, id);
CREATE INDEX idx_listing_options_lookup
  ON listing_options(option_type, option_value, option_param, listing_id);
CREATE INDEX idx_listing_events_history
  ON listing_events(listing_id, observed_at DESC, id DESC);
CREATE INDEX idx_upload_batches_snapshot
  ON upload_batches(source_id, snapshot_id, status, part_index);
