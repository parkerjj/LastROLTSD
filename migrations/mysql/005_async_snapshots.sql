ALTER TABLE upload_batches ADD COLUMN payload_json JSON NULL;
ALTER TABLE market_sources ADD COLUMN active_full_snapshot_id VARCHAR(191) NULL;

ALTER TABLE shops ADD COLUMN full_snapshot_at BIGINT UNSIGNED NULL;
UPDATE shops SET full_snapshot_at = last_changed_at WHERE full_state_hash IS NOT NULL;
ALTER TABLE shops
  ADD COLUMN last_inventory_observed_at BIGINT UNSIGNED NULL,
  ADD COLUMN inventory_epoch_at BIGINT UNSIGNED NULL;
UPDATE shops SET last_inventory_observed_at = last_status_observed_at,
  inventory_epoch_at = CASE WHEN status = 'closed' THEN closed_at ELSE NULL END;

CREATE TABLE market_snapshots (
  source_id VARCHAR(191) NOT NULL,
  snapshot_id VARCHAR(191) NOT NULL,
  client_run_id VARCHAR(191) NOT NULL,
  observed_at BIGINT UNSIGNED NOT NULL,
  part_count INT UNSIGNED NOT NULL,
  accepted_parts INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'receiving',
  stage VARCHAR(32) NOT NULL DEFAULT 'materialize_parts',
  cursor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at BIGINT UNSIGNED NOT NULL,
  lease_until BIGINT UNSIGNED NULL,
  lease_token VARCHAR(64) NULL,
  last_error VARCHAR(128) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  completed_at BIGINT UNSIGNED NULL,
  purged_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (source_id, snapshot_id),
  INDEX idx_snapshots_ready (status, available_at, source_id, snapshot_id),
  INDEX idx_snapshots_source_order (source_id, status, observed_at, snapshot_id),
  INDEX idx_snapshots_cleanup (status, purged_at, completed_at),
  CONSTRAINT fk_snapshots_source FOREIGN KEY (source_id) REFERENCES market_sources(id) ON DELETE CASCADE,
  CONSTRAINT chk_snapshots_parts CHECK (part_count BETWEEN 1 AND 64 AND accepted_parts <= part_count),
  CONSTRAINT chk_snapshots_status CHECK (status IN ('receiving', 'queued', 'running', 'complete', 'failed')),
  CONSTRAINT chk_snapshots_stage CHECK (stage IN ('materialize_parts', 'reconcile_listings', 'reconcile_shops', 'publish_hashes', 'finalize'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE market_snapshot_shops (
  source_id VARCHAR(191) NOT NULL,
  snapshot_id VARCHAR(191) NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  identity_hash CHAR(64) NOT NULL,
  public_shop_id VARCHAR(191) NOT NULL,
  shop_json JSON NOT NULL,
  items_json JSON NOT NULL,
  content_hash CHAR(64) NOT NULL,
  item_count INT UNSIGNED NOT NULL,
  item_cursor INT UNSIGNED NOT NULL DEFAULT 0,
  shop_id BIGINT UNSIGNED NULL,
  baseline_complete BOOLEAN NOT NULL DEFAULT FALSE,
  skip_items BOOLEAN NOT NULL DEFAULT FALSE,
  materialized BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (source_id, snapshot_id, ordinal),
  UNIQUE KEY uq_snapshot_shop_identity (source_id, snapshot_id, identity_hash),
  UNIQUE KEY uq_snapshot_internal_shop (source_id, snapshot_id, shop_id),
  CONSTRAINT fk_snapshot_shops_snapshot FOREIGN KEY (source_id, snapshot_id) REFERENCES market_snapshots(source_id, snapshot_id) ON DELETE CASCADE,
  CONSTRAINT chk_snapshot_item_cursor CHECK (item_cursor <= item_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE market_snapshot_listings (
  source_id VARCHAR(191) NOT NULL,
  snapshot_id VARCHAR(191) NOT NULL,
  shop_ordinal INT UNSIGNED NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  PRIMARY KEY (source_id, snapshot_id, shop_ordinal, fingerprint),
  CONSTRAINT fk_snapshot_listings_shop FOREIGN KEY (source_id, snapshot_id, shop_ordinal) REFERENCES market_snapshot_shops(source_id, snapshot_id, ordinal) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE market_queue_budget (
  utc_day CHAR(10) NOT NULL,
  reserved_operations INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
