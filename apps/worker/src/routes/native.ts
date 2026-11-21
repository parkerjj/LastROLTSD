import type { Hono } from 'hono';

const NATIVE_MANIFEST_URLS = {
  latest: 'https://client.ltsd.ro/native/latest.json',
  linux: 'https://client.ltsd.ro/native/linux.json',
} as const;

type NativeManifestKind = keyof typeof NATIVE_MANIFEST_URLS;

interface ManifestCacheEntry {
  body: string;
  expiresAt: number;
}

const MANIFEST_CACHE_TTL_MS = 5 * 60_000;
const RESPONSE_CACHE_CONTROL = 'public, max-age=300, s-maxage=1800';
const manifestCache = new Map<NativeManifestKind, ManifestCacheEntry>();

/** 仅供测试：重置内存中的 Native 发布清单缓存。 */
export function resetNativeManifestCacheForTesting(): void {
  manifestCache.clear();
}

async function loadNativeManifest(kind: NativeManifestKind): Promise<string> {
  const cached = manifestCache.get(kind);
  if (cached && cached.expiresAt > Date.now()) return cached.body;

  const response = await fetch(NATIVE_MANIFEST_URLS[kind], { cf: { cacheTtl: 30 } });
  if (!response.ok) throw new Error(`Native manifest unavailable: ${response.status}`);
  const body = JSON.stringify(await response.json());
  manifestCache.set(kind, { body, expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS });
  return body;
}

async function nativeManifestResponse(kind: NativeManifestKind): Promise<Response> {
  try {
    const body = await loadNativeManifest(kind);
    return new Response(body, {
      status: 200,
      headers: {
        'cache-control': RESPONSE_CACHE_CONTROL,
        'content-type': 'application/json; charset=UTF-8',
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Native release manifest unavailable' }), {
      status: 502,
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=UTF-8' },
    });
  }
}

/** 同源转发固定官方清单，避免浏览器直接请求 client.ltsd.ro 时受 CORS 限制。 */
export function registerNativeRoutes(app: Hono<any>): void {
  app.get('/api/v1/native/latest', () => nativeManifestResponse('latest'));
  app.get('/api/v1/native/linux', () => nativeManifestResponse('linux'));
}
