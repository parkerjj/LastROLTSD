import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { createApp } from '../src/index';
import type { MysqlDatabase } from '../src/db/mysql-client';

afterEach(() => vi.restoreAllMocks());

const bindings = { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MYSQL_URL: 'mysql://test:secret@localhost/test' };

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
