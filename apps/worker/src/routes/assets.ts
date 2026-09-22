import type { Hono } from 'hono';

const RMS_ORIGIN = 'https://file5s.ratemyserver.net';
const ASSET_PREFIX = '/api/v1/assets/';
const RMS_CACHE_BUSTER = 'v3';

function safeAssetPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const normalized = decoded.replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.includes('..') || normalized.includes('\\') || normalized.includes('//')) return null;
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(normalized)) return null;
  return normalized;
}

export function registerAssetRoute(app: Hono<any>): void {
  app.get('/api/v1/assets/*', async (c) => {
    const assetPath = safeAssetPath(c.req.path.slice(ASSET_PREFIX.length));
    if (!assetPath) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });

    try {
      const upstream = await fetch(`${RMS_ORIGIN}/${assetPath}?lastroweb=${RMS_CACHE_BUSTER}`, {
        cf: { cacheTtl: 0 },
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          referer: 'https://ratemyserver.net/',
          'user-agent': 'LastROWeb/1.0 (+https://lastro.cn/)',
        },
      });
      if (!upstream.ok || !upstream.body) return new Response(null, { status: upstream.status === 404 ? 404 : 502, headers: { 'cache-control': 'no-store' } });

      const headers = new Headers();
      headers.set('cache-control', 'public, max-age=86400, s-maxage=604800');
      headers.set('content-type', upstream.headers.get('content-type') || 'image/gif');
      headers.set('x-content-type-options', 'nosniff');
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  });
}
