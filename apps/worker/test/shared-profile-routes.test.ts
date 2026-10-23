import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../src/db/mysql-client';
import type { AppEnv } from '../src/env';
import { parseProfileInput, registerKeRoutes } from '../src/ke/router';

const SITE = 'https://lastro.example';
function bindings(): AppEnv {
  const secret = (n: number) => Buffer.alloc(32, n).toString('base64');
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 524288,
    MYSQL_URL: 'mysql://local@127.0.0.1/lastro_test', AUTH_ENABLED: 'true', AUTH_SITE_URL: SITE,
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
  } as AppEnv;
}
function appFor(): Hono {
  const app = new Hono();
  registerKeRoutes(app, bindings(), {} as MysqlDatabase);
  return app;
}
async function responseCode(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json() as { error: { code: string } }).error.code;
}

describe('shared profile routes: session cookie and write Origin', () => {
  for (const path of ['/api/v1/ke/shared-profiles', '/api/v1/ke/shared-profiles/1', '/api/v1/ke/shared-profiles/code/ABC-1234']) {
    it(`${path} requires a web session even with a Bearer token and no KE license keys`, async () => {
      const response = await appFor().request(path, { headers: { authorization: `Bearer ke1_${'a'.repeat(43)}` } });
      expect(response.status).toBe(401);
      expect(await responseCode(response)).toBe('KE_AUTH_UNAUTHENTICATED');
    });
  }
  for (const [method, path] of [
    ['PUT', '/api/v1/ke/shared-profiles/1/like'],
    ['DELETE', '/api/v1/ke/shared-profiles/1/like'],
    ['POST', '/api/v1/ke/shared-profiles/1/copy'],
    ['DELETE', '/api/v1/ke/shared-profiles/1/withdraw'],
    ['DELETE', '/api/v1/ke/profiles/1/sharing'],
  ] as const) {
    it(`${method} ${path} checks Origin before session authentication`, async () => {
      const app = appFor();
      for (const headers of [{}, { origin: 'https://evil.example' }, { origin: SITE, 'sec-fetch-site': 'cross-site' }]) {
        const response = await app.request(path, { method, headers });
        expect(response.status).toBe(403);
        expect(await responseCode(response)).toBe('KE_AUTH_FORBIDDEN');
      }
      const response = await app.request(path, { method, headers: { origin: SITE } });
      expect(response.status).toBe(401);
      expect(await responseCode(response)).toBe('KE_AUTH_UNAUTHENTICATED');
    });
  }
  for (const [method, path] of [['POST', '/api/v1/ke/profiles'], ['PUT', '/api/v1/ke/profiles/1']] as const) {
    it(`${method} personal save checks Origin only when publishing`, async () => {
      const app = appFor();
      for (const sharing of [undefined, { enabled: false }]) {
        const response = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sharing }) });
        expect(response.status).toBe(401);
      }
      const response = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sharing: { enabled: true } }) });
      expect(response.status).toBe(403);
      expect(await responseCode(response)).toBe('KE_AUTH_FORBIDDEN');
    });
  }
});

describe('sharing input parsing preserves the old save contract', () => {
  it('omitted sharing stays omitted, while an empty description can explicitly clear it', () => {
    expect(parseProfileInput({})).not.toHaveProperty('sharing');
    expect(parseProfileInput({ sharing: { enabled: true, description: '' } })).toHaveProperty('sharing', { enabled: true, description: '' });
    expect(parseProfileInput({ sharing: { enabled: false } })).toHaveProperty('sharing', { enabled: false });
    expect(parseProfileInput({ sharing: { enabled: true } }).sharing).not.toHaveProperty('description');
  });
  for (const sharing of [null, true, [], {}, { enabled: 1 }, { enabled: 'true' }, { enabled: true, description: null }, { enabled: false, description: 1 }]) {
    it(`rejects malformed sharing ${JSON.stringify(sharing)}`, () => {
      expect(() => parseProfileInput({ sharing })).toThrow();
    });
  }
});
