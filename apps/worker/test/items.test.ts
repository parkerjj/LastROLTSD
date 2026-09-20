import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerItemsRoute } from '../src/routes/items';

describe('item catalog endpoint', () => {
  it('returns versioned catalog matches with ETag and a 24-hour cache', async () => {
    const app = new Hono();
    registerItemsRoute(app, {
      getCatalogVersion: async () => 'catalog-2026-09-19',
      searchItems: async (query: string, limit: number) => {
        expect(query).toBe('测试剑');
        expect(limit).toBe(20);
        return [{ itemId: 1234, name: '测试剑', aliases: ['试剑'] }];
      },
    } as never);

    const response = await app.request('/api/v1/items?q=%E6%B5%8B%E8%AF%95%E5%89%91');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(response.headers.get('etag')).toBeTruthy();
    expect(await response.json()).toEqual({
      version: 'catalog-2026-09-19',
      items: [{ itemId: 1234, name: '测试剑', aliases: ['试剑'] }],
    });
  });

  it('returns 304 for a matching ETag and clamps the default limit', async () => {
    const repo = {
      getCatalogVersion: async () => 'v1',
      searchItems: async (_query: string, limit: number) => {
        expect(limit).toBe(20);
        return [];
      },
    };
    const app = new Hono();
    registerItemsRoute(app, repo as never);

    const first = await app.request('/api/v1/items?q=x&limit=999');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await app.request('/api/v1/items?q=x&limit=999', { headers: { 'If-None-Match': etag! } });
    expect(second.status).toBe(304);
    expect(second.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('rejects an invalid limit without reading the catalog', async () => {
    const app = new Hono();
    let reads = 0;
    registerItemsRoute(app, {
      getCatalogVersion: async () => { reads += 1; return 'v1'; },
      searchItems: async () => [],
    } as never);

    const response = await app.request('/api/v1/items?limit=0');
    expect(response.status).toBe(400);
    expect(reads).toBe(0);
  });
});
