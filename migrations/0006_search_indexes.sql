CREATE TABLE IF NOT EXISTS search_short_tokens (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('item','shop')),
  scope_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY(scope_type, scope_id, token)
);

CREATE INDEX IF NOT EXISTS idx_search_short_tokens_lookup
  ON search_short_tokens(scope_type, token, scope_id);

CREATE VIRTUAL TABLE IF NOT EXISTS item_search_fts USING fts5(
  item_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS shop_search_fts USING fts5(
  shop_id UNINDEXED,
  text,
  tokenize = 'trigram'
);
