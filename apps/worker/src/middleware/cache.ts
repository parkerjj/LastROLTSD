export type CacheKind = 'search' | 'options' | 'catalog' | 'upload' | 'uncached';
export function withQueryCacheHeaders(response: Response, kind: CacheKind, etag?: string): Response {
  const headers = new Headers(response.headers);
  if (kind === 'search') headers.set('cache-control', 'public, max-age=30, s-maxage=30');
  else if (kind === 'options' || kind === 'catalog') { headers.set('cache-control', 'public, max-age=86400'); if (etag) headers.set('etag', etag); }
  else headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
