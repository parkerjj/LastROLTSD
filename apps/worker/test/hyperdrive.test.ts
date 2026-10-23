import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resolveAppEnv } from '../src/env';
import { parseMysqlUrl } from '../src/db/mysql-client';
import { createWorkerDatabase } from '../src/db/mysql-connection';
import { Buffer } from 'node:buffer';

const origin = 'mysql://origin:origin-secret@origin.example/app?ssl=true';
const hyperdrive = {
  host: 'hyperdrive.internal', port: 3306, user: 'hyperdrive-user', password: 'temporary:@/% secret', database: 'app',
};

afterEach(() => vi.restoreAllMocks());

function pools(fail = false) {
  const end = vi.fn(async () => undefined);
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (fail) throw new Error('temporary:@/% secret');
    return [sql.trimStart().startsWith('SELECT')
      ? sql.includes('SELECT 1') ? [{ healthy: 1 }] : []
      : { affectedRows: 0, insertId: 0 }, []];
  });
  const execute = vi.fn(query);
  const connection = {
    execute, query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
  };
  const createPool = vi.spyOn(mysql, 'createPool').mockImplementation(() => ({
    on: vi.fn(), execute, query, end, getConnection: async () => connection,
  }) as unknown as mysql.Pool);
  return { createPool, end, query, execute, connection };
}

describe('Hyperdrive connection selection', () => {
  it.each(['', '   '])('treats a blank direct URL as unconfigured: %j', (MYSQL_URL) => {
    expect(createWorkerDatabase({ MYSQL_URL })).toBeUndefined();
  });

  it('uses text protocol for health, reads, writes and transaction statements', async () => {
    const { query, execute, connection } = pools();
    const db = createWorkerDatabase({ HYPERDRIVE: hyperdrive })!;
    try {
      await db.healthcheck();
      await db.all('SELECT id FROM users WHERE name = ?', ["a' OR 1=1 --"]);
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO sessions(digest) VALUES (?)', [new Uint8Array([0, 39, 255])]);
      });
      expect(query.mock.calls).toEqual([
        ['SELECT 1 AS healthy', []],
        ['SELECT id FROM users WHERE name = ?', ["a' OR 1=1 --"]],
        ['INSERT INTO sessions(digest) VALUES (?)', [Buffer.from([0, 39, 255])]],
      ]);
      expect(Buffer.isBuffer(query.mock.calls[2]?.[1]?.[0])).toBe(true);
      expect(mysql.format(query.mock.calls[2]![0], [query.mock.calls[2]![1]![0] as Buffer]))
        .toBe("INSERT INTO sessions(digest) VALUES (X'0027ff')");
      expect(mysql.format(query.mock.calls[1]![0], [String(query.mock.calls[1]![1]![0])]))
        .toBe("SELECT id FROM users WHERE name = 'a\\' OR 1=1 --'");
      expect(execute).not.toHaveBeenCalled();
      expect(connection.commit).toHaveBeenCalledOnce();
      expect(connection.release).toHaveBeenCalledOnce();
    } finally { await db.close(); }
  });

  it('rejects structured query parameters instead of allowing SQL fragments', async () => {
    const { query } = pools();
    const db = createWorkerDatabase({ HYPERDRIVE: hyperdrive })!;
    try {
      await expect(db.first('SELECT id FROM users WHERE id = ?', [{ toSqlString: () => '1 OR 1=1' }]))
        .rejects.toThrow('database operation failed');
      expect(query).not.toHaveBeenCalled();
    } finally { await db.close(); }
  });

  it('prefers the Hyperdrive binding over the origin URL in auto mode', async () => {
    const { createPool, end } = pools();
    const response = await worker.fetch(new Request('https://example.test/api/health'), {
      MYSQL_URL: origin, HYPERDRIVE: hyperdrive,
    });
    await expect(response.json()).resolves.toMatchObject({ db: 'ok' });
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ ...hyperdrive, disableEval: true }));
    expect(createPool.mock.calls[0]?.[0]).not.toHaveProperty('ssl');
    expect(end).toHaveBeenCalledOnce();
  });

  it('supports Hyperdrive without an origin URL in production', async () => {
    const { createPool } = pools();
    const response = await worker.fetch(new Request('https://example.test/api/health'), {
      ENVIRONMENT: 'production', MYSQL_CONNECTION_MODE: 'hyperdrive', HYPERDRIVE: hyperdrive,
      CURSOR_SECRET: 'c'.repeat(32), GUESTBOOK_RATE_SECRET: 'g'.repeat(32),
    });
    await expect(response.json()).resolves.toMatchObject({ db: 'ok' });
    expect(createPool).toHaveBeenCalledOnce();
  });

  it('keeps direct mode on the origin even when Hyperdrive is bound', async () => {
    const { createPool } = pools();
    await worker.fetch(new Request('https://example.test/api/health'), {
      MYSQL_CONNECTION_MODE: 'direct', MYSQL_URL: origin, HYPERDRIVE: hyperdrive,
    });
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      ...parseMysqlUrl(origin), ssl: { rejectUnauthorized: true },
    }));
  });

  it('does not fall back to direct MySQL when Hyperdrive queries fail', async () => {
    const { createPool, end } = pools(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(new Request('https://example.test/api/health'), {
      MYSQL_CONNECTION_MODE: 'hyperdrive', MYSQL_URL: origin, HYPERDRIVE: hyperdrive,
    });
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ db: 'error' });
    expect(body).not.toContain(hyperdrive.password);
    expect(createPool).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('requires the binding when Hyperdrive is explicitly selected', () => {
    expect(() => resolveAppEnv({ MYSQL_CONNECTION_MODE: 'hyperdrive', MYSQL_URL: origin }))
      .toThrow('HYPERDRIVE binding is required');
  });

  it('rejects invalid connection modes', () => {
    expect(() => resolveAppEnv({ MYSQL_CONNECTION_MODE: 'typo', MYSQL_URL: origin }))
      .toThrow('MYSQL_CONNECTION_MODE');
  });

  it('reads fresh binding parameters for each invocation without reusing pools', async () => {
    const { createPool, end } = pools();
    for (const host of ['first.internal', 'second.internal']) {
      await worker.fetch(new Request('https://example.test/api/health'), { HYPERDRIVE: { ...hyperdrive, host } });
    }
    expect(createPool.mock.calls.map(([config]) => (config as mysql.PoolOptions).host))
      .toEqual(['first.internal', 'second.internal']);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('uses Hyperdrive for scheduled jobs and releases the pool', async () => {
    const { createPool, end } = pools();
    const bindings = { MYSQL_CONNECTION_MODE: 'hyperdrive', HYPERDRIVE: hyperdrive };
    await worker.scheduled({ cron: '0 3 * * *' } as ScheduledEvent, bindings);
    expect(createPool).toHaveBeenCalledOnce();
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining(hyperdrive));
    expect(end).toHaveBeenCalledOnce();
  });

  it('uses Hyperdrive for queue transactions and closes on a failed claim', async () => {
    const { createPool, end } = pools();
    const message = { body: { sourceId: 'missing', snapshotId: 'snapshot', generation: 0 }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] }, { MYSQL_CONNECTION_MODE: 'hyperdrive', HYPERDRIVE: hyperdrive });
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining(hyperdrive));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(end).toHaveBeenCalledOnce();
  });
});
