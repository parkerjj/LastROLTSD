import { describe, expect, it } from 'vitest';
import { createMysqlRepository } from '../src/db/mysql-repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import type { ShopSessionContextInput } from '../src/db/repository';
import type { ListingOption } from '../src/db/types';

class RecordingMysqlDatabase implements MysqlDatabase {
  readonly sql: string[] = [];
  readonly values: readonly unknown[][] = [];
  transactions = 0;

  constructor(
    private readonly writeResult: MysqlWriteResult = { affectedRows: 1, insertId: 1 },
    private readonly batchRow: MysqlRow | null = null,
    private readonly lockedListingIds: number[] = [],
  ) {}

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.sql.push(sql);
    this.values.push(values);
    if (sql.includes('FOR UPDATE')) return this.lockedListingIds.map((id) => ({ id }) as T);
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
    }) as T);
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
});
