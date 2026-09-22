import { describe, expect, it } from 'vitest';
import { createMysqlRepository } from '../src/db/mysql-repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import type { ShopSessionContextInput } from '../src/db/repository';
import type { ListingOption } from '../src/db/types';

class RecordingMysqlDatabase implements MysqlDatabase {
  readonly sql: string[] = [];
  readonly values: Array<readonly unknown[]> = [];
  transactions = 0;

  constructor(
    private readonly writeResult: MysqlWriteResult = { affectedRows: 1, insertId: 1 },
    private readonly batchRow: MysqlRow | null = null,
    private readonly lockedListingIds: number[] = [],
  ) {}

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.sql.push(sql);
    this.values.push(values);
    if (sql.includes('FOR UPDATE')) return this.lockedListingIds.map((id) => ({ id }) as unknown as T);
    if (sql.includes('FROM upload_batches')) return this.batchRow ? [this.batchRow as T] : [];
    if (!sql.includes('FROM shops')) return [];
    return Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      source_id: 'source',
      identity_hash: `identity-${index}`,
      public_shop_id: `shop-${index}`,
      status: 'active',
      last_status_observed_at: 100,
      last_changed_at: 100,
      full_state_hash: null,
      closed_at: null,
    }) as unknown as T);
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    return (await this.all<T>(sql, values))[0] ?? null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.sql.push(sql);
    this.values.push(values);
    return this.writeResult;
  }

  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return work(this);
  }

  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

function observations(count: number): ShopSessionContextInput[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceId: 'source',
    identityHash: `identity-${index}`,
    shopId: `shop-${index}`,
    shopStatus: 'opening',
    batchId: 'snapshot/0',
    vendorAccountId: `vendor-${index}`,
    clientRunId: 'run',
    observedAt: 100,
    vendorName: `Vendor ${index}`,
    title: `Shop ${index}`,
    shopType: 'sell',
    mapName: 'prontera',
    x: 100,
    y: 100,
  }));
}

function listingInput(index: number, options: ListingOption[] = []): { sessionId: number; fingerprint: string; itemId: number; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string; options: ListingOption[] } {
  return { sessionId: index + 1, fingerprint: `f${index}`.padEnd(64, '0'), itemId: 100 + index, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 1_000, quantity: 1, observedAt: 100, batchId: 'snapshot/0', options };
}

describe('MySQL repository upload core', () => {
  it.each(['opening', 'dismissed', 'mixed'] as const)('only sends applicable shop writes for %s batches', async (mode) => {
    const db = new RecordingMysqlDatabase();
    const inputs = observations(2).map((input, index) => ({ ...input, shopStatus: mode === 'dismissed' || (mode === 'mixed' && index === 1) ? 'dismissed' as const : 'opening' as const }));
    const result = await createMysqlRepository(db).resolveShopObservations!(inputs);
    expect(result.map((entry) => entry.status)).toEqual(inputs.map((input) => input.shopStatus));
    expect(db.transactions).toBe(1);
    const writes = db.sql.filter((sql) => /^(INSERT|UPDATE)/.test(sql));
    expect(writes.filter((sql) => sql.includes("'dismissed'"))).toHaveLength(mode === 'opening' ? 0 : 3);
    expect(writes.filter((sql) => sql.includes("WHERE shop_status = 'opening'"))).toHaveLength(mode === 'dismissed' ? 0 : 1);
    expect(db.sql.filter((sql) => sql.startsWith('SELECT')).every((sql) => !sql.includes('shops.*'))).toBe(true);
  });

  it('resolves 1000 shops with bounded tuple reads and a single transaction', async () => {
    const db = new RecordingMysqlDatabase();
    const result = await createMysqlRepository(db).resolveShopObservations!(observations(1_000));

    expect(result).toHaveLength(1_000);
    expect(db.transactions).toBe(1);
    const shopReads = db.sql.filter((sql) => sql.includes('FROM shops'));
    expect(shopReads).toHaveLength(2);
    expect(shopReads.every((sql) => sql.includes('JSON_TABLE'))).toBe(true);
    expect(db.sql.join('\n')).not.toContain("'shop-0'");
    expect(db.values.some((values) => values.some((value) => typeof value === 'string' && value.includes('"shopId":"shop-0"')))).toBe(true);

    const openingUpsert = db.sql.find((sql) => sql.includes('ON DUPLICATE KEY UPDATE') && sql.includes('status = IF'));
    expect(openingUpsert).toBeDefined();
    expect(openingUpsert!.lastIndexOf('last_changed_at = IF')).toBeLessThan(openingUpsert!.lastIndexOf("status = IF"));
    expect(openingUpsert!.lastIndexOf("status = IF")).toBeLessThan(openingUpsert!.lastIndexOf('last_status_observed_at = IF'));
  });

  it('uses a parameterized MySQL idempotency insert and returns the existing batch', async () => {
    const db = new RecordingMysqlDatabase(
      { affectedRows: 0, insertId: 0 },
      {
        source_id: 'source',
        batch_id: 'snapshot/0',
        snapshot_id: 'snapshot',
        part_index: 0,
        part_count: 1,
        snapshot_mode: 'full',
        payload_hash: 'a'.repeat(64),
        status: 'accepted',
        response_json: null,
      },
    );

    const result = await createMysqlRepository(db).insertBatch({
      sourceId: 'source',
      batchId: 'snapshot/0',
      snapshotId: 'snapshot',
      partIndex: 0,
      partCount: 1,
      snapshotMode: 'full',
      payloadHash: 'a'.repeat(64),
      responseJson: null,
      receivedAt: 100,
    });

    expect(result.inserted).toBe(false);
    expect(db.sql[0]).toContain('ON DUPLICATE KEY UPDATE batch_id = VALUES(batch_id)');
    expect(db.sql[0]).not.toContain('INSERT OR IGNORE');
    expect(db.values[0]).toContain('snapshot/0');
  });

  it('uses one set read and one transaction for a 1000-listing upload bundle', async () => {
    const db = new RecordingMysqlDatabase();
    const repo = createMysqlRepository(db);
    const inputs = Array.from({ length: 1_000 }, (_, index) => listingInput(index, [{ type: 1, value: 2, param: 3 }]));

    await repo.loadListingsByObservations!(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint })));
    await repo.insertNewListingsBulk!(inputs);

    const listingReads = db.sql.filter((sql) => sql.includes('FROM listings'));
    expect(listingReads).toHaveLength(1);
    expect(listingReads[0]).toContain('JSON_TABLE');
    expect(db.transactions).toBe(1);
    const writes = db.sql.filter((sql) => sql.startsWith('INSERT'));
    expect(writes).toHaveLength(3);
    expect(writes.every((sql) => sql.includes('JSON_TABLE') && !sql.includes('INSERT OR'))).toBe(true);
  });

  it('emits sold-event counts only for optimistic-lock winners', async () => {
    const db = new RecordingMysqlDatabase({ affectedRows: 1, insertId: 0 }, null, [42]);
    const result = await createMysqlRepository(db).applyListingTransitions!([
      {
        listingId: 42,
        shopSessionId: 7,
        expectedVersion: 3,
        price: 100,
        quantity: 0,
        status: 'sold_out',
        observedAt: 100,
        batchId: 'snapshot/0',
        history: { eventType: 'quantity_changed' },
        soldEvent: { soldQuantity: 1, fromQuantity: 1, toQuantity: 0, reason: 'sold_out', transitionKey: 'a'.repeat(64) },
      },
      {
        listingId: 43,
        shopSessionId: 7,
        expectedVersion: 3,
        price: 100,
        quantity: 0,
        status: 'sold_out',
        observedAt: 100,
        batchId: 'snapshot/0',
        history: { eventType: 'quantity_changed' },
        soldEvent: { soldQuantity: 1, fromQuantity: 1, toQuantity: 0, reason: 'sold_out', transitionKey: 'b'.repeat(64) },
      },
    ]);

    expect(result).toMatchObject({ updated: 1, conflicts: 1, soldEvents: 1, conflictIds: [43] });
    expect(db.transactions).toBe(1);
    expect(db.sql.some((sql) => sql.includes('FOR UPDATE') && sql.includes('state_version = transition_input.expected_version'))).toBe(true);
    expect(db.sql.join('\n')).not.toContain('RETURNING');
  });

  it('updates snapshot lifecycle data with set-based MySQL statements', async () => {
    const db = new RecordingMysqlDatabase();
    const repo = createMysqlRepository(db);
    const identities = Array.from({ length: 1_000 }, (_, index) => `identity-${index}`);
    const sessionIds = Array.from({ length: 1_000 }, (_, index) => index + 1);

    await repo.markShopHeartbeats!('source', identities, 100);
    await repo.getUninitializedShopKeys!('source', identities);
    await repo.recordSnapshotSessions!('source', 'snapshot', sessionIds, 100);
    await repo.updateShopFullStateHashes!(sessionIds.map((shopId) => ({ shopId, fullStateHash: 'a'.repeat(64) })), 100);

    expect(db.sql.filter((sql) => sql.includes('JSON_TABLE'))).toHaveLength(3);
    expect(db.sql.join('\n')).not.toContain('json_each');
    expect(db.values.filter((values) => values.some((value) => typeof value === 'string' && value.includes('identity-0')))).toHaveLength(2);
  });

  it('reconciles a full snapshot in one transaction without per-listing SQL', async () => {
    const db = new RecordingMysqlDatabase();
    const result = await createMysqlRepository(db).reconcileSnapshot!({
      sourceId: 'source',
      snapshotId: 'snapshot',
      observedAt: 100,
      batchIds: ['snapshot/0'],
      sessionIds: Array.from({ length: 1_000 }, (_, index) => index + 1),
    });

    expect(result).toMatchObject({ sourceId: 'source', snapshotId: 'snapshot', complete: true, baseline: false });
    expect(db.transactions).toBe(1);
    expect(db.sql.some((sql) => sql.includes('missing_full_count = listings.missing_full_count + 1') && sql.includes('JSON_TABLE'))).toBe(true);
    expect(db.sql.join('\n')).not.toContain('json_each');
  });

  it('keeps option definitions static and uses MySQL-safe bounded retention deletes', async () => {
    const db = new RecordingMysqlDatabase();
    const repo = createMysqlRepository(db);

    const definitions = await repo.getOptionDefinitions();
    await repo.deleteExpiredHistory!(100, 50);
    await repo.deleteExpiredSoldEvents!(100, 50);

    expect(definitions.items.length).toBeGreaterThan(0);
    expect(db.sql).toHaveLength(2);
    expect(db.sql.every((sql) => sql.includes('DELETE FROM listing_events') && /FROM \(\s*SELECT id FROM listing_events/u.test(sql))).toBe(true);
    expect(db.sql.join('\n')).not.toContain('LIMIT ?1');
  });

  it('returns null history for an unknown listing without using SQLite cursor syntax', async () => {
    const db = new RecordingMysqlDatabase();
    const result = await createMysqlRepository(db).getListingHistory(999, 50);

    expect(result).toBeNull();
    expect(db.sql).toEqual(['SELECT id FROM listings WHERE id = ? LIMIT 1']);
  });

  it('builds parameterized MySQL search SQL without numbered D1 placeholders', async () => {
    const db = new RecordingMysqlDatabase();
    const result = await createMysqlRepository(db).searchListings({
      limit: 50,
      sort: 'price_asc',
      item_ids: [1, 2],
      q: '测试商店',
    });

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(db.sql[0]).toContain('l.item_id IN (?, ?)');
    expect(db.sql[0]).not.toMatch(/\?\d+/u);
    expect(db.values[0]).toEqual([1, 2, '%测试商店%', '%测试商店%', 51]);
  });

  it('keeps legacy listing writes batched and parameterized for service compatibility', async () => {
    const db = new RecordingMysqlDatabase();
    const repo = createMysqlRepository(db);

    await repo.insertListingOptionsBatch!([{ listingId: 1, options: [{ type: 1, value: 2, param: 3 }] }]);
    await repo.insertHistoriesBatch!([{ listingId: 1, observedAt: 100, price: 10, quantity: 1, eventType: 'first_seen', batchId: 'snapshot/0' }]);
    await repo.insertSoldEvent!({ listingId: 1, soldQuantity: 1, fromQuantity: 1, toQuantity: 0, reason: 'sold_out', observedAt: 100, transitionKey: 'a'.repeat(64), snapshotId: 'snapshot/0', price: 10 });

    expect(db.sql).toHaveLength(3);
    expect(db.sql.every((sql) => !sql.includes('INSERT OR') && !sql.includes('?1'))).toBe(true);
    expect(db.values.some((values) => values.some((value) => typeof value === 'string' && value.includes('snapshot/0')))).toBe(true);
  });
});
