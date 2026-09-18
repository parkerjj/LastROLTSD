import type { SearchFilters } from '@lastroweb/protocol';

export class SearchValidationError extends Error { constructor(message: string) { super(message); this.name = 'SearchValidationError'; } }
const SORTS = new Set<SearchFilters['sort']>(['price_asc', 'price_desc', 'updated_desc']);
const CURSOR_SECRET = 'lastroweb-cursor-v1';
const MAX_CURSOR_LENGTH = 512;
type SearchSort = SearchFilters['sort'];
export interface CursorExpectation { sort?: SearchSort; context?: string }

function base64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64urlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SearchValidationError('Invalid cursor');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
function sign(value: string): string {
  let left = 2166136261; let right = 2654435761;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619) >>> 0;
    right = Math.imul(right ^ (code + index), 2246822519) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}
function encodeSigned(payload: Record<string, unknown>): string {
  const body = base64urlEncode(JSON.stringify(payload));
  return `${body}.${sign(`${CURSOR_SECRET}:${body}`)}`;
}
function decodeSigned(value: string): Record<string, unknown> {
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]{1,480}\.[0-9a-f]{16}$/.test(value)) throw new SearchValidationError('Invalid cursor');
  const separator = value.lastIndexOf('.'); const body = value.slice(0, separator); const signature = value.slice(separator + 1);
  if (sign(`${CURSOR_SECRET}:${body}`) !== signature) throw new SearchValidationError('Invalid cursor');
  try { const parsed = JSON.parse(base64urlDecode(body)) as Record<string, unknown>; if (!parsed || typeof parsed !== 'object') throw new Error(); return parsed; }
  catch { throw new SearchValidationError('Invalid cursor'); }
}

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
  const cursor = url.searchParams.get('cursor'); if (cursor) { if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(cursor)) throw new SearchValidationError('Invalid cursor'); filters.cursor = cursor; }
  if (filters.price_min !== undefined && filters.price_max !== undefined && filters.price_min > filters.price_max) throw new SearchValidationError('Invalid price range');
  return filters;
}

export function encodeCursor(value: { sort: SearchSort; sortValue: number; id: number; context?: string }): string {
  if (!SORTS.has(value.sort) || !Number.isSafeInteger(value.sortValue) || !Number.isSafeInteger(value.id) || value.id <= 0) throw new SearchValidationError('Invalid cursor');
  return encodeSigned({ version: 1, kind: 'search', sort: value.sort, sortValue: value.sortValue, id: value.id, ...(value.context === undefined ? {} : { context: value.context }) });
}
export function decodeCursor(value: string, expected?: CursorExpectation): { sort: SearchSort; sortValue: number; id: number; context?: string } {
  const parsed = decodeSigned(value);
  if (parsed.version !== 1 || parsed.kind !== 'search' || typeof parsed.sort !== 'string' || !SORTS.has(parsed.sort as SearchSort) || !Number.isSafeInteger(parsed.sortValue) || !Number.isSafeInteger(parsed.id) || Number(parsed.id) <= 0 || (parsed.context !== undefined && typeof parsed.context !== 'string')) throw new SearchValidationError('Invalid cursor');
  if (expected?.sort !== undefined && parsed.sort !== expected.sort) throw new SearchValidationError('Invalid cursor sort');
  if (expected?.context !== undefined && parsed.context !== expected.context) throw new SearchValidationError('Invalid cursor');
  return { sort: parsed.sort as SearchSort, sortValue: Number(parsed.sortValue), id: Number(parsed.id), ...(parsed.context === undefined ? {} : { context: String(parsed.context) }) };
}

export function searchCursorContext(filters: SearchFilters): string {
  return JSON.stringify({ q: filters.q ?? null, item_id: filters.item_id ?? null, option_type: filters.option_type ?? null, option_value: filters.option_value ?? null, option_param: filters.option_param ?? null, price_min: filters.price_min ?? null, price_max: filters.price_max ?? null, map: filters.map ?? null, shop_type: filters.shop_type ?? null, include_stale: filters.include_stale ?? false, sort: filters.sort });
}
export function encodeHistoryCursor(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new SearchValidationError('Invalid cursor');
  return encodeSigned({ version: 1, kind: 'history', id });
}
export function decodeHistoryCursor(value: string): number {
  if (value.length > 128) throw new SearchValidationError('Invalid cursor');
  const parsed = decodeSigned(value);
  if (parsed.version !== 1 || parsed.kind !== 'history' || !Number.isSafeInteger(parsed.id) || Number(parsed.id) <= 0) throw new SearchValidationError('Invalid cursor');
  return Number(parsed.id);
}
