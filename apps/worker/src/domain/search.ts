import type { SearchFilters } from '@lastroweb/protocol';

export class SearchValidationError extends Error { constructor(message: string) { super(message); this.name = 'SearchValidationError'; } }
const SORTS = new Set<SearchFilters['sort']>(['price_asc', 'price_desc', 'updated_desc']);

export function parseSearchParams(url: URL): SearchFilters {
  const number = (name: string): number | undefined => {
    const raw = url.searchParams.get(name); if (raw === null || raw === '') return undefined;
    if (!/^-?\d+$/.test(raw)) throw new SearchValidationError(`Invalid ${name}`);
    const parsed = Number(raw); if (!Number.isSafeInteger(parsed)) throw new SearchValidationError(`Invalid ${name}`); return parsed;
  };
  const rawLimit = number('limit'); const limit = rawLimit === undefined ? 20 : Math.min(50, Math.max(1, rawLimit));
  const sort = (url.searchParams.get('sort') ?? 'price_asc') as SearchFilters['sort']; if (!SORTS.has(sort)) throw new SearchValidationError('Invalid sort');
  const q = url.searchParams.get('q')?.trim() || undefined; if (q && q.length > 80) throw new SearchValidationError('q is too long');
  const filters: SearchFilters = { limit, sort, ...(q ? { q } : {}) };
  const values: Array<[keyof SearchFilters, string]> = [['item_id','item_id'],['option_type','option_type'],['option_value','option_value'],['option_param','option_param'],['price_min','price_min'],['price_max','price_max']];
  for (const [field, query] of values) { const value = number(query); if (value !== undefined) (filters as unknown as Record<string, unknown>)[field] = value; }
  const map = url.searchParams.get('map')?.trim(); if (map) filters.map = map.slice(0, 80);
  const shopType = url.searchParams.get('shop_type'); if (shopType && shopType !== 'buy' && shopType !== 'sell') throw new SearchValidationError('Invalid shop_type'); if (shopType === 'buy' || shopType === 'sell') filters.shop_type = shopType;
  const includeStale = url.searchParams.get('include_stale'); if (includeStale !== null) { if (includeStale !== 'true' && includeStale !== 'false') throw new SearchValidationError('Invalid include_stale'); filters.include_stale = includeStale === 'true'; }
  const cursor = url.searchParams.get('cursor'); if (cursor) { if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new SearchValidationError('Invalid cursor'); filters.cursor = cursor; }
  if (filters.price_min !== undefined && filters.price_max !== undefined && filters.price_min > filters.price_max) throw new SearchValidationError('Invalid price range');
  return filters;
}

export function encodeCursor(value: { sortValue: number; id: number }): string { return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
export function decodeCursor(value: string): { sortValue: number; id: number } { try { const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')); const parsed = JSON.parse(raw) as { sortValue: number; id: number }; if (!Number.isSafeInteger(parsed.sortValue) || !Number.isSafeInteger(parsed.id)) throw new Error(); return parsed; } catch { throw new SearchValidationError('Invalid cursor'); } }
