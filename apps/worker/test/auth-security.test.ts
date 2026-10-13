import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { resolveAuthConfig } from '../src/auth/config';
import { assertCsrf, issueCsrf } from '../src/auth/csrf';
import { authRateLimitKey, consumeAuthRateLimit } from '../src/auth/rate-limit';
import { createAuthRepository } from '../src/auth/repository';
import { registerAuthRoutes } from '../src/auth/router';
import type { AuthBindings, AuthConfig, AuthRateLimitRule } from '../src/auth/types';
import type { AppEnv } from '../src/env';
import type { MysqlDatabase } from '../src/db/mysql-client';
import { registerCorsMiddleware } from '../src/middleware/cors';

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(overrides: Partial<AppEnv & AuthBindings> = {}): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test',
    BUILD_VERSION: 'test',
    MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true',
    AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: standardBase64(1),
    AUTH_CSRF_SECRET: standardBase64(2),
    AUTH_RATE_SECRET: standardBase64(3),
    AUTH_MAIL_PAYLOAD_SECRET: standardBase64(4),
    ...overrides,
  };
}

function postRequest(token: string | undefined, cookie: string | undefined, origin = 'https://lastro.example'): Request {
  const headers = new Headers({ origin });
  if (token !== undefined) headers.set('x-csrf-token', token);
  if (cookie !== undefined) headers.set('cookie', cookie);
  return new Request('https://lastro.example/api/v1/auth/logout', { method: 'POST', headers });
}

describe('account CSRF and route security', () => {
  it('reuses the anonymous nonce and rejects cross-origin, missing-token, and wrong-cookie writes', async () => {
    const config = resolveAuthConfig(bindings());
    const first = await issueCsrf(new Request('https://lastro.example/api/v1/auth/csrf', {
      headers: { origin: 'https://lastro.example' },
    }), config, 'anonymous');
    expect(first.token).toMatch(/^v1\.a\.\d+\.[A-Za-z0-9_-]{43}$/u);
    expect(first.cookie).toContain('__Host-ltsd-csrf=');
    expect(first.cookie).toContain('Max-Age=1800');
    expect(first.cookie).toContain('Path=/');
    expect(first.cookie).toContain('HttpOnly');
    expect(first.cookie).toContain('Secure');
    expect(first.cookie).toContain('SameSite=Lax');
    expect(first.cookie).not.toMatch(/(?:^|;)\s*Domain=/iu);

    const cookiePair = first.cookie!.split(';', 1)[0]!;
    const second = await issueCsrf(new Request('https://lastro.example/api/v1/auth/csrf', {
      headers: { origin: 'https://lastro.example', cookie: cookiePair },
    }), config, 'anonymous');
    expect(second.cookie).toBeUndefined();
    await expect(assertCsrf(postRequest(first.token, cookiePair), config, 'anonymous')).resolves.toBeUndefined();
    await expect(assertCsrf(postRequest(second.token, cookiePair), config, 'anonymous')).resolves.toBeUndefined();
    await expect(assertCsrf(new Request('https://worker.internal/api/v1/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://lastro.example', 'x-forwarded-host': 'worker.internal', 'x-csrf-token': first.token, cookie: cookiePair },
    }), config, 'anonymous')).resolves.toBeUndefined();

    await expect(assertCsrf(postRequest(first.token, cookiePair, 'https://game.lastro.cn'), config, 'anonymous'))
      .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
    await expect(assertCsrf(postRequest(first.token, cookiePair, 'https://sub.lastro.example'), config, 'anonymous'))
      .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
    await expect(assertCsrf(postRequest(undefined, cookiePair), config, 'anonymous'))
      .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
    await expect(assertCsrf(new Request('https://lastro.example/api/v1/auth/logout', {
      method: 'POST', headers: { 'x-csrf-token': first.token, cookie: cookiePair },
    }), config, 'anonymous')).rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
    await expect(assertCsrf(postRequest(first.token, `__Host-ltsd-csrf=${'A'.repeat(43)}`), config, 'anonymous'))
      .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
  });

  it('keeps session and anonymous CSRF tokens bound to their fixed modes and session digest', async () => {
    const config = resolveAuthConfig(bindings());
    const identity = { userId: '10000', status: 'ACTIVE' as const, credentialVersion: 1, authVersion: 1, sessionDigest: new Uint8Array(32).fill(7) };
    const request = new Request('https://lastro.example/api/v1/auth/me', { headers: { origin: 'https://lastro.example' } });
    const session = await issueCsrf(request, config, 'session', identity);
    expect(session.token).toMatch(/^v1\.s\.[A-Za-z0-9_-]{43}$/u);
    expect(session.cookie).toBeUndefined();
    await expect(assertCsrf(postRequest(session.token, undefined), config, 'session', identity)).resolves.toBeUndefined();

    await expect(assertCsrf(postRequest(session.token, undefined), config, 'session', {
      ...identity, sessionDigest: new Uint8Array(32).fill(8),
    })).rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
    await expect(assertCsrf(postRequest(session.token, `__Host-ltsd-csrf=${'B'.repeat(43)}`), config, 'anonymous'))
      .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
  });

  it('rejects future and expired anonymous tokens and uses a separate local cookie name', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const config = resolveAuthConfig(bindings());
      const issued = await issueCsrf(new Request('https://lastro.example/api/v1/auth/csrf', {
        headers: { origin: 'https://lastro.example' },
      }), config, 'anonymous');
      const cookiePair = issued.cookie!.split(';', 1)[0]!;

      vi.setSystemTime(1_799_999_999_999);
      await expect(assertCsrf(postRequest(issued.token, cookiePair), config, 'anonymous'))
        .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });

      vi.setSystemTime(1_800_000_000_000 + 30 * 60 * 1000 + 1);
      await expect(assertCsrf(postRequest(issued.token, cookiePair), config, 'anonymous'))
        .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });

      const localConfig = resolveAuthConfig(bindings({ ENVIRONMENT: 'local', AUTH_SITE_URL: 'http://localhost:5173' }));
      vi.setSystemTime(1_800_000_000_000);
      const local = await issueCsrf(new Request('http://localhost:5173/api/v1/auth/csrf', {
        headers: { origin: 'http://localhost:5173' },
      }), localConfig, 'anonymous');
      expect(local.cookie).toContain('lastroweb-csrf-local=');
      expect(local.cookie).not.toContain('Secure');
      expect(local.cookie).toContain('HttpOnly');

      const controlledNow = 1_800_000_000_000;
      vi.setSystemTime(controlledNow);
      const controlled = await issueCsrf(new Request('https://lastro.example/api/v1/auth/csrf', {
        headers: { origin: 'https://lastro.example' },
      }), config, 'anonymous');
      const controlledCookie = controlled.cookie!.split(';', 1)[0]!;
      const assertCsrfWithNow = assertCsrf as unknown as (
        request: Request,
        selectedConfig: AuthConfig,
        mode: 'anonymous',
        identity: undefined,
        now: () => number,
      ) => Promise<void>;
      vi.setSystemTime(controlledNow + 31 * 60 * 1000);
      await expect(assertCsrfWithNow(postRequest(controlled.token, controlledCookie), config, 'anonymous', undefined, () => controlledNow))
        .resolves.toBeUndefined();
      await expect(assertCsrf(postRequest(controlled.token, controlledCookie), config, 'anonymous'))
        .rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', status: 403 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('separates email and IP HMAC keys and fails closed in the standalone route entry', async () => {
    const secret = new Uint8Array(32).fill(9);
    const emailKey = await authRateLimitKey(secret, 'email', 'same@example.test');
    expect(await authRateLimitKey(secret, 'email', 'same@example.test')).toEqual(emailKey);
    expect(await authRateLimitKey(secret, 'ip', 'same@example.test')).not.toEqual(emailKey);

    const failingRepository = createAuthRepository({
      transaction: async () => { throw new Error('database unavailable'); },
    } as unknown as MysqlDatabase);
    const rule: AuthRateLimitRule = {
      kind: 'window', scope: 'login_ip', keyDigest: new Uint8Array(32).fill(1), limit: 2, windowMs: 60_000,
    };
    await expect(consumeAuthRateLimit(failingRepository, [rule], () => 1_800_000_000_000))
      .rejects.toThrow('database unavailable');

    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('/api/*', async (c, next) => {
      c.set('requestId', 'auth-security-test');
      await next();
    });
    registerCorsMiddleware(app);
    registerAuthRoutes(app, bindings(), {} as MysqlDatabase, { now: () => 1_000, fetch: globalThis.fetch });
    const csrfResponse = await app.request('/api/v1/auth/csrf', { headers: { origin: 'https://lastro.example' } });
    expect(csrfResponse.status).toBe(200);
    expect(csrfResponse.headers.get('cache-control')).toBe('no-store');
    expect((await csrfResponse.json() as { csrf_token: string }).csrf_token).toMatch(/^v1\.a\.1000\./u);

    const extraFieldResponse = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { origin: 'https://lastro.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'player@example.test', password: '12345', password_confirmation: '12345', display_name: 'Player', status: 'ACTIVE', user_id: '10000' }),
    });
    expect(extraFieldResponse.status).toBe(400);
    expect(await extraFieldResponse.json()).toMatchObject({ error: { code: 'AUTH_BAD_REQUEST' } });

    const largeRegister = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { origin: 'https://lastro.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'player@example.test', password: '12345', password_confirmation: '12345', display_name: 'Player', avatar_base64: 'A'.repeat(12_000) }),
    });
    expect(largeRegister.status).toBe(403);
    const largeAvatar = await app.request('/api/v1/account/avatar', {
      method: 'PUT',
      headers: { origin: 'https://lastro.example', 'content-type': 'application/json' },
      body: JSON.stringify({ avatar_base64: 'A'.repeat(12_000) }),
    });
    expect(largeAvatar.status).toBe(401);
    const largeLogin = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: 'https://lastro.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'player@example.test', password: 'A'.repeat(8 * 1024) }),
    });
    expect(largeLogin.status).toBe(413);

    const knownRouteResponse = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: 'https://lastro.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'player@example.test', password: '12345' }),
    });
    expect(knownRouteResponse.status).toBe(403);
    expect(await knownRouteResponse.json()).toMatchObject({ error: { code: 'AUTH_CSRF_INVALID' } });

    const unknown = await app.request('/api/v1/auth/not-a-route');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    expect(await unknown.json()).toMatchObject({ error: { code: 'AUTH_NOT_FOUND', request_id: 'auth-security-test' } });

    const unknownOptions = await app.request('/api/v1/auth/not-a-route', { method: 'OPTIONS' });
    expect(unknownOptions.status).toBe(404);
    expect(unknownOptions.headers.get('access-control-allow-origin')).toBeNull();
    expect(unknownOptions.headers.get('content-type')).toContain('application/json');

    const csrfOptions = await app.request('/api/v1/auth/csrf', { method: 'OPTIONS' });
    expect(csrfOptions.status).toBe(204);
    expect(csrfOptions.headers.get('access-control-allow-origin')).toBeNull();

    const noDatabaseApp = new Hono();
    registerAuthRoutes(noDatabaseApp, bindings());
    const csrfWithoutDatabase = await noDatabaseApp.request('/api/v1/auth/csrf');
    expect(csrfWithoutDatabase.status).toBe(200);
    expect(csrfWithoutDatabase.headers.get('set-cookie')).toContain('__Host-ltsd-csrf=');
    const missingDatabase = await noDatabaseApp.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: 'https://lastro.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'player@example.test', password: '12345' }),
    });
    expect(missingDatabase.status).toBe(503);
    expect(typeof (await missingDatabase.json() as { error: { request_id?: unknown } }).error.request_id).toBe('string');
  });
});
