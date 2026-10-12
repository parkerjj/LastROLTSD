import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

describe('MySQL 8 market schema', () => {
  it('defines the dynamic-market tables without SQLite-only syntax', () => {
    const sql = readFileSync(resolve(repositoryRoot, 'migrations/mysql/001_initial.sql'), 'utf8');

    for (const table of ['market_sources', 'shops', 'listings', 'listing_options', 'listing_events', 'upload_batches']) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}`, 'u'));
    }
    expect(sql).toMatch(/ENGINE=InnoDB/iu);
    expect(sql).toMatch(/UNIQUE KEY .*transition_key/iu);
    expect(sql).toMatch(/INDEX idx_listings_active_item_price \(status, item_id, price, id\)/u);
    expect(sql).toMatch(/shop_ids_json MEDIUMTEXT NOT NULL,/u);
    expect(sql).not.toMatch(/shop_ids_json\s+MEDIUMTEXT\s+NOT\s+NULL\s+DEFAULT/iu);
    expect(sql).toMatch(/transition_key VARCHAR\(255\) NOT NULL/u);
    expect(sql).not.toMatch(/WITHOUT ROWID|PRAGMA|AUTOINCREMENT|json_each|\?\d+/iu);
  });
  it('tracks manually installed production query indexes with safe incremental migrations', () => {
    const fulltext = readFileSync(resolve(repositoryRoot, 'migrations/mysql/008_item_catalog_fulltext.sql'), 'utf8');
    const queryIndexes = readFileSync(resolve(repositoryRoot, 'migrations/mysql/009_read_query_indexes.sql'), 'utf8');

    // Existing migration stays intact and skips the index already present in production.
    expect(fulltext).toContain('CREATE FULLTEXT INDEX ft_item_catalog_names');
    expect(fulltext).toContain('WITH PARSER ngram');
    expect(fulltext).toContain("index_name = 'ft_item_catalog_names'");
    expect(fulltext).toContain('FROM information_schema.statistics');

    // MySQL 8 has no CREATE INDEX IF NOT EXISTS. Use a metadata guard and
    // dynamic DDL for each manually provisioned production index instead.
    expect(queryIndexes).toContain('CREATE INDEX idx_upload_batches_status_completed ON upload_batches (status, completed_at)');
    expect(queryIndexes).toContain('CREATE INDEX idx_listings_active_changed ON listings (status, last_changed_at DESC, id DESC)');
    expect(queryIndexes).toContain("index_name = 'idx_upload_batches_status_completed'");
    expect(queryIndexes).toContain("index_name = 'idx_listings_active_changed'");
    expect(queryIndexes).not.toMatch(/(?:^|\n)\s*CREATE INDEX IF NOT EXISTS/iu);
    expect((queryIndexes.match(/FROM information_schema\.statistics/gu) ?? [])).toHaveLength(2);
    expect((queryIndexes.match(/PREPARE lastroweb_\w+ FROM @lastroweb_\w+;/gu) ?? [])).toHaveLength(2);
    expect((queryIndexes.match(/EXECUTE lastroweb_\w+;/gu) ?? [])).toHaveLength(2);
    expect(queryIndexes).toContain('table_schema = DATABASE()');
  });

});
