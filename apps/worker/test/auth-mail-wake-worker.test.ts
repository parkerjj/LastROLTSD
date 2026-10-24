import mysql from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resolveAppEnv } from '../src/env';
import { MAIL_WAKE_MESSAGE } from '../src/auth/mail-wake';

function secret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authBindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2), AUTH_RATE_SECRET: secret(3),
    AUTH_MAIL_PAYLOAD_SECRET: secret(4), ...overrides,
  };
}

const withResend = { RESEND_API_KEY: 're_test-key', MAIL_FROM: 'LTSD <auth@example.test>' };

interface TrackedPool { queries: string[]; closeCalls: number }

/** A pool whose connections run the same fake database, optionally failing every statement. */
function trackPools(options: { fail?: boolean; failWhen?: RegExp } = {}): TrackedPool[] {
  const pools: TrackedPool[] = [];
  vi.spyOn(mysql, 'createPool').mockImplementation(() => {
    const tracked: TrackedPool = { queries: [], closeCalls: 0 };
    const run = async (sql: string): Promise<unknown> => {
      tracked.queries.push(sql);
      if (options.fail || options.failWhen?.test(sql)) throw new Error('connection refused to db.internal:3306');
      if (/^\s*(SELECT|SHOW)\b/iu.test(sql)) return [[], []];
      return [{ affectedRows: 0, insertId: 0 }, []];
    };
    const connection = {
      execute: run, query: run,
      beginTransaction: async () => undefined, commit: async () => undefined,
      rollback: async () => undefined, release: () => undefined,
    };
    pools.push(tracked);
    return {
      on: vi.fn(), execute: run, query: run,
      getConnection: async () => connection,
      end: async () => { tracked.closeCalls += 1; },
    } as unknown as mysql.Pool;
  });
  return pools;
}

function wakeBatch() {
  const message = { body: MAIL_WAKE_MESSAGE, ack: vi.fn(), retry: vi.fn() };
  return { message, batch: { messages: [message] } };
}

function loggedMetrics(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.flatMap(([line]) => {
    try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; }
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Worker mail wake consumer', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });

  it('passes the optional MAIL_QUEUE binding through environment resolution', () => {
    const queue = { send: vi.fn() };
    expect(resolveAppEnv({ ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAIL_QUEUE: queue }).MAIL_QUEUE).toBe(queue);
    expect(resolveAppEnv({ ENVIRONMENT: 'test', BUILD_VERSION: 'test' }).MAIL_QUEUE).toBeUndefined();
  });

  it('acknowledges wake messages without opening a database while account auth is disabled', async () => {
    const pools = trackPools();
    const { batch, message } = wakeBatch();

    await worker.queue(batch, authBindings({ AUTH_ENABLED: 'false' }));

    expect(pools).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('claims ready outbox mail on wake and closes its own pool exactly once', async () => {
    const pools = trackPools();
    const { batch, message } = wakeBatch();

    await worker.queue(batch, authBindings(withResend));

    expect(pools).toHaveLength(1);
    expect(pools[0]!.closeCalls).toBe(1);
    expect(pools[0]!.queries.some((sql) => /FROM\s+auth_mail_outbox/iu.test(sql))).toBe(true);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries the wake and logs a sanitized, diagnosable error when the database fails', async () => {
    const pools = trackPools({ fail: true });
    const { batch, message } = wakeBatch();

    await worker.queue(batch, authBindings(withResend));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(pools[0]!.closeCalls).toBe(1);
    const failure = loggedMetrics(errorLog).find((entry) => entry.metric === 'lastroweb.auth_mail_wake_failed');
    expect(failure).toMatchObject({ error_class: 'MysqlDatabaseError', level: 'error' });
    expect(failure).toHaveProperty('mysql_operation');
    expect(JSON.stringify(failure)).not.toContain('db.internal');
  });
});

describe('Worker auth cron diagnostics', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });

  it('logs the failing database operation without leaking connection details, then still fails the invocation', async () => {
    const pools = trackPools({ fail: true });

    await expect(worker.scheduled({ cron: '*/2 * * * *' } as ScheduledEvent, authBindings(withResend)))
      .rejects.toThrow('auth background job failed');

    expect(pools[0]!.closeCalls).toBe(1);
    const failure = loggedMetrics(errorLog).find((entry) => entry.metric === 'lastroweb.auth_job_failed');
    expect(failure).toMatchObject({ error_class: 'MysqlDatabaseError', level: 'error' });
    expect(failure).toHaveProperty('mysql_operation');
    expect(JSON.stringify(failure)).not.toContain('db.internal');
  });

  it('makes the silent "no Resend key" skip visible at error level', async () => {
    trackPools();

    await worker.scheduled({ cron: '*/2 * * * *' } as ScheduledEvent, authBindings());

    const entry = loggedMetrics(errorLog).find((item) => item.metric === 'lastroweb.auth_job_mail_unconfigured');
    expect(entry).toMatchObject({ level: 'error' });
  });

  it('reports why a configuration was rejected instead of returning silently', async () => {
    const pools = trackPools();

    await worker.scheduled({ cron: '*/2 * * * *' } as ScheduledEvent, authBindings({ AUTH_CSRF_SECRET: undefined }));

    expect(pools).toHaveLength(0);
    const entry = loggedMetrics(errorLog).find((item) => item.metric === 'lastroweb.auth_job_config_unavailable');
    expect(entry).toMatchObject({ level: 'error', error_class: 'AuthFailure' });
  });

  it('stays quiet when the tick has nothing to send', async () => {
    trackPools();

    await worker.scheduled({ cron: '*/2 * * * *' } as ScheduledEvent, authBindings(withResend));

    expect(loggedMetrics(errorLog).filter((item) => String(item.metric).startsWith('lastroweb.auth_job'))).toEqual([]);
  });
});

describe('Worker per-minute cron carries the account mail fallback', () => {
  const EVEN_MINUTE = Date.UTC(2026, 9, 24, 5, 28, 36);
  const ODD_MINUTE = Date.UTC(2026, 9, 24, 5, 29, 36);
  const minuteCron = (scheduledTime: number) => ({ cron: '* * * * *', scheduledTime }) as ScheduledEvent;
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });

  it('runs the account tick alongside snapshot work', async () => {
    const pools = trackPools();

    await worker.scheduled(minuteCron(EVEN_MINUTE), authBindings(withResend));

    const authQueries = pools.flatMap((pool) => pool.queries).filter((sql) => /\bauth_/iu.test(sql));
    expect(authQueries.some((sql) => /FROM\s+auth_mail_outbox/iu.test(sql))).toBe(true);
    expect(pools.every((pool) => pool.closeCalls === 1)).toBe(true);
  });

  it('runs the account tick on every minute, odd or even', async () => {
    const pools = trackPools();

    await worker.scheduled(minuteCron(ODD_MINUTE), authBindings(withResend));

    const authQueries = pools.flatMap((pool) => pool.queries).filter((sql) => /\bauth_/iu.test(sql));
    expect(authQueries.some((sql) => /FROM\s+auth_mail_outbox/iu.test(sql))).toBe(true);
  });

  it('does not touch account tables while account auth is disabled', async () => {
    const pools = trackPools();

    await worker.scheduled(minuteCron(EVEN_MINUTE), authBindings({ AUTH_ENABLED: 'false' }));

    expect(pools.flatMap((pool) => pool.queries).some((sql) => /\bauth_/iu.test(sql))).toBe(false);
  });

  it('logs an account tick failure without failing the snapshot cron', async () => {
    const pools = trackPools({ failWhen: /\bauth_/iu });

    await expect(worker.scheduled(minuteCron(EVEN_MINUTE), authBindings(withResend))).resolves.toBeUndefined();

    expect(pools.every((pool) => pool.closeCalls === 1)).toBe(true);
    const failure = loggedMetrics(errorLog).find((entry) => entry.metric === 'lastroweb.auth_job_failed');
    expect(failure).toMatchObject({ error_class: 'MysqlDatabaseError', level: 'error' });
  });
});
