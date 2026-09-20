import type { Hono } from 'hono';
import { parseSearchParams, SearchValidationError, SEARCH_INDEX_VERSION } from '../domain/search';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';

export function registerSearchRoute(app: Hono<any>, repo: MarketRepository, cursorSecret?: string): void {
  app.get('/api/v1/market/search', async (c) => {
    try {
      const [catalogVersion, definitions] = await Promise.all([repo.getCatalogVersion(), repo.getOptionDefinitions()]);
      const filters = parseSearchParams(new URL(c.req.url), { cursorSecret, catalogVersion, optionVersion: definitions.version, searchIndexVersion: SEARCH_INDEX_VERSION });
      const page = await repo.searchListings(filters);
      return withQueryCacheHeaders(c.json(page), 'search');
    }
    catch (error) { if (error instanceof SearchValidationError) return c.json({ error: { code: 'bad_request', message: error.message, request_id: c.req.header('cf-ray') ?? crypto.randomUUID() } }, 400); throw error; }
  });
}
