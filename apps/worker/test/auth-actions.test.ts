import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerAuthRoutes } from '../src/auth/router';
import type { AuthBindings } from '../src/auth/types';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import type { AppEnv } from '../src/env';

const BASE_TIME = Date.UTC(2026, 9, 13, 12);

function secret(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}

function bindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2), AUTH_RATE_SECRET: secret(3),
    AUTH_MAIL_PAYLOAD_SECRET: secret(4),
  };
}

class ActionRequestDatabase implements MysqlDatabase {
  async all<T extends MysqlRow>(): Promise<T[]> {
    return [];
  }

  async first<T extends MysqlRow>(sql: string): Promise<T | null> {
    if (/FROM auth_rate_limits/iu.test(sql)) {
      return { request_count: 0, next_allowed_at: 0, expires_at: BASE_TIME + 86_400_000 } as unknown as T;
    }
    return null;
  }

  async run(): Promise<MysqlWriteResult> {
    return { affectedRows: 1, insertId: 1 };
  }

  transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async healthcheck(): Promise<void> {}

  async close(): Promise<void> {}
}

describe('account actions', () => {
  it('returns the same accepted response for an unknown password-reset email', async () => {
    const app = new Hono();
    const database = new ActionRequestDatabase();
    const runtime = { now: () => BASE_TIME, fetch: (async () => new Response('{}')) as typeof fetch };
    registerAuthRoutes(app, bindings(), database, runtime);

    const csrfResponse = await app.request('/api/v1/auth/csrf', {
      headers: { origin: 'https://lastro.example' },
    });
    const csrf = await csrfResponse.json() as { csrf_token: string };
    const csrfCookie = csrfResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(csrfCookie).toBeTruthy();

    const response = await app.request('/api/v1/auth/password-reset/request', {
      method: 'POST',
      headers: {
        origin: 'https://lastro.example',
        'content-type': 'application/json',
        'x-csrf-token': csrf.csrf_token,
        cookie: csrfCookie!,
      },
      body: JSON.stringify({ email: 'missing@example.test' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      mail_availability: { code: 'AVAILABLE', retry_at: null },
    });
  });
});
