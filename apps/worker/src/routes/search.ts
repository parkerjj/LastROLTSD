import type { Hono } from 'hono';
import { parseSearchParams, SearchValidationError, SEARCH_INDEX_VERSION } from '../domain/search';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';

// Optional legacy resolver. Production resolves item names inside MySQL.
export type CatalogItemResolver = (query: string) => Promise<number[]>;

export function registerSearchRoute(app: Hono<any>, repo: MarketRepository, cursorSecret?: string, resolveItemIds?: CatalogItemResolver): void {
  app.get('/api/v1/market/search', (c) => searchResponse(c.req.raw, repo, cursorSecret, true, resolveItemIds));
}

export async function searchResponse(request: Request, repo: MarketRepository, cursorSecret?: string, verifyCursor = true, resolveItemIds?: CatalogItemResolver): Promise<Response> {
  try {
    const [catalogVersion, definitions] = await Promise.all([repo.getCatalogVersion(), repo.getOptionDefinitions()]);
    const url = new URL(request.url);
    const rawScope = url.searchParams.get('q_scope');
    const rawQuery = url.searchParams.get('q');
    const rawScopes = rawScope ? rawScope.split(',').map((value) => value.trim()).filter(Boolean) : [];
    // 物品名→ID 解析：all 或开启 item 范围时执行（规则与 web 端图鉴一致）；纯 shop/vendor 无需解析。
    const resolvesItems = rawQuery && (rawScopes.length === 0 || rawScopes.includes('all') || rawScopes.includes('item'));
    const resolvedItemIds = resolvesItems && resolveItemIds ? await resolveItemIds(rawQuery!) : undefined;
    const filters = parseSearchParams(url, { ...(cursorSecret === undefined ? {} : { cursorSecret }), verifyCursor, catalogVersion, optionVersion: definitions.version, searchIndexVersion: SEARCH_INDEX_VERSION, ...(resolvedItemIds?.length ? { resolvedItemIds } : {}) });
    // Only a supplied resolver can confirm an empty catalog match; production uses SQL.
    if (resolveItemIds && filters.q && filters.q_scope?.length === 1 && filters.q_scope[0] === 'item' && filters.item_id === undefined && !(filters.item_ids?.length)) {
      return withQueryCacheHeaders(Response.json({ items: [], nextCursor: null }), 'search');
    }
    const page = await repo.searchListings(filters);
    return withQueryCacheHeaders(Response.json(page), 'search');
  }
  catch (error) { if (error instanceof SearchValidationError) return Response.json({ error: { code: 'bad_request', message: error.message, request_id: request.headers.get('cf-ray') ?? crypto.randomUUID() } }, { status: 400 }); throw error; }
}
