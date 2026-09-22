import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerAssetRoute } from '../src/routes/assets';

describe('RMS item asset proxy', () => {
  it('fetches a fixed RMS asset URL and returns a cacheable image', async () => {
    const upstream = new Response(new Uint8Array([71, 73, 70, 56]), { status: 200, headers: { 'content-type': 'image/gif' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);
    try {
      const app = new Hono();
      registerAssetRoute(app);
      const response = await app.request('/api/v1/assets/items/small/1041.gif');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/gif');
      expect(response.headers.get('cache-control')).toContain('max-age=86400');
      expect(fetchMock).toHaveBeenCalledWith('https://file5s.ratemyserver.net/items/small/1041.gif?lastroweb=v3', expect.objectContaining({
        headers: expect.any(Object),
        cf: { cacheTtl: 0 },
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('proxies map assets and rejects traversal without fetching arbitrary URLs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([71, 73, 70, 56]), { status: 200, headers: { 'content-type': 'image/gif' } }));
    try {
      const app = new Hono();
      registerAssetRoute(app);
      const mapResponse = await app.request('/api/v1/assets/maps_xl/morocc_re.gif');
      expect(mapResponse.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith('https://file5s.ratemyserver.net/maps_xl/morocc_re.gif?lastroweb=v3', expect.objectContaining({ cf: { cacheTtl: 0 } }));
      fetchMock.mockClear();
      const response = await app.request('/api/v1/assets/../secrets.txt');
      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
