import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';

export function registerOptionsRoute(app: Hono<any>, repo: MarketRepository): void {
  app.get('/api/v1/options', async (c) => { const data = await repo.getOptionDictionary(c.req.query('version')); const etag = `"${btoa(JSON.stringify(data)).slice(0, 32)}"`; if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, max-age=86400' } }); return withQueryCacheHeaders(c.json({ items: data }), 'options', etag); });
}
