import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerIwaRoutes, resetIwaManifestCacheForTesting } from '../src/routes/iwa';
import type { AppEnv } from '../src/env';

const MANIFEST_URL = 'https://client.ltsd.ro/updates.json';

function makeEnv(manifestUrl: string | undefined): AppEnv {
  return {
    ENVIRONMENT: 'local',
    BUILD_VERSION: 'test',
    MAX_BODY_BYTES: 512 * 1024,
    IWA_UPDATES_MANIFEST_URL: manifestUrl,
  } as AppEnv;
}

function manifestResponse(versions: Array<{ version: string; src: string; channels?: string[] }>): Response {
  return new Response(JSON.stringify({ versions, channels: { default: { name: 'Stable' } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('IWA release routes', () => {
  it('redirects /latest to the highest version in the default channel', async () => {
    resetIwaManifestCacheForTesting();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(manifestResponse([
        { version: '0.1.101', src: 'https://client.ltsd.ro/releases/0.1.101/lastro-v2-aaa.swbn', channels: ['default'] },
        { version: '0.1.100', src: 'https://client.ltsd.ro/releases/0.1.100/lastro-v2-bbb.swbn', channels: ['default'] },
        { version: '0.1.102', src: 'https://client.ltsd.ro/releases/0.1.102/lastro-v2-ccc.swbn', channels: ['beta'] },
      ]));
    try {
      const app = new Hono();
      registerIwaRoutes(app, makeEnv(MANIFEST_URL));
      const response = await app.request('/api/v1/iwa/latest');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://client.ltsd.ro/releases/0.1.101/lastro-v2-aaa.swbn');
      expect(response.headers.get('cache-control')).toContain('s-maxage=1800');
      expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, expect.objectContaining({ cf: { cacheTtl: 30 } }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns version and src from /info as cacheable JSON', async () => {
    resetIwaManifestCacheForTesting();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(manifestResponse([
        { version: '0.1.101', src: 'https://client.ltsd.ro/releases/0.1.101/lastro-v2-aaa.swbn', channels: ['default'] },
      ]));
    try {
      const app = new Hono();
      registerIwaRoutes(app, makeEnv(MANIFEST_URL));
      const response = await app.request('/api/v1/iwa/info');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toContain('s-maxage=1800');
      await expect(response.json()).resolves.toEqual({
        version: '0.1.101',
        src: 'https://client.ltsd.ro/releases/0.1.101/lastro-v2-aaa.swbn',
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns 404 when no default-channel release exists', async () => {
    resetIwaManifestCacheForTesting();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(manifestResponse([
        { version: '0.1.102', src: 'https://client.ltsd.ro/releases/0.1.102/lastro-v2-ccc.swbn', channels: ['beta'] },
      ]));
    try {
      const app = new Hono();
      registerIwaRoutes(app, makeEnv(MANIFEST_URL));
      const response = await app.request('/api/v1/iwa/latest');
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns 502 when the update manifest cannot be fetched', async () => {
    resetIwaManifestCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    try {
      const app = new Hono();
      registerIwaRoutes(app, makeEnv(MANIFEST_URL));
      const response = await app.request('/api/v1/iwa/latest');
      expect(response.status).toBe(502);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns 404 when the manifest URL is not configured', async () => {
    resetIwaManifestCacheForTesting();
    const app = new Hono();
    registerIwaRoutes(app, makeEnv(undefined));
    const response = await app.request('/api/v1/iwa/latest');
    expect(response.status).toBe(404);
  });
});
