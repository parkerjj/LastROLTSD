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
      : sql.includes('SELECT listing_id,option_type')
        ? { listing_id: 2, option_index: 0, option_type: 1, option_value: 2, option_param: 0 }
      : sql.includes('FROM listings') && sql.includes('JOIN shop_sessions')
        ? { id: 2, shop_session_id: 1, item_fingerprint: 'fp', item_key: null, item_id: 9, upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0, price: 20, quantity: 1, last_quantity: 1, status: 'active', state_version: 1, missing_streak: 0, last_seen_at: 200, item_name_display: 'Sword', shop_key: 'shop', title: 'Shop', vendor_name: 'Vendor', map_name: 'map', shop_type: 'sell' }
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
    const filters = { limit: 1, sort: 'price_asc' as const, option_type: 1 };
    const cursor = encodeCursor({ sort: filters.sort, sortValue: 20, id: 7, context: searchCursorContext(filters) });
    const page = await repo.searchListings({ ...filters, cursor });
    const search = db.statements.find((statement) => statement.sql.includes('FROM listings'));
    expect(search?.sql).toContain('l.price > ?');
    expect(search?.sql).toContain('l.price = ?');
    expect(search?.bound).toContain(20);
    expect(search?.bound).toContain(7);
    expect(page.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0 }]);
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
    const result = await repo.searchListings({ limit: 10, option_type: 2 } as never);
    expect(result.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0 }]);
    expect(db.statements.some((statement) => statement.sql.includes('listing_options'))).toBe(true);
  });

  it('reloads an existing batch after a concurrent unique insert conflict', async () => {
    const existing = { id: 4, source_id: 's1', batch_id: 'snap/0', snapshot_id: 'snap', part_index: 0, part_count: 1, snapshot_mode: 'full', payload_hash: 'hash', status: 'processing', response_json: null };
    const db = {
      prepare(sql: string) {
        return {
          bind: (..._values: unknown[]) => ({
            first: async <T>() => {
              if (sql.startsWith('INSERT INTO upload_batches')) throw new Error('UNIQUE constraint failed: upload_batches.source_id, upload_batches.batch_id');
              return existing as T;
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

  it('joins catalog names at read time and never searches legacy item name columns', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const page = await repo.searchListings({ limit: 10, sort: 'price_asc' });
    const search = db.statements.find((statement) => statement.sql.includes('FROM listings'))!;
    expect(search.sql).toContain('LEFT JOIN item_catalog');
    expect(search.sql).toContain('COALESCE(c.canonical_name_zh');
    expect(search.sql).not.toContain('l.item_name_normalized');
    expect(page.items[0]?.itemName).toBe('Sword');
  });

  it('drives catalog autocomplete from the token or FTS index before joining item_catalog', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);

    await repo.searchItems('红', 20);
    await repo.searchItems('红色药', 20);

    const catalogQueries = db.statements.filter((statement) => statement.sql.includes('canonical_name_zh'));
    expect(catalogQueries[0]?.sql).toContain('FROM search_short_tokens st JOIN item_catalog c ON c.item_id=st.scope_id');
    expect(catalogQueries[0]?.sql).toContain("st.scope_type='item' AND st.token=?1");
    expect(catalogQueries[0]?.sql).not.toContain('FROM item_catalog c WHERE EXISTS');
    expect(catalogQueries[1]?.sql).toContain('FROM item_search_fts f JOIN item_catalog c ON c.item_id=f.rowid');
    expect(catalogQueries[1]?.sql).toContain('f.text MATCH ?1');
    expect(catalogQueries[1]?.sql).not.toContain('FROM item_catalog c WHERE EXISTS');
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

  it('reflects catalog renames and uses the unknown-item fallback without another upload', async () => {
    let catalogName: string | null = 'Initial catalog name';
    const db = {
      prepare(sql: string) {
        const row = sql.includes('FROM listings') && sql.includes('JOIN shop_sessions')
          ? { id: 2, shop_session_id: 1, item_fingerprint: 'fp', item_key: null, item_id: 9876, upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0, price: 20, quantity: 1, last_quantity: 1, status: 'active', state_version: 1, missing_streak: 0, last_seen_at: 200, item_name_display: catalogName, shop_key: 'shop', title: 'Shop', vendor_name: 'Vendor', map_name: 'map', shop_type: 'sell' }
          : sql.includes('SELECT listing_id,option_type') ? { listing_id: 2, option_index: 0, option_type: 1, option_value: 2, option_param: 0 } : null;
        return new Prepared(sql, row);
      },
      batch: async (statements: Prepared[]) => statements.map(() => ({ meta: { changes: 1 } })),
    };
    const repo = createD1Repository(db as never);
    expect((await repo.searchListings({ limit: 10, sort: 'price_asc' })).items[0]?.itemName).toBe('Initial catalog name');
    catalogName = 'Renamed catalog item';
    expect((await repo.searchListings({ limit: 10, sort: 'price_asc' })).items[0]?.itemName).toBe('Renamed catalog item');
    catalogName = null;
    expect((await repo.searchListings({ limit: 10, sort: 'price_asc' })).items[0]?.itemName).toBe('未知物品 #9876');
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

  it('uses JSON1 arrays for reconciliation scope instead of one SQL bind per session', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await repo.reconcileSnapshot!({ sourceId: 's1', snapshotId: 'snap', observedAt: 2, batchIds: ['b'], sessionIds: Array.from({ length: 80 }, (_, index) => index + 1) });
    const reconciliationSql = db.statements.find((statement) => statement.sql.includes('initial_sync_complete'))!;
    expect(reconciliationSql.sql).toContain('json_each');
    expect(reconciliationSql.bound.length).toBeLessThanOrEqual(3);
    expect(reconciliationSql.sql).toContain('started_at <=');
    expect(reconciliationSql.sql).toContain('ended_at IS NULL');
    const expiredSql = db.statements.find((statement) => statement.sql.includes("status='expired'"))!;
    expect(expiredSql.sql).toContain('ended_at <=');
  });

  it('returns the affected-row result of the conditional retry claim', async () => {
    const statement = { bind: (..._values: unknown[]) => ({ run: async () => ({ meta: { changes: 1 } }) }) };
    const repo = createD1Repository({ prepare: () => statement } as never);
    expect(await repo.retryBatch!('s1', 'b')).toBe(true);
    const losing = createD1Repository({ prepare: () => ({ bind: (..._values: unknown[]) => ({ run: async () => ({ meta: { changes: 0 } }) }) }) } as never);
    expect(await losing.retryBatch!('s1', 'b')).toBe(false);
  });

  it('does not reconcile any participant while the snapshot is still a baseline', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind: (..._values: unknown[]) => ({
            first: async <T>() => sql.includes('initial_sync_complete=0') ? ({ count: 1 } as T) : null,
            run: async () => ({ meta: { changes: 1 } }),
          }),
        } as never;
      },
    };
    const repo = createD1Repository(db as never);
    const result = await repo.reconcileSnapshot!({ sourceId: 's1', snapshotId: 'snap', observedAt: 10, batchIds: ['snap/0'], sessionIds: [7] });
    expect(result.baseline).toBe(true);
    expect(statements.some((sql) => sql.startsWith('UPDATE listings SET missing_streak'))).toBe(false);
  });

  it('records one low-confidence sold event when a listing reaches its second full-snapshot miss', async () => {
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind: (..._values: unknown[]) => ({
            first: async <T>() => {
              if (sql.includes('initial_sync_complete=0')) return { count: 0 } as T;
              if (sql.includes('missing_streak=1')) return { count: 0 } as T;
              if (sql.includes('COUNT(DISTINCT s.id)')) return { count: 1 } as T;
              return null;
            },
            all: async <T>() => sql.includes('missing_streak=1') ? { results: [{ id: 9, quantity: 3, state_version: 4 }] as T[] } : { results: [] as T[] },
            run: async () => ({ meta: { changes: 1 } }),
          }),
        } as never;
      },
      batch: async (statements: unknown[]) => statements.map((_, index) => ({ meta: { changes: index === 1 ? 1 : 3 } })),
    };
    const result = await createD1Repository(db as never).reconcileSnapshot!({ sourceId: 's1', snapshotId: 'snap', observedAt: 10, batchIds: ['snap/0'], sessionIds: [7] });
    expect(result.inferredSold).toBe(1);
    expect(preparedSql.some((sql) => sql.includes('sold_events') && sql.includes('missing_streak=2'))).toBe(true);
  });

  it('provides JSON1 bulk listing operations with bounded batch statements', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await repo.insertNewListingsBulk!([{ sessionId: 1, fingerprint: 'fp', itemId: 1, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 1, observedAt: 1, batchId: 'b', options: [{ type: 2, value: 3, param: 0 }, { type: 1, value: 4, param: 0 }] }]);
    await repo.applyListingTransitionsBulk!([{ listingId: 1, shopSessionId: 1, expectedVersion: 0, price: 9, quantity: 0, status: 'sold_out', observedAt: 2, batchId: 'b2', history: { eventType: 'quantity_changed' }, soldEvent: { soldQuantity: 1, fromQuantity: 1, toQuantity: 0, reason: 'sold_out', transitionKey: 'k' } }]);
    await repo.markListingsObservedBulk!([{ sessionId: 1, fingerprint: 'fp' }], 'b2', 2);
    expect(db.statements.filter((statement) => statement.sql.includes('json_each')).length).toBeGreaterThanOrEqual(7);
    expect(db.statements.some((statement) => statement.sql.includes('listing_options'))).toBe(true);
  });

  it('drives JSON1 bulk updates from bounded input IDs instead of scanning business tables', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);

    await repo.markListingsObservedBulk!([{ sessionId: 1, fingerprint: 'fp' }], 'b2', 2);
    await repo.applyListingTransitionsBulk!([{ listingId: 1, shopSessionId: 1, expectedVersion: 0, price: 9, quantity: 0, status: 'sold_out', observedAt: 2, batchId: 'b2' }]);
    await repo.markShopHeartbeats!('s1', ['shop-1'], 2);

    const observed = db.statements.find((statement) => statement.sql.startsWith('UPDATE listings SET last_seen_at'))!;
    expect(observed.sql).toContain('WHERE id IN (SELECT l.id FROM json_each(?1) input JOIN listings l');
    const transition = db.statements.find((statement) => statement.sql.startsWith('UPDATE listings SET\n        price='))!;
    expect(transition.sql).toContain("WHERE id IN (SELECT CAST(json_extract(input.value,'$.listingId') AS INTEGER) FROM json_each(?1) input)");
    const heartbeat = db.statements.find((statement) => statement.sql.startsWith('UPDATE shops SET last_seen_at'))!;
    expect(heartbeat.sql).toContain('WHERE id IN (SELECT s.id FROM json_each(?1) input CROSS JOIN shops s');
  });

  it('returns bounded inferred sale details from the history repository', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind: (..._values: unknown[]) => ({
            first: async <T>() => sql.startsWith('SELECT id FROM listings') ? ({ id: 1 } as T) : null,
            all: async <T>() => sql.includes('listing_price_history')
              ? { results: [{ id: 1, listing_id: 1, observed_at: 10, price: 100, quantity: 0, event_type: 'quantity_changed', batch_id: 'b' }] as T[] }
              : { results: [{ observed_at: 10, sold_quantity: 2, from_quantity: 2, to_quantity: 0, reason: 'sold_out' }] as T[] },
          }),
        } as never;
      },
    };
    const page = await createD1Repository(db as never).getListingHistory(1, 50);
    expect(page?.inferredSales).toEqual([{ observedAt: 10, soldQuantity: 2, fromQuantity: 2, toQuantity: 0, reason: 'sold_out' }]);
    expect(statements.some((sql) => sql.includes('FROM sold_events') && sql.includes('LIMIT'))).toBe(true);
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

  it('records snapshot participants with one JSON1 insert', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await repo.recordSnapshotSessions!('s1', 'snap', Array.from({ length: 300 }, (_, index) => index + 1), 10);
    const writes = db.statements.filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO snapshot_sessions'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain('json_each');
    expect(writes[0]?.bound).toHaveLength(4);
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
