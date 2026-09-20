CREATE INDEX IF NOT EXISTS idx_listings_search_item
  ON listings(item_id, status, price, id);

CREATE INDEX IF NOT EXISTS idx_listings_session_status
  ON listings(shop_session_id, status, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_listings_status_price_id
  ON listings(status, price, id);

CREATE INDEX IF NOT EXISTS idx_listings_status_seen_id
  ON listings(status, last_seen_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_open_shop
  ON shop_sessions(shop_id, id DESC)
  WHERE ended_at IS NULL;

CREATE TABLE listing_price_history_rebuilt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('first_seen','price_changed','quantity_changed','status_changed')),
  batch_id TEXT NOT NULL
);

INSERT INTO listing_price_history_rebuilt(id,listing_id,observed_at,price,quantity,event_type,batch_id)
  SELECT id,listing_id,observed_at,price,quantity,event_type,batch_id
  FROM listing_price_history;

DROP TABLE listing_price_history;
ALTER TABLE listing_price_history_rebuilt RENAME TO listing_price_history;

CREATE UNIQUE INDEX idx_history_batch_event
  ON listing_price_history(listing_id, batch_id, event_type);

CREATE INDEX IF NOT EXISTS idx_history_observed_id
  ON listing_price_history(observed_at, id);

CREATE INDEX IF NOT EXISTS idx_history_listing_id
  ON listing_price_history(listing_id, id DESC);

CREATE TABLE sold_events_rebuilt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sold_quantity INTEGER NOT NULL CHECK (sold_quantity > 0),
  from_quantity INTEGER NOT NULL CHECK (from_quantity >= 0),
  to_quantity INTEGER NOT NULL CHECK (to_quantity >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('quantity_decrease','missing_streak','sold_out')),
  observed_at INTEGER NOT NULL,
  transition_key TEXT NOT NULL UNIQUE
);

INSERT INTO sold_events_rebuilt(id,listing_id,sold_quantity,from_quantity,to_quantity,reason,observed_at,transition_key)
  SELECT id,listing_id,sold_quantity,from_quantity,to_quantity,reason,observed_at,transition_key
  FROM sold_events;

DROP TABLE sold_events;
ALTER TABLE sold_events_rebuilt RENAME TO sold_events;

CREATE UNIQUE INDEX idx_sold_transition
  ON sold_events(transition_key);

CREATE INDEX IF NOT EXISTS idx_sold_observed_id
  ON sold_events(observed_at, id);

CREATE INDEX IF NOT EXISTS idx_sold_listing_id
  ON sold_events(listing_id, id DESC);

CREATE VIRTUAL TABLE item_search_fts_rekeyed USING fts5(
  item_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

INSERT INTO item_search_fts_rekeyed(rowid, item_id, text)
  SELECT CAST(item_id AS INTEGER), item_id, text
  FROM item_search_fts;

DROP TABLE item_search_fts;
ALTER TABLE item_search_fts_rekeyed RENAME TO item_search_fts;
