-- The production catalog index may already have been created manually.
-- Create it only for fresh/staging databases; do not rebuild existing indexes.
SET @lastroweb_catalog_fts_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE FULLTEXT INDEX ft_item_catalog_names ON item_catalog (name_zh, name, alias_name) WITH PARSER ngram',
    'SELECT 1'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'item_catalog'
    AND index_name = 'ft_item_catalog_names'
);
PREPARE lastroweb_catalog_fts_stmt FROM @lastroweb_catalog_fts_sql;
EXECUTE lastroweb_catalog_fts_stmt;
DEALLOCATE PREPARE lastroweb_catalog_fts_stmt;
