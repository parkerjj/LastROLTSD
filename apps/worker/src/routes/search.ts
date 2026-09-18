import type { Hono } from 'hono';
import { parseSearchParams, SearchValidationError } from '../domain/search';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';

export function registerSearchRoute(app: Hono<any>, repo: MarketRepository, cursorSecret?: string): void {
  app.get('/api/v1/market/search', async (c) => {
    try { const page = await repo.searchListings(parseSearchParams(new URL(c.req.url), cursorSecret === undefined ? {} : { cursorSecret })); return withQueryCacheHeaders(c.json(page), 'search'); }
    catch (error) { if (error instanceof SearchValidationError) return c.json({ error: { code: 'bad_request', message: error.message, request_id: c.req.header('cf-ray') ?? crypto.randomUUID() } }, 400); throw error; }
  });
}
