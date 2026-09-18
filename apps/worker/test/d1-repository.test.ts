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
        ? { listing_id: 2, option_index: 0, option_type: 1, option_value: 2, option_param: 0, display_value: 'Attack' }
      : sql.includes('FROM listings') && sql.includes('JOIN shop_sessions')
        ? { id: 2, shop_session_id: 1, item_fingerprint: 'fp', item_key: null, item_id: 9, item_name: 'Sword', item_name_normalized: 'sword', upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0, price: 20, quantity: 1, last_quantity: 1, status: 'active', state_version: 1, missing_streak: 0, last_seen_at: 200, shop_key: 'shop', title: 'Shop', vendor_name: 'Vendor', map_name: 'map', shop_type: 'sell' }
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
    expect(page.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0, displayValue: 'Attack' }]);
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
    expect(result.items[0]?.options).toEqual([{ type: 1, value: 2, param: 0, displayValue: 'Attack' }]);
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

  it('uses one JSON1 lookup result per distinct requested shop in request order', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    const inputs = [
      { sourceId: 's1', shopKey: 'second', clientRunId: 'run', observedAt: 2, vendorKey: 'v', vendorName: 'V', title: 'Second', shopType: 'sell' as const, mapName: 'm', x: 1, y: 1 },
      { sourceId: 's1', shopKey: 'second', clientRunId: 'run', observedAt: 2, vendorKey: 'v', vendorName: 'V', title: 'Second', shopType: 'sell' as const, mapName: 'm', x: 1, y: 1 },
    ];
    await repo.getOrCreateSessions!(inputs);
    const lookup = [...db.statements].reverse().find((statement: Prepared) => statement.sql.includes('ORDER BY CAST(input.key AS INTEGER)'));
    const sql = lookup?.sql ?? '';
    expect(sql).toContain('ORDER BY CAST(input.key AS INTEGER)');
    const payload = JSON.parse(String(lookup!.bound[0]));
    expect(payload.map((input: { shopKey: string }) => input.shopKey)).toEqual(['second']);
  });

  it('includes JS NFKC-normalized vendor and title fields in the bulk JSON payload', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await repo.getOrCreateSessions!([{ sourceId: 's1', shopKey: 'second', clientRunId: 'run', observedAt: 2, vendorKey: 'v', vendorName: '\uFF26endor', title: '\uFF33hop', shopType: 'sell', mapName: 'm', x: 1, y: 1 }]);
    const vendorSql = db.statements.find((statement) => statement.sql.includes('INSERT INTO vendors'))!;
    expect(vendorSql.sql).toContain("$.vendorNameNormalized");
    expect(JSON.parse(String(vendorSql.bound[0]))[0].vendorNameNormalized).toBe('fendor');
    const shopSql = db.statements.find((statement) => statement.sql.includes('INSERT INTO shops'))!;
    expect(shopSql.sql).toContain("$.titleNormalized");
    expect(JSON.parse(String(shopSql.bound[0]))[0].titleNormalized).toBe('shop');
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
});
