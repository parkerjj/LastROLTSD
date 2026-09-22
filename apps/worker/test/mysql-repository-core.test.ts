import { describe, expect, it } from 'vitest';
import { createMysqlRepository } from '../src/db/mysql-repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import type { ShopSessionContextInput } from '../src/db/repository';

class RecordingMysqlDatabase implements MysqlDatabase {
  readonly sql: string[] = [];
  readonly values: readonly unknown[][] = [];
  transactions = 0;

  constructor(
    private readonly writeResult: MysqlWriteResult = { affectedRows: 1, insertId: 1 },
    private readonly batchRow: MysqlRow | null = null,
  ) {}

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.sql.push(sql);
    this.values.push(values);
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
});
