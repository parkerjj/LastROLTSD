import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { createApp, fetchUpload } from '../src/index';
import { computeShopIdentity } from '../src/domain/shop-identity';
import type { MysqlDatabase } from '../src/db/mysql-client';

afterEach(() => vi.restoreAllMocks());

const bindings = { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MYSQL_URL: 'mysql://test:secret@localhost/test' };
const payload = { protocol_version: 2, client_run_id: 'run', snapshot_id: 'full-1', snapshot_mode: 'full', part_index: 0, part_count: 2,
  observed_at: '2026-09-24T00:00:00Z', shops: [{ uuid: '00000000-0000-4000-8000-000000000001', shop_status: 'opening',
    vendor_account_id: '123', vendor_name: 'Vendor', title: 'Shop', shop_type: 'sell', map_name: 'prontera', x: 1, y: 2, items: [] }] };

function trackPools(fail = false) {
  const pools: { closed: boolean }[] = [];
  vi.spyOn(mysql, 'createPool').mockImplementation(() => {
    const pool = {
      closed: false,
      on: vi.fn(),
      async execute(sql: string) {
        if (pool.closed) throw new Error('connection belongs to a completed request');
        if (fail) throw new Error('database unavailable');
        return [sql.startsWith('DELETE') ? { affectedRows: 0, insertId: 0 } : [{ healthy: 1 }], []];
      },
      async end() { pool.closed = true; },
    };
    pools.push(pool);
    return pool as unknown as mysql.Pool;
  });
  return pools;
}

describe('Worker MySQL connection ownership', () => {
  it('uses the same generated request ID in upload error bodies and headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(new Request('https://example.test/api/v1/market/upload', {
      method: 'POST', headers: { 'idempotency-key': 'snapshot/0' }, body: '{}',
    }), bindings);
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { request_id: string } };
    expect(body.error.request_id).toBe(response.headers.get('x-request-id'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('isolates concurrent direct uploads by source and per-request limits', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const makeDatabase = (sourceId: string): MysqlDatabase => {
      const db = {
        async first(sql: string) {
          if (sql.includes('api_key_hash =')) return { id: sourceId, name: 'Synthetic', api_key_hash: '', status: 'active' };
          if (sql.includes('FROM market_sources')) return { id: sourceId };
          if (sql.startsWith('SELECT * FROM market_snapshots')) return { snapshot_id: 'full-1', client_run_id: 'run',
            observed_at: Date.parse(payload.observed_at), part_count: 2, accepted_parts: 0, status: 'receiving' };
          return null;
        },
        async run() { return { affectedRows: 1, insertId: 1 }; },
        async transaction(work: (tx: MysqlDatabase) => Promise<unknown>) { return work(db as unknown as MysqlDatabase); },
      };
      return db as unknown as MysqlDatabase;
    };
    const send = (sourceId: string, maxBytes: number) => fetchUpload(new Request('https://example.test/api/v1/market/upload', {
      method: 'POST', headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'full-1/0', 'cf-ray': sourceId },
      body: JSON.stringify({ ...payload, source_id: 'attacker' }),
    }), { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: maxBytes }, makeDatabase(sourceId));
    const responses = await Promise.all([send('source-a', 524288), send('source-b', 524288), send('limited', 16)]);
    expect(responses.map((response) => response.status)).toEqual([202, 202, 413]);
    for (const [index, sourceId] of ['source-a', 'source-b'].entries()) {
      const response = responses[index]!;
      const result = await response.json() as { shops: Array<{ shop_id: string }> };
      const identity = await computeShopIdentity({ sourceId, vendorAccountId: '123', shopType: 'sell', mapName: 'prontera', x: 1, y: 2, title: 'Shop' });
      expect(result.shops[0]?.shop_id).toBe(identity.shopId);
      expect(response.headers.get('x-request-id')).toBe(sourceId);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it.each([false, true])('closes direct upload pools after a receipt transaction (failure: %s)', async (fail) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pools: Array<{ closed: boolean; committed: boolean; rolledBack: boolean; released: boolean }> = [];
    vi.spyOn(mysql, 'createPool').mockImplementation(() => {
      const pool = {
        closed: false, committed: false, rolledBack: false, released: false, on: vi.fn(),
        async execute(sql: string) {
          if (pool.closed) throw new Error('connection belongs to a completed request');
          if (sql.includes('api_key_hash =')) return [[{ id: 'source', name: 'Synthetic', api_key_hash: '', status: 'active' }], []];
          if (fail) throw new Error('database unavailable');
          if (sql.includes('FROM market_sources')) return [[{ id: 'source' }], []];
          if (sql.startsWith('SELECT * FROM market_snapshots')) return [[{ snapshot_id: 'full-1', client_run_id: 'run',
            observed_at: Date.parse(payload.observed_at), part_count: 2, accepted_parts: 0, status: 'receiving' }], []];
          return [sql.trimStart().startsWith('SELECT') ? [] : { affectedRows: 1, insertId: 1 }, []];
        },
        async getConnection() { return pool; }, async beginTransaction() {},
        async commit() { pool.committed = true; }, async rollback() { pool.rolledBack = true; },
        release() { pool.released = true; }, async end() { pool.closed = true; },
      };
      pools.push(pool);
      return pool as unknown as mysql.Pool;
    });
    const response = await worker.fetch(new Request('https://example.test/api/v1/market/upload', {
      method: 'POST', headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'full-1/0' }, body: JSON.stringify(payload),
    }), bindings);
    expect(response.status).toBe(fail ? 500 : 202);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ closed: true, released: true, committed: !fail, rolledBack: fail });
    if (fail) await expect(response.json()).resolves.toMatchObject({ error: { code: 'internal_error', retryable: true } });
    else await expect(response.json()).resolves.toMatchObject({ reconciliation: { status: 'pending' } });
  });
  it('serves successive and concurrent requests using separate pools and closes them', async () => {
    const pools = trackPools();
    const request = () => worker.fetch(new Request('https://example.test/api/health'), bindings);
    const responses = [await request(), await request(), ...await Promise.all([request(), request()])];
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({ db: 'ok' });
    }
    expect(pools).toHaveLength(4);
    expect(pools.every((pool) => pool.closed)).toBe(true);
  });

  it('closes the pool even when a query fails', async () => {
    const pools = trackPools(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(new Request('https://example.test/api/health'), bindings);
    await expect(response.json()).resolves.toMatchObject({ db: 'error' });
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closed).toBe(true);
  });

  it.each([false, true])('closes scheduled job connections (query failure: %s)', async (fail) => {
    const pools = trackPools(fail);
    const job = worker.scheduled({} as ScheduledEvent, bindings);
    if (fail) await expect(job).rejects.toThrow('database operation failed');
    else await job;
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closed).toBe(true);
  });

  it('leaves an injected database under its caller ownership', async () => {
    const close = vi.fn();
    const database = { healthcheck: async () => undefined, close } as unknown as MysqlDatabase;
    const app = createApp({ ...bindings, MAX_BODY_BYTES: 1 }, database);
    await app.request('/api/health');
    expect(close).not.toHaveBeenCalled();
  });
});
