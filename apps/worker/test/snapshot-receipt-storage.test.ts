import { describe, expect, it, vi } from 'vitest';
import { createSnapshotRepository } from '../src/db/snapshot-repository';
import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../src/db/mysql-client';
import { receiveFullUpload } from '../src/services/full-upload';
import type { UploadRequest } from '@lastroweb/protocol';

const request: UploadRequest = {
  protocol_version: 2, client_run_id: 'run', snapshot_id: 'snapshot', snapshot_mode: 'full',
  part_index: 0, part_count: 2, observed_at: '2026-09-24T00:00:00Z',
  shops: [{ uuid: '00000000-0000-4000-8000-000000000001', shop_status: 'opening',
    vendor_account_id: '123', vendor_name: 'Vendor', title: 'Shop', shop_type: 'sell',
    map_name: 'prontera', x: 1, y: 2, items: [] }],
};

function recordingDatabase(stagingError?: Error) {
  const writes: Array<{ sql: string; values: readonly unknown[] }> = [];
  const first = async <T extends MysqlRow>(sql: string): Promise<T | null> => {
    if (sql.includes('FROM market_sources')) return { id: 'source' } as unknown as T;
    if (sql.includes('FROM market_snapshots')) return { snapshot_id: request.snapshot_id,
      client_run_id: request.client_run_id, observed_at: Date.parse(request.observed_at),
      part_count: request.part_count, status: 'receiving', accepted_parts: 0 } as unknown as T;
    return null;
  };
  const transaction = vi.fn();
  const db: MysqlDatabase = {
    all: async () => [], first,
    run: async (sql, values = []) => {
      writes.push({ sql, values });
      if (sql.startsWith('INSERT INTO market_snapshot_shops') && stagingError) throw stagingError;
      return { affectedRows: 1, insertId: 0 };
    },
    transaction: async (work) => { transaction(); return work(db); },
    healthcheck: async () => undefined, close: async () => undefined,
  };
  return { db, writes, transaction };
}

describe('snapshot receipt storage', () => {
  it('sends the large payload once and stages from the stored receipt within one transaction', async () => {
    const { db, writes, transaction } = recordingDatabase();
    const dispatch = vi.fn();
    const result = await receiveFullUpload({ id: 'source' }, request, 'snapshot/0', createSnapshotRepository(db), dispatch);
    const payload = JSON.stringify(request);
    expect(writes.flatMap((write) => write.values).filter((value) => value === payload)).toHaveLength(1);
    const receiptIndex = writes.findIndex((write) => write.sql.startsWith('INSERT INTO upload_batches'));
    const stagingIndex = writes.findIndex((write) => write.sql.startsWith('INSERT INTO market_snapshot_shops'));
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(stagingIndex).toBeGreaterThan(receiptIndex);
    expect(writes[stagingIndex]!.sql).toContain('FROM upload_batches AS payload');
    expect(writes[stagingIndex]!.sql).not.toContain('CAST(? AS JSON)');
    expect(writes[stagingIndex]!.values.slice(-2)).toEqual(['source', 'snapshot/0']);
    expect(transaction).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('propagates a staging failure out of the transaction without advancing or dispatching', async () => {
    const failure = new MysqlDatabaseError(new Error('Network connection lost.'));
    const { db, writes } = recordingDatabase(failure);
    const dispatch = vi.fn();
    await expect(receiveFullUpload({ id: 'source' }, request, 'snapshot/0', createSnapshotRepository(db), dispatch)).rejects.toBe(failure);
    expect(writes.some((write) => write.sql.startsWith('UPDATE market_snapshots'))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('retains the duplicate shop rejection when staging fails', async () => {
    const failure = new MysqlDatabaseError({ code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' });
    const { db } = recordingDatabase(failure);
    await expect(receiveFullUpload({ id: 'source' }, request, 'snapshot/0', createSnapshotRepository(db)))
      .rejects.toMatchObject({ code: 'duplicate_shop_identity', status: 422 });
  });
});
