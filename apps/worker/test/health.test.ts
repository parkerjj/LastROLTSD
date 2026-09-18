import { describe, expect, it } from 'vitest';
import worker, { createApp } from '../src/index';

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
});
