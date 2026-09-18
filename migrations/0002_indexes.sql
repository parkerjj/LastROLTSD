CREATE INDEX IF NOT EXISTS idx_shops_source_status_seen ON shops(source_id, status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_search_item ON listings(item_id, status);
CREATE INDEX IF NOT EXISTS idx_listings_session_status ON listings(shop_session_id, status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);
CREATE INDEX IF NOT EXISTS idx_options_type_value ON listing_options(option_type, option_value, option_param, listing_id);
CREATE INDEX IF NOT EXISTS idx_history_listing_time ON listing_price_history(listing_id, observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sold_transition ON sold_events(transition_key);
CREATE INDEX IF NOT EXISTS idx_batches_snapshot ON upload_batches(source_id, snapshot_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_shop_seen ON shop_sessions(shop_id, last_seen_at DESC);
