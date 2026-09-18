import { describe, expect, it } from 'vitest';
import { withQueryCacheHeaders } from '../src/middleware/cache';

describe('cache policy', () => {
  it('applies route-specific cache controls', () => {
    expect(withQueryCacheHeaders(new Response('x'), 'search').headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    expect(withQueryCacheHeaders(new Response('x'), 'options', '"v1"').headers.get('etag')).toBe('"v1"');
    expect(withQueryCacheHeaders(new Response('x'), 'upload').headers.get('cache-control')).toBe('no-store');
  });
});
