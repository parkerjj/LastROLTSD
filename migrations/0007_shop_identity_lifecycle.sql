PRAGMA foreign_keys = OFF;

ALTER TABLE shops ADD COLUMN identity_version INTEGER;
ALTER TABLE shops ADD COLUMN identity_hash TEXT;
ALTER TABLE shops ADD COLUMN shop_id TEXT;
ALTER TABLE shops ADD COLUMN vendor_account_id TEXT;
ALTER TABLE shops ADD COLUMN close_reason TEXT;
ALTER TABLE shops ADD COLUMN last_status_observed_at INTEGER;
ALTER TABLE shops ADD COLUMN last_status_batch_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_source_identity
  ON shops(source_id, identity_hash)
  WHERE identity_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_source_shop_id
  ON shops(source_id, shop_id)
  WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shops_source_status_observed
  ON shops(source_id, status, last_status_observed_at);

ALTER TABLE listings RENAME TO listings_before_protocol2;
CREATE TABLE listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_session_id INTEGER NOT NULL REFERENCES shop_sessions(id) ON DELETE CASCADE,
  item_fingerprint TEXT NOT NULL,
  item_key TEXT,
  item_id INTEGER NOT NULL CHECK (item_id >= 0),
  item_name_legacy TEXT,
  item_name_normalized_legacy TEXT,
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
INSERT INTO listings(id,shop_session_id,item_fingerprint,item_key,item_id,item_name_legacy,item_name_normalized_legacy,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,missing_streak,state_version,last_batch_id)
  SELECT id,shop_session_id,item_fingerprint,item_key,item_id,item_name,item_name_normalized,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,missing_streak,state_version,last_batch_id
  FROM listings_before_protocol2;
DROP TABLE listings_before_protocol2;

ALTER TABLE listing_options RENAME TO listing_options_before_protocol2;
CREATE TABLE listing_options (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL CHECK (option_index >= 0),
  option_type INTEGER NOT NULL,
  option_value INTEGER NOT NULL,
  option_param INTEGER NOT NULL,
  display_value_legacy TEXT,
  PRIMARY KEY(listing_id, option_index)
);
INSERT INTO listing_options(listing_id,option_index,option_type,option_value,option_param,display_value_legacy)
  SELECT listing_id,option_index,option_type,option_value,option_param,display_value
  FROM listing_options_before_protocol2;
DROP TABLE listing_options_before_protocol2;

CREATE INDEX IF NOT EXISTS idx_listings_item_fingerprint ON listings(item_id, item_fingerprint);
CREATE INDEX IF NOT EXISTS idx_options_type_value ON listing_options(option_type, option_value, option_param, listing_id);

PRAGMA foreign_keys = ON;
