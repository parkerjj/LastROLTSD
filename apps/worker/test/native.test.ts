import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerNativeRoutes, resetNativeManifestCacheForTesting } from '../src/routes/native';

const LATEST_URL = 'https://client.ltsd.ro/native/latest.json';
const LINUX_URL = 'https://client.ltsd.ro/native/linux.json';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Native release routes', () => {
  beforeEach(() => resetNativeManifestCacheForTesting());

  it('serves both official manifests through same-origin cacheable endpoints', async () => {
    const latest = { version: '1.1035.261121', installers: { 'windows-x86_64': { url: 'https://client.ltsd.ro/native/windows.exe' } } };
    const linux = { version: '1.1035.261121', platforms: { 'linux-x86_64-deb': { url: 'https://client.ltsd.ro/native/linux.deb' } } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const payload = String(input) === LINUX_URL ? linux : latest;
      return Promise.resolve(jsonResponse(payload));
    });
    try {
      const app = new Hono();
      registerNativeRoutes(app);

      const latestResponse = await app.request('/api/v1/native/latest');
      const linuxResponse = await app.request('/api/v1/native/linux');

      expect(latestResponse.status).toBe(200);
      expect(latestResponse.headers.get('cache-control')).toContain('s-maxage=1800');
      await expect(latestResponse.json()).resolves.toEqual(latest);
      expect(linuxResponse.status).toBe(200);
      await expect(linuxResponse.json()).resolves.toEqual(linux);
      expect(fetchMock).toHaveBeenCalledWith(LATEST_URL, expect.objectContaining({ cf: { cacheTtl: 30 } }));
      expect(fetchMock).toHaveBeenCalledWith(LINUX_URL, expect.objectContaining({ cf: { cacheTtl: 30 } }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('reuses the in-memory manifest cache', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ version: '1.1035.261121' }));
    try {
      const app = new Hono();
      registerNativeRoutes(app);

      await app.request('/api/v1/native/latest');
      await app.request('/api/v1/native/latest');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns 502 without caching an unavailable upstream response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    try {
      const app = new Hono();
      registerNativeRoutes(app);
      const response = await app.request('/api/v1/native/latest');

      expect(response.status).toBe(502);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({ error: 'Native release manifest unavailable' });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
