CREATE TABLE IF NOT EXISTS guestbook_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category VARCHAR(16) NOT NULL,
  item_id BIGINT UNSIGNED NULL,
  is_zeny TINYINT(1) NOT NULL DEFAULT 0,
  contact VARCHAR(120) NULL,
  content TEXT NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  INDEX idx_guestbook_category_created (category, created_at DESC, id DESC),
  INDEX idx_guestbook_item_created (item_id, created_at DESC, id DESC),
  INDEX idx_guestbook_expires (expires_at),
  CONSTRAINT chk_guestbook_category CHECK (category IN ('buy', 'sell', 'suggestion')),
  CONSTRAINT chk_guestbook_zeny CHECK (is_zeny IN (0, 1)),
  CONSTRAINT chk_guestbook_category_fields CHECK (
    (category = 'suggestion' AND item_id IS NULL AND is_zeny = 0 AND contact IS NULL AND expires_at IS NULL)
    OR (category IN ('buy', 'sell') AND contact IS NOT NULL AND ((is_zeny = 1 AND item_id IS NULL) OR (is_zeny = 0 AND item_id IS NOT NULL)))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS guestbook_rate_limits (
  rate_key CHAR(64) NOT NULL,
  bucket_start BIGINT UNSIGNED NOT NULL,
  request_count INT UNSIGNED NOT NULL,
  PRIMARY KEY (rate_key, bucket_start),
  INDEX idx_guestbook_rate_bucket (bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
