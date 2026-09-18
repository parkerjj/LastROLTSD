CREATE TABLE IF NOT EXISTS snapshot_sessions (
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  shop_session_id INTEGER NOT NULL REFERENCES shop_sessions(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(source_id, snapshot_id, shop_session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_history_batch_event ON listing_price_history(listing_id, batch_id, event_type);
CREATE INDEX IF NOT EXISTS idx_snapshot_sessions_lookup ON snapshot_sessions(source_id, snapshot_id, shop_session_id);
