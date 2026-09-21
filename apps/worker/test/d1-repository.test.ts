import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { encodeCursor, searchCursorContext } from '../src/domain/search';

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
      : sql.includes('SELECT lo.listing_id,lo.option_type')
        ? { listing_id: 2, option_index: 0, option_type: 1, option_value: 2, option_param: 0 }
      : sql.includes('FROM listings') && sql.includes('JOIN shops')
        ? { id: 2, shop_id: 1, item_fingerprint: 'fp', item_key: null, item_id: 9, upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0, price: 20, quantity: 1, status: 'active', state_version: 1, missing_full_count: 0, last_changed_at: 200, shop_key: 'shop', title: 'Shop', vendor_name: 'Vendor', map_name: 'map', shop_type: 'sell', shop_status: 'active' }
      : sql.includes('ORDER BY CAST(input.key AS INTEGER)')
        ? { id: 3, shop_id: 1, client_run_id: 'run', started_at: 1, last_seen_at: 2, ended_at: null, initial_sync_complete: 0, last_complete_snapshot_id: null, input_source_id: 's1', input_shop_key: 'second' }
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
    const filters = { limit: 1, sort: 'price_asc' as const, option_type: 1, option_value: 2, option_param: 0 };
    const cursor = encodeCursor({ sort: filters.sort, sortValue: 20, id: 7, context: searchCursorContext(filters) });
    const page = await repo.searchListings({ ...filters, cursor });
    const search = db.statements.find((statement) => statement.sql.includes('FROM listings'));
    expect(search?.sql).toContain('l.price > ?');
    expect(search?.sql).toContain('l.price = ?');
    expect(search?.bound).toContain(20);
    expect(search?.bound).toContain(7);
    expect(page.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0, display: 'MHP+2' }]);
    const hydration = db.statements.find((statement) => statement.sql.includes('JOIN json_each(?1) input'))!;
    expect(hydration.bound).toEqual(['[2]']);
  });

  it('rejects a cursor created for a different sort', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const cursor = encodeCursor({ sort: 'price_asc', sortValue: 20, id: 7 });
    await expect(repo.searchListings({ limit: 1, sort: 'price_desc', cursor } as never)).rejects.toThrow(/cursor/i);
  });

  it('maps structured option tuples in search rows', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const result = await repo.searchListings({ limit: 10, option_type: 2, option_value: 3, option_param: 0 } as never);
    expect(result.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0, display: 'MHP+2' }]);
    expect(db.statements.some((statement) => statement.sql.includes('listing_options'))).toBe(true);
  });

  it('reloads an existing batch after a concurrent unique insert conflict', async () => {
    const existing = { id: 4, source_id: 's1', batch_id: 'snap/0', snapshot_id: 'snap', part_index: 0, part_count: 1, snapshot_mode: 'full', payload_hash: 'hash', status: 'processing', response_json: null };
    const db = {
      prepare(sql: string) {
        return {
          bind: (..._values: unknown[]) => ({
            all: async <T>() => {
              if (sql.startsWith('INSERT INTO upload_batches')) throw new Error('UNIQUE constraint failed: upload_batches.source_id, upload_batches.batch_id');
              return { results: [existing as T], meta: { rows_read: 1, rows_written: 0, changes: 0, duration: 0 } };
            },
            run: async () => ({ meta: { changes: 0 } }),
          }),
        } as never;
      },
      batch: async () => [],
    };
    const batch = await createD1Repository(db as never).insertBatch({ sourceId: 's1', batchId: 'snap/0', snapshotId: 'snap', partIndex: 0, partCount: 1, snapshotMode: 'full', payloadHash: 'hash', responseJson: null, receivedAt: 1 });
    expect(batch.id).toBe(4);
    expect((batch as any).inserted).toBe(false);
  });

  it('keeps catalog names out of Worker/D1 result rows', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const page = await repo.searchListings({ limit: 10, sort: 'price_asc' });
    const search = db.statements.find((statement) => statement.sql.includes('FROM listings'))!;
    expect(search.sql).not.toMatch(/item_catalog|item_name|fts|search_short_tokens/i);
    expect(page.items[0]?.itemName).toBeUndefined();
    expect(page.items[0]?.itemId).toBe(9);
  });

  it('does not provide D1-backed catalog autocomplete', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);

    expect(await repo.searchItems('红', 20)).toEqual([]);
    expect(await repo.searchItems('红色药', 20)).toEqual([]);
    expect(db.statements.some((statement) => /item_catalog|fts|search_short_tokens/i.test(statement.sql))).toBe(false);
  });

  it('bounds retention preview counts instead of scanning all expired rows', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);

    await repo.countExpiredHistory!(123, 1001);
    await repo.countExpiredSoldEvents!(123, 1001);

    const previews = db.statements.filter((statement) => statement.sql.includes('SELECT COUNT(*) AS count FROM (SELECT id FROM'));
    expect(previews).toHaveLength(2);
    expect(previews[0]?.sql).toContain('WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2');
    expect(previews[0]?.bound).toEqual([123, 1001]);
    expect(previews[1]?.sql).toContain('WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2');
    expect(previews[1]?.bound).toEqual([123, 1001]);

    await repo.deleteExpiredHistory!(123, 500);
    await repo.deleteExpiredSoldEvents!(123, 500);
    const deletes = db.statements.filter((statement) => statement.sql.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.sql).toContain('WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2');
    expect(deletes[1]?.sql).toContain('WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2');
  });

  it('returns stable numeric item identity across catalog changes', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const result = await repo.searchListings({ limit: 10, sort: 'price_asc' });
    expect(result.items[0]).toMatchObject({ itemId: 9 });
    expect(result.items[0]?.itemName).toBeUndefined();
    expect(await repo.getCatalogVersion()).toBe('static');
  });

  it('does not persist client item names or option display text', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const input = { sessionId: 1, fingerprint: 'fp', itemKey: 'slot-0', itemId: 1, name: 'Legacy client name', upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 1, observedAt: 1, batchId: 'b', options: [{ type: 2, value: 3, param: 0 }] } as any;
    await repo.insertNewListingsBulk!([input]);
    const writes = db.statements.filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO listings'));
    expect(writes[0]?.sql).not.toContain('item_name');
    expect(writes[0]?.sql).not.toContain('display_value');
    expect(JSON.parse(String(writes[0]?.bound[0]))[0]).not.toHaveProperty('itemName');
    expect(JSON.parse(String(writes[0]?.bound[0]))[0]).not.toHaveProperty('name');
    expect(JSON.parse(String(writes[0]?.bound[0]))[0].options[0]).toEqual({ type: 2, value: 3, param: 0 });
  });

  it('returns the affected-row result of the conditional retry claim', async () => {
    const statement = { bind: (..._values: unknown[]) => ({ run: async () => ({ meta: { changes: 1 } }) }) };
    const repo = createD1Repository({ prepare: () => statement } as never);
    expect(await repo.retryBatch!('s1', 'b')).toBe(true);
    const losing = createD1Repository({ prepare: () => ({ bind: (..._values: unknown[]) => ({ run: async () => ({ meta: { changes: 0 } }) }) }) } as never);
    expect(await losing.retryBatch!('s1', 'b')).toBe(false);
  });

  it('returns bounded inferred sale details from the history repository', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind: (..._values: unknown[]) => ({
            first: async <T>() => sql.startsWith('SELECT id FROM listings') ? ({ id: 1 } as T) : null,
            all: async <T>() => sql.includes('sold_quantity>0')
              ? { results: [{ observed_at: 10, sold_quantity: 2, from_quantity: 2, to_quantity: 0, reason: 'sold_out' }] as T[] }
              : { results: [{ id: 1, listing_id: 1, snapshot_id: 'b', observed_at: 10, to_price: 100, to_quantity: 0, event_type: 'state_changed', reason: 'quantity_decrease' }] as T[] },
          }),
        } as never;
      },
    };
    const page = await createD1Repository(db as never).getListingHistory(1, 50);
    expect(page?.inferredSales).toEqual([{ observedAt: 10, soldQuantity: 2, fromQuantity: 2, toQuantity: 0, reason: 'sold_out' }]);
    expect(statements.some((sql) => sql.includes('FROM listing_events') && sql.includes('LIMIT'))).toBe(true);
  });

  it('uses one JSON1 heartbeat statement per bounded chunk', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await repo.markShopHeartbeats!('s1', Array.from({ length: 40 }, (_, index) => 'shop-' + index), 10);
    const heartbeat = db.statements.find((statement) => statement.sql.includes('UPDATE shops'))!;
    expect(heartbeat.sql).toContain('json_each');
    expect(heartbeat.bound).toHaveLength(3);
    expect(db.statements.filter((statement) => statement.sql.includes('UPDATE shops'))).toHaveLength(1);
  });

  it('chunks single-listing options before applying the D1 bound-parameter limit', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const options = Array.from({ length: 21 }, (_, index) => ({ type: 1, value: index, param: 0 }));

    await repo.insertListingOptions!({ listingId: 1, options });

    const optionWrites = db.statements.filter((statement) => statement.sql.includes('INSERT OR REPLACE INTO listing_options'));
    expect(optionWrites).toHaveLength(21);
    expect(optionWrites.slice(0, 12).reduce((sum, statement) => sum + statement.bound.length, 0)).toBe(60);
    expect(optionWrites.slice(12).reduce((sum, statement) => sum + statement.bound.length, 0)).toBe(45);
  });
});
