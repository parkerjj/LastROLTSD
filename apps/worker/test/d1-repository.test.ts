import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { encodeCursor } from '../src/domain/search';

class Prepared {
  public bound: unknown[] = [];
  constructor(public readonly sql: string, private readonly row: Record<string, unknown> | null = null) {}
  bind(...values: unknown[]) { this.bound = values; return this; }
  async first<T>() { return this.row as T | null; }
  async all<T>() { return { results: this.row ? [this.row as T] : [] }; }
  async run() { return { meta: { changes: 1 } }; }
}

class FakeDb {
  statements: Prepared[] = [];
  prepare(sql: string) {
    const row = sql.includes('market_sources')
      ? { id: 's1', name: 'Source', api_key_hash: 'hash', status: 'active' }
      : sql.includes('SELECT listing_id,option_type')
        ? { listing_id: 2, option_index: 0, option_type: 1, option_value: 2, option_param: 0, display_value: 'Attack' }
      : sql.includes('FROM listings') && sql.includes('JOIN shop_sessions')
        ? { id: 2, shop_session_id: 1, item_fingerprint: 'fp', item_key: null, item_id: 9, item_name: 'Sword', item_name_normalized: 'sword', upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0, price: 20, quantity: 1, last_quantity: 1, status: 'active', state_version: 1, missing_streak: 0, last_seen_at: 200, shop_key: 'shop', title: 'Shop', vendor_name: 'Vendor', map_name: 'map', shop_type: 'sell' }
        : null;
    const statement = new Prepared(sql, row);
    this.statements.push(statement);
    return statement as never;
  }
  async batch(statements: Prepared[]) { return statements.map(() => ({ meta: { changes: 1 } })); }
}

describe('D1 repository', () => {
  it('binds source hash and maps source rows', async () => {
    const db = new FakeDb();
    const source = await createD1Repository(db as never).findSourceByApiKeyHash('secret-hash');
    expect(source?.id).toBe('s1');
    expect(db.statements[0]?.sql).not.toContain('secret-hash');
    expect(db.statements[0]?.bound).toEqual(['secret-hash']);
  });

  it('rejects oversized generated batches', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await expect(repo.applyListingChanges(Array.from({ length: 46 }, (_, id) => ({ listingId: id, expectedVersion: 0, price: 1, quantity: 1, status: 'active', observedAt: 1, batchId: 'b' })))).rejects.toThrow(/batch statement/);
  });

  it('applies a decoded keyset cursor to SQL and returns structured options', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const cursor = encodeCursor({ sortValue: 20, id: 7 });
    const page = await repo.searchListings({ limit: 1, sort: 'price_asc', cursor, option_type: 1 } as never);
    const search = db.statements.find((statement) => statement.sql.includes('FROM listings'));
    expect(search?.sql).toContain('l.price > ?');
    expect(search?.sql).toContain('l.price = ?');
    expect(search?.bound).toContain(20);
    expect(search?.bound).toContain(7);
    expect(page.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0, displayValue: 'Attack' }]);
  });

  it('maps structured option tuples in search rows', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const result = await repo.searchListings({ limit: 10, option_type: 2 } as never);
    expect(result.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0, displayValue: 'Attack' }]);
    expect(db.statements.some((statement) => statement.sql.includes('listing_options'))).toBe(true);
  });
});
