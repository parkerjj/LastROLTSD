import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('D1 query indexes', () => {
  it('uses bounded partial indexes for active listing searches', () => {
    const db = openDatabase();
    try {
      expect(plan(db, "SELECT id FROM listings WHERE status='active' AND item_id=?1 ORDER BY price,id LIMIT ?2", 1234, 51))
        .toContain('idx_listings_active_item_price');
      expect(plan(db, "SELECT id FROM listings WHERE status='active' AND shop_id=?1 ORDER BY price,id LIMIT ?2", 1, 51))
        .toContain('idx_listings_active_shop_price');
      expect(plan(db, "SELECT id FROM listings WHERE status='active' ORDER BY price,id LIMIT ?1", 51))
        .toContain('idx_listings_active_price');
    } finally {
      db.close();
    }
  });

  it('scans only the active-shop covering index for substring candidates', () => {
    const db = openDatabase();
    try {
      const substringPlan = plan(db, `SELECT id,title_normalized,vendor_name_normalized,map_name,shop_type
        FROM shops
        WHERE status='active'
          AND (instr(title_normalized,?1)>0 OR instr(vendor_name_normalized,?1)>0)
        ORDER BY title_normalized,vendor_name_normalized,map_name,shop_type,id
        LIMIT 101`, '利卡');
      expect(substringPlan).toContain('idx_shops_active_directory');
      expect(substringPlan).not.toMatch(/(?:^|\n)SCAN shops(?:$|\n)/u);

      expect(plan(db, "SELECT id FROM shops WHERE status='active' AND map_name=?1 AND shop_type=?2 ORDER BY id LIMIT ?3", 'prontera', 'sell', 101))
        .toContain('idx_shops_active_filter');
    } finally {
      db.close();
    }
  });

  it('uses lookup and history indexes for hydrated result pages', () => {
    const db = openDatabase();
    try {
      expect(plan(db, 'SELECT listing_id FROM listing_options WHERE option_type=?1 AND option_value>=?2 AND option_param=?3 ORDER BY listing_id LIMIT ?4', 12, 60, 0, 51))
        .toContain('idx_listing_options_lookup');
      expect(plan(db, 'SELECT id FROM listing_events WHERE listing_id=?1 ORDER BY observed_at DESC,id DESC LIMIT ?2', 1, 51))
        .toContain('idx_listing_events_history');
      expect(plan(db, "SELECT id FROM listings WHERE shop_id=?1 AND status IN ('active','missing') ORDER BY id", 1))
        .toContain('idx_listings_shop_status');
    } finally {
      db.close();
    }
  });
});

function plan(db: ReturnType<typeof openDatabase>, sql: string, ...values: SQLInputValue[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail).join('\n');
}

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(resolve(process.cwd(), 'migrations')).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    db.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
  }
  return db;
}
