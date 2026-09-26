import type { Hono } from 'hono';
import { requestId } from '../middleware/errors';
import { logError } from '../observability';

const UPSTREAM_URL = 'https://game.lastro.cn/?r=pc/news&nid=5';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=3600';
const CORS_HEADERS = { 'access-control-allow-origin': '*' } as const;
const NO_STORE_HEADERS = { 'cache-control': 'no-store', ...CORS_HEADERS } as const;

function collectSetCookies(headers: Headers, jar: Map<string, string>): void {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const entries = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [headers.get('set-cookie')].filter((value): value is string => Boolean(value));
  for (const entry of entries) {
    const pair = entry.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function extractCsrfToken(html: string, jar: Map<string, string>): string | null {
  const meta =
    /<meta\b[^>]*\bname=["']csrf-token["'][^>]*\bcontent=["']([^"']+)["']/i.exec(html) ??
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']csrf-token["']/i.exec(html);
  if (meta?.[1]) return meta[1];
  const input =
    /<input\b[^>]*\bname=["']_csrf["'][^>]*\bvalue=["']([^"']+)["']/i.exec(html) ??
    /<input\b[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']_csrf["']/i.exec(html);
  if (input?.[1]) return input[1];
  return jar.get('_csrf') ?? null;
}

async function fetchCsrfToken(): Promise<string | null> {
  const jar = new Map<string, string>();
  let url = UPSTREAM_URL;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
    collectSetCookies(response.headers, jar);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) return null;
    return extractCsrfToken(await response.text(), jar);
  }
  return null;
}

export function registerMakingCookieRoute(app: Hono<any>): void {
  // Cross-origin scripts may add custom headers; answer their preflight.
  app.options('/making-cookie', () => new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
      'cache-control': CACHE_CONTROL,
    },
  }));
  app.get('/making-cookie', async (c) => {
    const id = requestId(c.req.raw);
    try {
      const token = await fetchCsrfToken();
      if (!token) {
        logError('lastroweb.making_cookie_token_missing', new Error('csrf token not found in upstream response'), { request_id: id });
        return new Response(null, { status: 502, headers: NO_STORE_HEADERS });
      }
      return new Response(token, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': CACHE_CONTROL, ...CORS_HEADERS },
      });
    } catch (error) {
      logError('lastroweb.making_cookie_error', error, { request_id: id });
      return new Response(null, { status: 502, headers: NO_STORE_HEADERS });
    }
  });
}
