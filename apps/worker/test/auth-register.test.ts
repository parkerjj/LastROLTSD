import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerAuthRoutes } from '../src/auth/router';
import type { AuthBindings } from '../src/auth/types';
import type { AppEnv } from '../src/env';
import type { MysqlDatabase } from '../src/db/mysql-client';

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: standardBase64(1), AUTH_CSRF_SECRET: standardBase64(2),
    AUTH_RATE_SECRET: standardBase64(3), AUTH_MAIL_PAYLOAD_SECRET: standardBase64(4),
  };
}

describe('account registration', () => {
  it('rejects the unsupported registration avatar explicitly', async () => {
    const app = new Hono();
    registerAuthRoutes(app, bindings(), {} as MysqlDatabase, { now: () => 1_000, fetch: globalThis.fetch });

    const csrfResponse = await app.request('/api/v1/auth/csrf', {
      headers: { origin: 'https://lastro.example' },
    });
    const csrf = await csrfResponse.json() as { csrf_token: string };
    const cookie = csrfResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const response = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: {
        origin: 'https://lastro.example',
        'content-type': 'application/json',
        'x-csrf-token': csrf.csrf_token,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        email: 'pilot@example.test', password: '12345', password_confirmation: '12345',
        display_name: 'Pilot', avatar_base64: 'AA==',
      }),
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_AVATAR_UNSUPPORTED' } });
  });
});
