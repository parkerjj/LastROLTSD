import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_TABLES = [
  'listing_events',
  'listing_options',
  'listings',
  'market_sources',
  'shops',
  'upload_batches',
];

const REMOVED_OBJECTS = [
  'vendors',
  'shop_sessions',
  'snapshot_sessions',
  'item_catalog',
  'item_aliases',
  'catalog_versions',
  'catalog_state',
  'search_short_tokens',
  'item_search_fts',
  'shop_search_fts',
  'option_dictionary',
  'option_definitions',
  'option_state',
  'listing_price_history',
  'sold_events',
];

describe('D1 migrations', () => {
  it('uses one clean-break migration with exactly six dynamic-market tables', () => {
    expect(migrationNames()).toEqual(['0001_initial.sql']);
    const db = openDatabase();
    try {
      const objects = db.prepare(`SELECT name,type FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as Array<{ name: string; type: string }>;
      const tables = objects.filter((row) => row.type === 'table').map((row) => row.name).sort();
      expect(tables).toEqual(EXPECTED_TABLES);
      for (const removed of REMOVED_OBJECTS) expect(objects.some((row) => row.name === removed)).toBe(false);
      expect(objects.some((row) => row.type === 'table' && row.name.endsWith('_fts'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('enforces the new ownership graph and source-scoped identities', () => {
    const db = openDatabase();
    try {
      expect(foreignKeys(db, 'shops')).toEqual(['market_sources']);
      expect(foreignKeys(db, 'listings')).toEqual(['shops']);
      expect(foreignKeys(db, 'listing_options')).toEqual(['listings']);
      expect(foreignKeys(db, 'listing_events')).toEqual(['listings']);
      expect(foreignKeys(db, 'upload_batches')).toEqual(['market_sources']);

      db.exec(`
        INSERT INTO market_sources(id,name,api_key_hash,created_at,updated_at)
        VALUES ('source','Synthetic','hash',0,0);
        INSERT INTO shops(source_id,identity_hash,public_shop_id,vendor_account_id,shop_type,profile_hash,last_status_observed_at,last_changed_at)
        VALUES ('source','identity','public-shop','vendor','sell','profile',0,0);
        INSERT INTO listings(shop_id,item_fingerprint,item_id,price,quantity,first_seen_at,last_changed_at,last_changed_snapshot_id)
        VALUES (1,'item-fingerprint',987654,1,1,0,0,'snapshot');
      `);
      expect(db.prepare("SELECT item_id FROM listings WHERE item_fingerprint='item-fingerprint'").get()).toEqual({ item_id: 987654 });
      expect(() => db.exec("INSERT INTO shops(source_id,identity_hash,public_shop_id,vendor_account_id,shop_type,profile_hash,last_status_observed_at,last_changed_at) VALUES ('source','identity','other','vendor','sell','profile',0,0)"))
        .toThrow(/unique/i);
      expect(() => db.exec("INSERT INTO listings(shop_id,item_fingerprint,item_id,price,quantity,first_seen_at,last_changed_at,last_changed_snapshot_id) VALUES (999,'orphan',1,1,1,0,0,'snapshot')"))
        .toThrow(/foreign key/i);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('uses WITHOUT ROWID for text/composite primary-key tables and bounded lifecycle fields', () => {
    const db = openDatabase();
    try {
      const sqlByTable = new Map((db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all() as Array<{ name: string; sql: string }>).map((row) => [row.name, row.sql]));
      expect(sqlByTable.get('market_sources')).toMatch(/WITHOUT ROWID/iu);
      expect(sqlByTable.get('listing_options')).toMatch(/WITHOUT ROWID/iu);
      expect(sqlByTable.get('upload_batches')).toMatch(/WITHOUT ROWID/iu);

      expect(columns(db, 'shops')).toEqual(expect.arrayContaining(['profile_hash', 'full_state_hash', 'missing_full_count', 'last_missing_snapshot_id']));
      expect(columns(db, 'listings')).toEqual(expect.arrayContaining(['shop_id', 'missing_full_count', 'last_changed_snapshot_id']));
      expect(columns(db, 'listings')).not.toEqual(expect.arrayContaining(['shop_session_id', 'last_seen_at', 'last_batch_id']));
      expect(columns(db, 'upload_batches')).toContain('shop_ids_json');
    } finally {
      db.close();
    }
  });
});

export function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const name of migrationNames()) db.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
  return db;
}

function migrationNames(): string[] {
  return readdirSync(resolve(process.cwd(), 'migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
}

function foreignKeys(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).map((row) => row.table);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}
