import mysql from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const commerceCronTick = vi.hoisted(() => vi.fn());
vi.mock('../src/commerce/jobs', () => ({ runCommerceCronTick: commerceCronTick }));
import worker from '../src/index';
import { resolveAppEnv } from '../src/env';

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

interface TrackedPool {
  closed: boolean;
  closeCalls: number;
  queries: string[];
}

function trackAuthPools(options: { failIdentity?: boolean; dailyCount?: number } = {}): TrackedPool[] {
  const pools: TrackedPool[] = [];
  vi.spyOn(mysql, 'createPool').mockImplementation(() => {
    const pool: TrackedPool & {
      on: ReturnType<typeof vi.fn>;
      execute(sql: string): Promise<unknown>;
      query(sql: string): Promise<unknown>;
      end(): Promise<void>;
    } = {
      closed: false,
      closeCalls: 0,
      queries: [],
      on: vi.fn(),
      async query(sql: string) { return pool.execute(sql); },
      async execute(sql: string) {
        if (pool.closed) throw new Error('connection belongs to a completed request');
        pool.queries.push(sql);
        if (sql.includes('SELECT 1 AS healthy')) return [[{ healthy: 1 }], []];
        if (sql.includes('FROM auth_sessions AS s')) {
          if (options.failIdentity) throw new Error('database unavailable');
          return [[{
            user_id: '10000', status: 'PENDING_EMAIL', credential_version: 1, auth_version: 1,
            expires_at: Date.now() + 86_400_000,
          }], []];
        }
        if (sql.includes('EXISTS (SELECT 1 FROM auth_avatars')) {
          return [[{
            id: '10000', email: 'player@example.test', display_name: 'Player', status: 'PENDING_EMAIL',
            email_verified_at: null, created_at: 1_700_000_000_000, avatar_version: 0, has_avatar: 0,
            permission_level: 0,
          }], []];
        }
        if (/^\s*SELECT\b/iu.test(sql) && sql.includes('FROM auth_rate_limits')) {
          return [[
            { scope: 'mail-budget-daily', request_count: options.dailyCount ?? 0, next_allowed_at: 0, expires_at: Number.MAX_SAFE_INTEGER },
            { scope: 'mail-budget-monthly', request_count: 0, next_allowed_at: 0, expires_at: Number.MAX_SAFE_INTEGER },
          ], []];
        }
        if (sql.includes('FROM auth_avatars AS a')) return [[{ avatar_base64: null, avatar_version: 0 }], []];
        return /^\s*(SELECT|SHOW)\b/iu.test(sql)
          ? [[], []]
          : [{ affectedRows: 0, insertId: 0 }, []];
      },
      async end() {
        pool.closeCalls += 1;
        pool.closed = true;
      },
    };
    pools.push(pool);
    return pool as unknown as mysql.Pool;
  });
  return pools;
}

afterEach(() => vi.restoreAllMocks());

describe('Worker account request lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    commerceCronTick.mockReset().mockResolvedValue(undefined);
  });

  it('passes raw optional auth settings without making public health or assets depend on them', async () => {
    const raw = resolveAppEnv({
      ENVIRONMENT: 'test', BUILD_VERSION: 'test', AUTH_ENABLED: 'true',
      AUTH_PASSWORD_SECRET: 'malformed-secret', AUTH_MAIL_DAILY_LIMIT: '-1', AUTH_MAIL_MONTHLY_LIMIT: 'invalid',
    });
    expect((raw as unknown as Record<string, unknown>).AUTH_ENABLED).toBe('true');
    expect((raw as unknown as Record<string, unknown>).AUTH_PASSWORD_SECRET).toBe('malformed-secret');
    expect((raw as unknown as Record<string, unknown>).AUTH_MAIL_DAILY_LIMIT).toBe('-1');

    const assetsFetch = vi.fn(async () => new Response('asset'));
    const bindings = {
      ENVIRONMENT: 'test', BUILD_VERSION: 'test', AUTH_ENABLED: 'true',
      AUTH_PASSWORD_SECRET: 'malformed-secret', AUTH_MAIL_DAILY_LIMIT: '-1', AUTH_MAIL_MONTHLY_LIMIT: 'invalid',
      ASSETS: { fetch: assetsFetch },
    };
    const health = await worker.fetch(new Request('https://lastro.example/api/health'), bindings);
    await expect(health.json()).resolves.toMatchObject({ ok: true, db: 'unconfigured' });
    const asset = await worker.fetch(new Request('https://lastro.example/'), bindings);
    expect(asset.status).toBe(200);
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  it('returns 503 for missing account dependencies while preserving public health and asset behavior', async () => {
    const assetsFetch = vi.fn(async () => new Response('asset'));
    const noMysql = authBindings({ MYSQL_URL: undefined, ASSETS: { fetch: assetsFetch } });
    const missingMysqlResponse = await worker.fetch(new Request('https://lastro.example/api/v1/auth/csrf'), noMysql);
    expect(missingMysqlResponse.status).toBe(503);
    await expect(missingMysqlResponse.json()).resolves.toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });
    const unconfiguredHealth = await worker.fetch(new Request('https://lastro.example/api/health'), noMysql);
    await expect(unconfiguredHealth.json()).resolves.toMatchObject({ ok: true, db: 'unconfigured' });
    expect((await worker.fetch(new Request('https://lastro.example/'), noMysql)).status).toBe(200);

    const pools = trackAuthPools();
    const missingCoreSecret = authBindings({ AUTH_CSRF_SECRET: undefined, ASSETS: { fetch: assetsFetch } });
    const missingSecretResponse = await worker.fetch(new Request('https://lastro.example/api/v1/auth/csrf'), missingCoreSecret);
    expect(missingSecretResponse.status).toBe(503);
    const configuredHealth = await worker.fetch(new Request('https://lastro.example/api/health'), missingCoreSecret);
    await expect(configuredHealth.json()).resolves.toMatchObject({ ok: true, db: 'ok' });
    expect((await worker.fetch(new Request('https://lastro.example/'), missingCoreSecret)).status).toBe(200);
    expect(assetsFetch).toHaveBeenCalledTimes(2);
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closeCalls).toBe(1);
  });

  it('maps known account requests after legacy production validation while preserving its public failure', async () => {
    const legacyBindings = { ENVIRONMENT: 'production', BUILD_VERSION: 'test' };

    const unavailable = await worker.fetch(new Request('https://lastro.example/api/v1/auth/csrf'), legacyBindings);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });

    const unknown = await worker.fetch(new Request('https://lastro.example/api/v1/auth/not-a-route'), legacyBindings);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'AUTH_NOT_FOUND' } });

    await expect(worker.fetch(new Request('https://lastro.example/api/health'), legacyBindings))
      .rejects.toThrow('MYSQL_URL must be configured outside local environments');
    await expect(worker.fetch(new Request('https://lastro.example/api/v1/authentic'), legacyBindings))
      .rejects.toThrow('MYSQL_URL must be configured outside local environments');
  });

  it('forwards valid auth bindings and does not depend on waitUntil for account requests', async () => {
    const waitUntil = vi.fn();
    const response = await worker.fetch(
      new Request('https://lastro.example/api/v1/auth/csrf'),
      authBindings(),
      { waitUntil },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ csrf_token: expect.stringMatching(/^v1\.a\./u) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('__Host-ltsd-csrf=');
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('uses configured mail limits, authenticates once, avoids session lookup for public avatars, and closes each request pool', async () => {
    const pools = trackAuthPools({ dailyCount: 25 });
    const bindings = authBindings({ AUTH_MAIL_DAILY_LIMIT: '25', AUTH_MAIL_MONTHLY_LIMIT: '700' });
    const waitUntil = vi.fn();

    const me = await worker.fetch(new Request('https://lastro.example/api/v1/auth/me', {
      headers: { cookie: `__Host-ltsd-session=${'A'.repeat(43)}` },
    }), bindings, { waitUntil });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      user: { id: '10000', status: 'PENDING_EMAIL' },
      mail_availability: { code: 'MAIL_DAILY_QUOTA' },
    });
    expect(pools[0]?.queries.filter((sql) => sql.includes('FROM auth_sessions AS s'))).toHaveLength(1);
    expect(pools[0]?.closeCalls).toBe(1);

    const avatar = await worker.fetch(new Request('https://lastro.example/api/v1/users/10000/avatar?v=0'), bindings);
    expect(avatar.status).toBe(200);
    expect(pools[1]?.queries.some((sql) => sql.includes('FROM auth_sessions AS s'))).toBe(false);
    expect(pools[1]?.closeCalls).toBe(1);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('closes the request pool exactly once when account authentication fails', async () => {
    const pools = trackAuthPools({ failIdentity: true });
    const response = await worker.fetch(new Request('https://lastro.example/api/v1/auth/me', {
      headers: { cookie: `__Host-ltsd-session=${'A'.repeat(43)}` },
    }), authBindings());

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('AUTH_UNAVAILABLE');
    expect(body).not.toContain('database unavailable');
    expect(pools[0]?.closeCalls).toBe(1);
  });

  it('does not open a database for the independent auth cron when account auth is disabled', async () => {
    const pools = trackAuthPools();

    await worker.scheduled(
      { cron: '*/2 * * * *' } as ScheduledEvent,
      authBindings({ AUTH_ENABLED: 'false' }),
    );

    expect(pools).toHaveLength(0);
  });

  it('continues snapshot cron work when the commerce cron tick fails', async () => {
    const pools = trackAuthPools();
    commerceCronTick.mockRejectedValueOnce(new Error('commerce database unavailable'));

    await expect(worker.scheduled(
      { cron: '* * * * *' } as ScheduledEvent,
      authBindings({ AUTH_ENABLED: 'false' }),
    )).resolves.toBeUndefined();

    expect(commerceCronTick).toHaveBeenCalledTimes(1);
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closeCalls).toBe(1);
  });

  it.each([false, true])('runs one cleanup category without Resend and closes its independent cron pool once (Hyperdrive: %s)', async (hyperdrive) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-14T10:07:31.000Z'));
    const pools = trackAuthPools();

    await worker.scheduled(
      { cron: '*/2 * * * *' } as ScheduledEvent,
      authBindings({ AUTH_MAIL_DAILY_LIMIT: '25', AUTH_MAIL_MONTHLY_LIMIT: '700', ...(hyperdrive ? {
        MYSQL_URL: undefined, MYSQL_CONNECTION_MODE: 'hyperdrive',
        HYPERDRIVE: { host: 'hyperdrive.internal', port: 3306, user: 'user', password: 'secret', database: 'app' },
      } : {}) }),
    );

    expect(pools).toHaveLength(1);
    expect(pools[0]?.closeCalls).toBe(1);
    expect(pools[0]?.queries.filter((sql) => /^(?:\s*UPDATE\s+auth_|\s*DELETE\s+FROM\s+auth_)/iu.test(sql))).toHaveLength(1);
    expect(pools[0]?.queries.some((sql) => /\b(?:snapshots|shops|listings)\b/iu.test(sql))).toBe(false);
  });
});
