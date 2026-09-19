import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('D1 migrations', () => {
  it('declares the required tables and source-scoped uniqueness', () => {
    const initial = readFileSync(resolve(process.cwd(), 'migrations/0001_initial.sql'), 'utf8');
    const indexes = readFileSync(resolve(process.cwd(), 'migrations/0002_indexes.sql'), 'utf8');
    for (const table of ['market_sources','vendors','shops','shop_sessions','listings','listing_options','option_dictionary','listing_price_history','sold_events','upload_batches']) {
      expect(initial).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(initial).toContain('UNIQUE(source_id, batch_id)');
    expect(initial).toContain('UNIQUE(source_id, snapshot_id, part_index)');
    expect(initial).not.toContain('CREATE TABLE IF NOT EXISTS snapshot_sessions');
    const followup = readFileSync(resolve(process.cwd(), 'migrations/0004_history_idempotency.sql'), 'utf8');
    expect(followup).toContain('CREATE TABLE IF NOT EXISTS snapshot_sessions');
    expect(followup).toContain('idx_history_batch_event');
    expect(initial).toContain('UNIQUE(source_id, shop_key)');
    expect(initial).toContain('UNIQUE(shop_session_id, item_fingerprint)');
    expect(initial).toContain('transition_key TEXT NOT NULL UNIQUE');
    expect(indexes).toContain('idx_shops_source_status_seen');
    expect(indexes).toContain('idx_options_type_value');
  });

  it('declares the versioned item catalog and derived search structures', () => {
    const catalog = readFileSync(resolve(process.cwd(), 'migrations/0005_catalog_core.sql'), 'utf8');
    const search = readFileSync(resolve(process.cwd(), 'migrations/0006_search_indexes.sql'), 'utf8');

    for (const table of ['item_catalog', 'item_aliases', 'catalog_versions', 'catalog_state']) {
      expect(catalog).toContain('CREATE TABLE IF NOT EXISTS ' + table);
    }
    expect(catalog).toContain('FOREIGN KEY (item_id) REFERENCES item_catalog(item_id)');
    expect(catalog).toContain('UNIQUE(version)');
    expect(catalog).toContain('current_version');
    expect(catalog).toContain('idx_item_catalog_name_normalized');
    expect(catalog).toContain('idx_item_aliases_normalized');

    expect(search).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS item_search_fts USING fts5');
    expect(search).toContain("tokenize = 'trigram'");
    expect(search).toContain('CREATE TABLE IF NOT EXISTS search_short_tokens');
    expect(search).toContain('PRIMARY KEY(scope_type, scope_id, token)');
    expect(search).toContain('idx_search_short_tokens_lookup');
  });

  it('keeps catalog migrations incremental and ordered after existing migrations', () => {
    const migrations = readdirSync(resolve(process.cwd(), 'migrations'))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .map((name) => name.slice(0, 4))
      .sort();
    expect(migrations).toEqual(['0001', '0002', '0003', '0004', '0005', '0006']);
  });

  it('applies every migration to an empty SQLite database and enforces catalog constraints', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrations(db);

      const objects = db.prepare("SELECT name,type FROM sqlite_master WHERE name IN ('item_catalog','item_aliases','catalog_versions','catalog_state','item_search_fts','search_short_tokens') ORDER BY name").all() as Array<{ name: string; type: string }>;
      expect(objects).toEqual([
        { name: 'catalog_state', type: 'table' },
        { name: 'catalog_versions', type: 'table' },
        { name: 'item_aliases', type: 'table' },
        { name: 'item_catalog', type: 'table' },
        { name: 'item_search_fts', type: 'table' },
        { name: 'search_short_tokens', type: 'table' },
      ]);

      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_item_catalog_name_normalized','idx_item_aliases_normalized','idx_search_short_tokens_lookup') ORDER BY name").all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(['idx_item_aliases_normalized', 'idx_item_catalog_name_normalized', 'idx_search_short_tokens_lookup']);

      expect(() => db.exec("INSERT INTO item_aliases(item_id,alias,alias_normalized,alias_kind,data_version,updated_at) VALUES (999,'孤立','孤立','approved','v1',0)"))
        .toThrow(/foreign key/i);

      db.exec("INSERT INTO item_catalog(item_id,canonical_name_zh,name_normalized,description,data_version,updated_at) VALUES (1234,'测试剑','测试剑','','v1',0); INSERT INTO item_aliases(item_id,alias,alias_normalized,alias_kind,data_version,updated_at) VALUES (1234,'试剑','试剑','approved','v1',0); INSERT INTO catalog_versions(version,checksum,imported_at,item_count,alias_count,option_count,importer_version,output_checksum) VALUES ('v1','checksum',0,1,1,0,'test','output');");
      expect(() => db.exec("INSERT INTO item_catalog(item_id,canonical_name_zh,name_normalized,description,data_version,updated_at) VALUES (1234,'重复','重复','','v1',0)"))
        .toThrow(/unique/i);
      expect(() => db.exec("INSERT INTO item_aliases(item_id,alias,alias_normalized,alias_kind,data_version,updated_at) VALUES (1234,'重复别名','试剑','approved','v1',0)"))
        .toThrow(/unique/i);
      expect(() => db.exec("INSERT INTO catalog_versions(version,checksum,imported_at,item_count,alias_count,option_count,importer_version,output_checksum) VALUES ('v1','other',0,1,1,0,'test','other')"))
        .toThrow(/unique/i);

      db.exec("INSERT INTO market_sources(id,name,api_key_hash,created_at) VALUES ('source','Synthetic','hash',0); INSERT INTO vendors(source_id,vendor_key,name,updated_at) VALUES ('source','vendor','Synthetic vendor',0); INSERT INTO shops(source_id,vendor_id,shop_key,shop_type,last_seen_at,updated_at) VALUES ('source',1,'shop','sell',0,0); INSERT INTO shop_sessions(shop_id,client_run_id,started_at,last_seen_at) VALUES (1,'run',0,0); INSERT INTO listings(shop_session_id,item_fingerprint,item_id,item_name,item_name_normalized,price,quantity,last_quantity,first_seen_at,last_seen_at,last_changed_at) VALUES (1,'unknown-fingerprint',987654,'legacy','legacy',1,1,1,0,0,0);");
      expect(db.prepare("SELECT item_id FROM listings WHERE item_fingerprint='unknown-fingerprint'").get()).toEqual({ item_id: 987654 });
    } finally {
      db.close();
    }
  });
});

function applyMigrations(db: DatabaseSync): void {
  const names = readdirSync(resolve(process.cwd(), 'migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of names) db.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
}
