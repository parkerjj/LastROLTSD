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
    expect(sql).toMatch(/shop_ids_json MEDIUMTEXT NOT NULL DEFAULT '\[\]'/u);
    expect(sql).not.toMatch(/WITHOUT ROWID|PRAGMA|AUTOINCREMENT|json_each|\?\d+/iu);
  });
});
