-- Align fresh databases with the two query indexes already created manually
-- in production. MySQL 8 does not support CREATE INDEX IF NOT EXISTS.
-- Do not alter 001_initial.sql or an already tracked migration checksum.
--
-- An existing named index is left untouched. The deploy's schema_migrations
-- table separately prevents running this file again once recorded.

-- Speeds up SELECT MAX(completed_at) FROM upload_batches WHERE status='accepted'.
SET @lastroweb_batches_index_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_upload_batches_status_completed ON upload_batches (status, completed_at)',
    'SELECT 1'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'upload_batches'
    AND index_name = 'idx_upload_batches_status_completed'
);
PREPARE lastroweb_batches_index_stmt FROM @lastroweb_batches_index_ddl;
EXECUTE lastroweb_batches_index_stmt;
DEALLOCATE PREPARE lastroweb_batches_index_stmt;

-- Allows the active-listings query to follow last_changed_at/id order
-- directly instead of scanning and sorting all active listings.
SET @lastroweb_listings_index_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_listings_active_changed ON listings (status, last_changed_at DESC, id DESC)',
    'SELECT 1'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'listings'
    AND index_name = 'idx_listings_active_changed'
);
PREPARE lastroweb_listings_index_stmt FROM @lastroweb_listings_index_ddl;
EXECUTE lastroweb_listings_index_stmt;
DEALLOCATE PREPARE lastroweb_listings_index_stmt;
