ALTER TABLE market_sources ADD COLUMN retention_cutoff_at BIGINT UNSIGNED NOT NULL DEFAULT 0;
CREATE INDEX idx_market_sources_retention ON market_sources (retention_cutoff_at, id);
CREATE INDEX idx_listing_events_retention ON listing_events (observed_at, id);
CREATE INDEX idx_listings_retention ON listings (status, last_changed_at, id);
CREATE INDEX idx_shops_retention ON shops (status, last_status_observed_at, id);
CREATE INDEX idx_upload_batches_retention ON upload_batches (source_id, received_at);
