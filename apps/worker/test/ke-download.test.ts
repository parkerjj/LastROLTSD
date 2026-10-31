import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerKeDownloadRoutes, resetKeDownloadCacheForTesting } from '../src/routes/ke-download';
import type { AppEnv } from '../src/env';

const MANIFEST_URL = 'https://client.ltsd.ro/ke/standalone/releases.json';

const ANDROID_ENTRY = {
  version: '1.296.261028',
  versionCode: 100000296,
  url: 'releases/1.296.261028/kore-android.apk',
  sha256: '2ba42bbc54d2dc00ee39b5a6a4fbe4e4dec39ca03556ff652a7ed7e9c0d90f12',
  size: 14066137,
  minOs: '8.0',
  abi: 'arm64-v8a',
};

const WINDOWS_ENTRY = {
  version: '1.296.261028',
  url: 'releases/1.296.261028/KoreEngine-Setup-1.296.261028-x64.exe',
  sha256: '9c41e2a0d5f16cc8b0e9a1f4d2a7c3e58b6f0d4179a2c5e8d3b14f6a8c6b7a90',
  size: 40000000,
  minOs: '10',
  abi: 'x64',
};

function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ENVIRONMENT: 'local',
    BUILD_VERSION: 'test',
    MAX_BODY_BYTES: 512 * 1024,
    KE_STANDALONE_MANIFEST_URL: MANIFEST_URL,
    ...overrides,
  } as AppEnv;
}

function manifestResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setupApp(env: AppEnv = makeEnv()): Hono {
  const app = new Hono();
  registerKeDownloadRoutes(app, env);
  return app;
}

describe('KoreEngine standalone download routes', () => {
  it('redirects Android to the absolute package URL from the manifest', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      manifestResponse({ schemaVersion: 1, channel: 'stable', platforms: { android: ANDROID_ENTRY } }),
    );
    try {
      const response = await setupApp().request('/ke/download?platform=android');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        'https://client.ltsd.ro/ke/standalone/releases/1.296.261028/kore-android.apk',
      );
      expect(response.headers.get('cache-control')).toContain('s-maxage=1800');
      expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, expect.objectContaining({ cf: { cacheTtl: 30 } }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('redirects Windows to the installer when the manifest has a windows entry', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(manifestResponse({ schemaVersion: 1, platforms: { windows: WINDOWS_ENTRY } }));
    try {
      const response = await setupApp().request('/ke/download?platform=windows');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        'https://client.ltsd.ro/ke/standalone/releases/1.296.261028/KoreEngine-Setup-1.296.261028-x64.exe',
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('falls back to the page with status=unavailable when the platform is missing', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      manifestResponse({ schemaVersion: 1, platforms: { android: ANDROID_ENTRY } }),
    );
    try {
      const response = await setupApp().request('/ke/download?platform=windows');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/ke/download?status=unavailable&platform=windows');
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects unsupported platforms without fetching the manifest', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await setupApp().request('/ke/download?platform=macos');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/ke/download?status=invalid&platform=macos');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('serves the download page through ASSETS when platform is omitted', async () => {
    resetKeDownloadCacheForTesting();
    const assetsFetch = vi.fn(async () => new Response('<html>download</html>', { status: 200 }));
    const app = setupApp(makeEnv({ ASSETS: { fetch: assetsFetch } as unknown as AppEnv['ASSETS'] }));
    const response = await app.request('/ke/download');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('download');
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  it('returns the sanitized manifest from the API with cache headers', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      manifestResponse({
        schemaVersion: 1,
        channel: 'stable',
        generatedAt: '2026-10-30T12:00:00Z',
        platforms: { android: ANDROID_ENTRY, ios: { version: 'soon', url: '../ios.ipa' } },
      }),
    );
    try {
      const response = await setupApp().request('/api/v1/ke/downloads');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('s-maxage=1800');
      const payload = (await response.json()) as {
        schemaVersion: number;
        channel: string;
        generatedAt: string;
        platforms: Record<string, unknown>;
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.channel).toBe('stable');
      expect(payload.generatedAt).toBe('2026-10-30T12:00:00Z');
      expect(payload.platforms.android).toMatchObject({
        version: '1.296.261028',
        url: 'https://client.ltsd.ro/ke/standalone/releases/1.296.261028/kore-android.apk',
        fileName: 'kore-android.apk',
        sha256: ANDROID_ENTRY.sha256,
        size: ANDROID_ENTRY.size,
        minOs: '8.0',
        abi: 'arm64-v8a',
      });
      // `..` 路径与非 HTTPS 地址会被丢弃。
      expect(payload.platforms.ios).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns 502 from the API and status=error from downloads when the manifest is unavailable', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    try {
      const api = await setupApp().request('/api/v1/ke/downloads');
      expect(api.status).toBe(502);
      expect(api.headers.get('cache-control')).toBe('no-store');

      const redirect = await setupApp().request('/ke/download?platform=android');
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('/ke/download?status=error&platform=android');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('treats an invalid manifest schema as unavailable', async () => {
    resetKeDownloadCacheForTesting();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      manifestResponse({ schemaVersion: 2, platforms: { android: ANDROID_ENTRY } }),
    );
    try {
      const api = await setupApp().request('/api/v1/ke/downloads');
      expect(api.status).toBe(502);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
