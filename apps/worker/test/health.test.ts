import { describe, expect, it } from 'vitest';
import worker, { createApp } from '../src/index';
import { resolveAppEnv } from '../src/env';
import { healthPayload } from '../src/routes/health';
import type { MysqlDatabase } from '../src/db/mysql-client';

describe('health route', () => {
  it('returns worker health metadata', async () => {
    const app = createApp({
      ENVIRONMENT: 'test',
      BUILD_VERSION: 'test-build',
      MAX_BODY_BYTES: 512 * 1024,
    });

    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, version: 'test-build', db: 'unconfigured', environment: 'test' });
  });

  it('resolves raw Worker bindings before serving requests', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/health'), {
      ENVIRONMENT: 42,
      BUILD_VERSION: 123,
      MAX_BODY_BYTES: 'invalid',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: '123', environment: '42', db: 'unconfigured' });
  });

  it('requires MYSQL_URL outside local environments', () => {
    expect(() => resolveAppEnv({ ENVIRONMENT: 'production', CURSOR_SECRET: 'a'.repeat(16) })).toThrow('MYSQL_URL must be configured');
  });

  it('requires an independent guestbook rate secret in production', () => {
    expect(() => resolveAppEnv({ ENVIRONMENT: 'production', MYSQL_URL: 'mysql://user:pass@localhost/db', CURSOR_SECRET: 'a'.repeat(16) })).toThrow('GUESTBOOK_RATE_SECRET');
  });

  it('reports actual healthcheck state without exposing database details', async () => {
    const env = { ENVIRONMENT: 'test', BUILD_VERSION: 'test-build', MAX_BODY_BYTES: 1, MYSQL_URL: 'mysql://redacted' };
    await expect(healthPayload(env, { healthcheck: async () => undefined })).resolves.toMatchObject({ db: 'ok' });
    await expect(healthPayload(env, { healthcheck: async () => { throw new Error('password must not leak'); } })).resolves.toMatchObject({ db: 'error' });
  });

  it('uses the injected MySQL adapter for the HTTP health route', async () => {
    let calls = 0;
    const database = { healthcheck: async () => { calls += 1; } } as MysqlDatabase;
    const app = createApp({ ENVIRONMENT: 'test', BUILD_VERSION: 'test-build', MAX_BODY_BYTES: 1, MYSQL_URL: 'mysql://redacted' }, database);

    const response = await app.request('/api/health');
    await expect(response.json()).resolves.toMatchObject({ db: 'ok' });
    expect(calls).toBe(1);
  });
});
