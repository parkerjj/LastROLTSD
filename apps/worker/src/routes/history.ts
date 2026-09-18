import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';

export function registerHistoryRoute(app: Hono, repo: MarketRepository): void {
  app.get('/api/v1/market/listings/:id/history', async (c) => { const id = Number(c.req.param('id')); const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20))); if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: { code: 'not_found', message: 'Listing not found', request_id: crypto.randomUUID() } }, 404); const page = await repo.getListingHistory(id, Number.isFinite(limit) ? limit : 20, c.req.query('cursor')); return c.json(page, 200, { 'cache-control': 'public, max-age=30, s-maxage=30' }); });
}
