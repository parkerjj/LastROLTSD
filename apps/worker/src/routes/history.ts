import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';
import { decodeHistoryCursor, SearchValidationError } from '../domain/search';

export function registerHistoryRoute(app: Hono<any>, repo: MarketRepository, cursorSecret?: string): void {
  app.get('/api/v1/market/listings/:id/history', async (c) => {
    const id = Number(c.req.param('id'));
    const cursor = c.req.query('cursor');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: { code: 'not_found', message: 'Listing not found', request_id: requestId } }, 404);
    if (!Number.isSafeInteger(limit) || limit < 1) return c.json({ error: { code: 'bad_request', message: 'Invalid history limit', request_id: requestId } }, 400);
    try {
      if (cursor !== undefined) decodeHistoryCursor(cursor, cursorSecret);
      const page = await repo.getListingHistory(id, Math.min(50, limit), cursor);
      if (!page) return c.json({ error: { code: 'not_found', message: 'Listing not found', request_id: requestId } }, 404);
      return c.json(page, 200, { 'cache-control': 'public, max-age=30, s-maxage=30' });
    } catch (error) {
      if (error instanceof SearchValidationError) return c.json({ error: { code: 'bad_request', message: error.message, request_id: requestId } }, 400);
      throw error;
    }
  });
}
