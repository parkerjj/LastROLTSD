import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';

describe('health route', () => {
  it('returns worker health metadata', async () => {
    const app = createApp({
      ENVIRONMENT: 'test',
      BUILD_VERSION: 'test-build',
      MAX_BODY_BYTES: 512 * 1024,
    });

    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: 'test-build',
      db: 'unconfigured',
    });
  });
});
