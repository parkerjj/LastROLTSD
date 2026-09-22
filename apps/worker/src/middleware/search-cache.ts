import { createHmac } from 'node:crypto';
import type { AppEnv } from '../env';
import { DEFAULT_CURSOR_SECRET, SEARCH_INDEX_VERSION } from '../domain/search';
import { OPTION_DEFINITIONS_VERSION } from '../domain/option-definitions';

const TTL_MS = 30_000;
const STORED_AT = 'x-lastro-search-stored-at';
// Bump when the response contract changes. Releases/DBs/keys also isolate entries.
const CACHE_VERSION = 'search-response-v1';
let lastNamespace: { identity: string; secret: string; value: string } | undefined;

function cacheKey(url: URL, env: AppEnv): Request {
  const identity = JSON.stringify([CACHE_VERSION, env.ENVIRONMENT, env.BUILD_VERSION, env.MYSQL_URL, SEARCH_INDEX_VERSION, OPTION_DEFINITIONS_VERSION]);
  const secret = env.CURSOR_SECRET ?? DEFAULT_CURSOR_SECRET;
  if (lastNamespace?.identity !== identity || lastNamespace.secret !== secret) {
    lastNamespace = { identity, secret, value: createHmac('sha256', secret).update(identity).digest('hex') };
  }
  const key = new URL(url);
  key.pathname = `/__search_cache/${lastNamespace.value}${url.pathname}`;
  return new Request(key);
}

export async function withSearchCache(request: Request, url: URL, env: AppEnv, load: () => Promise<Response>, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  // Public search ignores cookies, including analytics cookies; never vary results by them.
  const bypass = request.headers.has('authorization') || request.headers.has('range')
    || /(?:no-cache|no-store|max-age\s*=\s*0)/i.test(request.headers.get('cache-control') ?? '')
    || request.headers.get('pragma')?.toLowerCase() === 'no-cache';
  const cache = !bypass && typeof caches !== 'undefined' ? (caches as CacheStorage & { default: Cache }).default : undefined;
  if (!cache) {
    const response = await load();
    response.headers.set('x-search-cache', 'BYPASS');
    return response;
  }
  const key = cacheKey(url, env);
  try {
    const cached = await cache.match(key);
    if (cached) {
      const storedAt = Number(cached.headers.get(STORED_AT));
      const age = Date.now() - storedAt;
      if (storedAt > 0 && age >= 0 && age < TTL_MS) {
        const response = new Response(cached.body, cached);
        response.headers.delete(STORED_AT);
        response.headers.delete('age');
        response.headers.delete('date');
        const remaining = Math.floor((TTL_MS - age) / 1000);
        response.headers.set('cache-control', `public, max-age=${remaining}, s-maxage=${remaining}`);
        response.headers.set('x-search-cache', 'HIT');
        return response;
      }
      await cached.body?.cancel();
    }
  } catch { /* Cache availability must not determine search availability. */ }

  const response = await load();
  if (response.status === 200 && !response.headers.has('set-cookie')) {
    const stored = response.clone();
    stored.headers.delete('x-request-id');
    stored.headers.set(STORED_AT, String(Date.now()));
    const write = cache.put(key, stored).catch(() => undefined);
    if (context) context.waitUntil(write);
    else await write;
  }
  response.headers.set('x-search-cache', 'MISS');
  return response;
}
