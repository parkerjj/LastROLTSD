import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';

type CatalogRepository = Pick<MarketRepository, 'getCatalogVersion' | 'searchItems'>;

export function registerItemsRoute(app: Hono<any>, repo: CatalogRepository): void {
  app.get('/api/v1/items', async (c) => {
    const rawQuery = c.req.query('q') ?? '';
    const query = rawQuery.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if ([...query].length > 80) return c.json({ error: { code: 'bad_request', message: 'q is too long' } }, 400);

    const rawLimit = c.req.query('limit');
    const parsedLimit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) return c.json({ error: { code: 'bad_request', message: 'limit must be at least 1' } }, 400);
    const limit = Math.min(20, parsedLimit);
    const version = await repo.getCatalogVersion();
    const items = query ? await repo.searchItems(query, limit) : [];
    const body = { version, items };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
    const etag = '"' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32) + '"';
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, max-age=86400' } });
    return withQueryCacheHeaders(c.json(body), 'catalog', etag);
  });
}
