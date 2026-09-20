import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('D1 query indexes', () => {
  it('keeps reconciliation scoped to the bounded session input', () => {
    const repository = readFileSync(resolve(process.cwd(), 'apps/worker/src/db/d1-repository.ts'), 'utf8');
    expect(repository).toContain("AND started_at <= ?1 AND last_seen_at=?1 AND initial_sync_complete=1)");
    expect(repository).not.toContain("shop_session_id IN (SELECT id FROM shop_sessions WHERE initial_sync_complete=1)");
  });

  it('repairs listing-dependent foreign keys after the protocol-v2 table rebuild', () => {
    const db = openDatabase();
    try {
      expect(foreignKeys(db, 'listing_price_history')).toEqual(['listings']);
      expect(foreignKeys(db, 'sold_events')).toEqual(['listings']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => db.prepare('DELETE FROM listing_price_history WHERE id IN (SELECT id FROM listing_price_history WHERE observed_at<?1 ORDER BY observed_at,id LIMIT ?2)').run(1, 500)).not.toThrow();
      expect(() => db.prepare('DELETE FROM sold_events WHERE id IN (SELECT id FROM sold_events WHERE observed_at<?1 ORDER BY observed_at,id LIMIT ?2)').run(1, 500)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rekeys existing item FTS rows by item ID', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrations(db, '0007');
      db.exec("INSERT INTO item_search_fts(item_id,text) VALUES ('1234','测试剑')");
      db.exec(readFileSync(resolve(process.cwd(), 'migrations/0008_query_indexes.sql'), 'utf8'));
      expect(db.prepare('SELECT rowid,item_id FROM item_search_fts').all()).toEqual([{ rowid: 1234, item_id: '1234' }]);
    } finally {
      db.close();
    }
  });

  it('uses selective indexes without scanning runtime business tables', () => {
    const db = openDatabase();
    try {
      expect(plan(db, "SELECT id FROM listings WHERE status='active' ORDER BY price,id LIMIT ?1", 51)).toContain('idx_listings_status_price_id');
      expect(plan(db, "SELECT id FROM listings WHERE status='active' AND item_id=?1 ORDER BY price,id LIMIT ?2", 1234, 51)).toContain('idx_listings_search_item');
      expect(plan(db, "SELECT id FROM listings WHERE status='active' ORDER BY last_seen_at DESC,id DESC LIMIT ?1", 51)).toContain('idx_listings_status_seen_id');
      expect(plan(db, 'SELECT id FROM shop_sessions WHERE shop_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1', 1)).toContain('idx_sessions_open_shop');
      expect(plan(db, 'SELECT id FROM listing_price_history WHERE listing_id=?1 ORDER BY id DESC LIMIT ?2', 1, 51)).toContain('idx_history_listing_id');
      expect(plan(db, 'SELECT id FROM sold_events WHERE listing_id=?1 ORDER BY id DESC LIMIT ?2', 1, 51)).toContain('idx_sold_listing_id');
      expect(plan(db, 'SELECT COUNT(*) FROM (SELECT id FROM listing_price_history WHERE observed_at<?1 ORDER BY observed_at,id LIMIT ?2)', 1, 1001)).toContain('idx_history_observed_id');
      expect(plan(db, 'SELECT COUNT(*) FROM (SELECT id FROM sold_events WHERE observed_at<?1 ORDER BY observed_at,id LIMIT ?2)', 1, 1001)).toContain('idx_sold_observed_id');

      const sessions = JSON.stringify([{ id: 1, observedAt: 1 }]);
      const batches = JSON.stringify(['batch-1']);
      const reconciliation = plan(db, `SELECT id FROM listings WHERE shop_session_id IN (
        SELECT id FROM shop_sessions WHERE id IN (
          SELECT CAST(json_extract(value,'$.id') AS INTEGER) FROM json_each(?2) WHERE json_extract(value,'$.observedAt')=?1
        ) AND started_at<=?1 AND last_seen_at=?1 AND initial_sync_complete=1
      ) AND status IN ('active','missing') AND (last_batch_id IS NULL OR last_batch_id NOT IN (SELECT value FROM json_each(?3)))`, 1, sessions, batches);
      expect(reconciliation).toContain('idx_listings_session_status');
      expect(reconciliation).not.toMatch(/SCAN (?:listings|shop_sessions|shops)\b/u);
    } finally {
      db.close();
    }
  });
});

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, '0008');
  return db;
}

function applyMigrations(db: DatabaseSync, through: string): void {
  for (const name of readdirSync(resolve(process.cwd(), 'migrations')).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    if (name.slice(0, 4) > through) break;
    db.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
  }
}

function foreignKeys(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).map((row) => row.table);
}

function plan(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail).join('\n');
}
