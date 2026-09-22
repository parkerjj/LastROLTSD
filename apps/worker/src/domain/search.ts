import type { SearchFilters } from '@lastroweb/protocol';
import { createHash, createHmac } from 'node:crypto';

export class SearchValidationError extends Error { constructor(message: string) { super(message); this.name = 'SearchValidationError'; } }
const SORTS = new Set<SearchFilters['sort']>(['price_asc', 'price_desc', 'changed_desc']);
export const DEFAULT_CURSOR_SECRET = 'lastroweb-local-cursor-secret-v1';
const MAX_CURSOR_LENGTH = 512;
export const SEARCH_INDEX_VERSION = 'active-shop-bounded-v1';
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
function sign(value: string, secret: string): string { return createHmac('sha256', secret).update(value).digest('base64url'); }
function validateSecret(secret: string): string { if (secret.length < 16) throw new SearchValidationError('Invalid cursor secret'); return secret; }
function encodeSigned(payload: Record<string, unknown>, secret: string): string {
  validateSecret(secret);
  const body = base64urlEncode(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}
function decodeSigned(value: string, secret: string): Record<string, unknown> {
  validateSecret(secret);
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]{1,468}\.[A-Za-z0-9_-]{43}$/.test(value)) throw new SearchValidationError('Invalid cursor');
  const separator = value.lastIndexOf('.'); const body = value.slice(0, separator); const signature = value.slice(separator + 1);
  const expected = sign(body, secret);
  if (!constantTimeEqual(expected, signature)) throw new SearchValidationError('Invalid cursor');
  try { const parsed = JSON.parse(base64urlDecode(body)) as Record<string, unknown>; if (!parsed || typeof parsed !== 'object') throw new Error(); return parsed; }
  catch { throw new SearchValidationError('Invalid cursor'); }
}
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function parseSearchParams(url: URL, options: { cursorSecret?: string; verifyCursor?: boolean; catalogVersion?: string; optionVersion?: string; searchIndexVersion?: string } = {}): SearchFilters {
  const number = (name: string): number | undefined => {
    const raw = url.searchParams.get(name); if (raw === null || raw === '') return undefined;
    if (!/^-?\d+$/.test(raw)) throw new SearchValidationError(`Invalid ${name}`);
    const parsed = Number(raw); if (!Number.isSafeInteger(parsed)) throw new SearchValidationError(`Invalid ${name}`); return parsed;
  };
  const rawLimit = number('limit'); const limit = rawLimit === undefined ? 20 : Math.min(50, Math.max(1, rawLimit));
  const sort = (url.searchParams.get('sort') ?? 'price_asc') as SearchFilters['sort']; if (!SORTS.has(sort)) throw new SearchValidationError('Invalid sort');
  const q = url.searchParams.get('q')?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() || undefined;
  if (q && [...q].length > 80) throw new SearchValidationError('q is too long');
  const filters: SearchFilters = { limit, sort, ...(q ? { q } : {}), ...(options.catalogVersion ? { catalogVersion: options.catalogVersion } : {}), ...(options.optionVersion ? { optionVersion: options.optionVersion } : {}), ...(options.searchIndexVersion ? { searchIndexVersion: options.searchIndexVersion } : {}) };
  const values: Array<[keyof SearchFilters, string]> = [['item_id','item_id'],['option_type','option_type'],['option_value','option_value'],['option_param','option_param'],['price_min','price_min'],['price_max','price_max']];
  for (const [field, query] of values) { const value = number(query); if (value !== undefined) (filters as unknown as Record<string, unknown>)[field] = value; }
  const rawItemIds = url.searchParams.get('item_ids');
  if (rawItemIds) { const ids = rawItemIds.split(',').map((value) => Number(value)); if (ids.length > 50 || ids.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new SearchValidationError('Invalid item_ids'); (filters as any).item_ids = [...new Set(ids)]; }
  const map = url.searchParams.get('map')?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); if (map) filters.map = [...map].slice(0, 80).join('');
  const shopType = url.searchParams.get('shop_type'); if (shopType && shopType !== 'buy' && shopType !== 'sell') throw new SearchValidationError('Invalid shop_type'); if (shopType === 'buy' || shopType === 'sell') filters.shop_type = shopType;
  const includeStale = url.searchParams.get('include_stale'); if (includeStale !== null) { if (includeStale !== 'true' && includeStale !== 'false') throw new SearchValidationError('Invalid include_stale'); filters.include_stale = includeStale === 'true'; }
  const optionTokens = url.searchParams.getAll('option');
  if (optionTokens.length > 0 && (filters.option_type !== undefined || filters.option_value !== undefined || filters.option_param !== undefined)) throw new SearchValidationError('Cannot mix legacy and structured options');
  if (optionTokens.length > 0) {
    if (optionTokens.length > 8) throw new SearchValidationError('Too many option filters');
    const options = optionTokens.map((token) => {
      const parts = token.split(':');
      if ((parts.length !== 3 && parts.length !== 4) || !/^\d+$/u.test(parts[0] ?? '') || !Number.isSafeInteger(Number(parts[0]))) throw new SearchValidationError('Invalid option');
      if (parts[3] !== undefined && (!/^-?\d+$/u.test(parts[3]) || !Number.isSafeInteger(Number(parts[3])))) throw new SearchValidationError('Invalid option');
      return { type: Number(parts[0]), operator: parts[1]!, value: parts[2]!, ...(parts[3] === undefined ? {} : { param: Number(parts[3]) }) };
    });
    const mode = url.searchParams.get('option_mode') ?? 'all';
    if (mode !== 'all' && mode !== 'any') throw new SearchValidationError('Invalid option_mode');
    filters.options = options;
    filters.option_mode = mode;
  }
  const legacyParts = [filters.option_type, filters.option_value, filters.option_param];
  if (legacyParts.some((value) => value !== undefined) && !legacyParts.every((value) => value !== undefined)) throw new SearchValidationError('Incomplete legacy option filter');
  const cursor = url.searchParams.get('cursor'); if (cursor) { if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(cursor)) throw new SearchValidationError('Invalid cursor'); filters.cursor = cursor; }
  if (filters.price_min !== undefined && filters.price_max !== undefined && filters.price_min > filters.price_max) throw new SearchValidationError('Invalid price range');
  if (cursor && options.verifyCursor !== false) decodeCursor(cursor, { sort, context: searchCursorContext(filters) }, options.cursorSecret);
  return filters;
}

export function encodeCursor(value: { sort: SearchSort; sortValue: number; id: number; context?: string }, secret = DEFAULT_CURSOR_SECRET): string {
  if (!SORTS.has(value.sort) || !Number.isSafeInteger(value.sortValue) || !Number.isSafeInteger(value.id) || value.id <= 0) throw new SearchValidationError('Invalid cursor');
  return encodeSigned({ version: 1, kind: 'search', sort: value.sort, sortValue: value.sortValue, id: value.id, ...(value.context === undefined ? {} : { context: value.context }) }, secret);
}
export function decodeCursor(value: string, expected?: CursorExpectation, secret = DEFAULT_CURSOR_SECRET): { sort: SearchSort; sortValue: number; id: number; context?: string } {
  const parsed = decodeSigned(value, secret);
  if (parsed.version !== 1 || parsed.kind !== 'search' || typeof parsed.sort !== 'string' || !SORTS.has(parsed.sort as SearchSort) || !Number.isSafeInteger(parsed.sortValue) || !Number.isSafeInteger(parsed.id) || Number(parsed.id) <= 0 || (parsed.context !== undefined && typeof parsed.context !== 'string')) throw new SearchValidationError('Invalid cursor');
  if (expected?.sort !== undefined && parsed.sort !== expected.sort) throw new SearchValidationError('Invalid cursor sort');
  if (expected?.context !== undefined && parsed.context !== expected.context) throw new SearchValidationError('Invalid cursor');
  return { sort: parsed.sort as SearchSort, sortValue: Number(parsed.sortValue), id: Number(parsed.id), ...(parsed.context === undefined ? {} : { context: String(parsed.context) }) };
}

export function searchCursorContext(filters: SearchFilters): string {
  const options = [...(filters.options ?? [])].sort((left, right) => left.type - right.type || left.operator.localeCompare(right.operator) || left.value.localeCompare(right.value) || (left.param ?? Number.MIN_SAFE_INTEGER) - (right.param ?? Number.MIN_SAFE_INTEGER));
  const itemIds = [...new Set([...(filters.item_ids ?? [])].filter((id) => Number.isSafeInteger(id)))].sort((left, right) => left - right);
  const canonical = JSON.stringify({ q: filters.q ?? null, catalogVersion: filters.catalogVersion ?? null, optionVersion: filters.optionVersion ?? null, searchIndexVersion: filters.searchIndexVersion ?? null, item_id: filters.item_id ?? null, item_ids: itemIds.length > 0 ? itemIds : null, option_type: filters.option_type ?? null, option_value: filters.option_value ?? null, option_param: filters.option_param ?? null, options: options.length > 0 ? options : null, option_mode: filters.option_mode ?? 'all', price_min: filters.price_min ?? null, price_max: filters.price_max ?? null, map: filters.map ?? null, shop_type: filters.shop_type ?? null, include_stale: filters.include_stale ?? false, sort: filters.sort });
  return createHash('sha256').update(canonical).digest('base64url');
}
export function encodeHistoryCursor(id: number, secret = DEFAULT_CURSOR_SECRET): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new SearchValidationError('Invalid cursor');
  return encodeSigned({ version: 1, kind: 'history', id }, secret);
}
export function decodeHistoryCursor(value: string, secret = DEFAULT_CURSOR_SECRET): number {
  if (value.length > 128) throw new SearchValidationError('Invalid cursor');
  const parsed = decodeSigned(value, secret);
  if (parsed.version !== 1 || parsed.kind !== 'history' || !Number.isSafeInteger(parsed.id) || Number(parsed.id) <= 0) throw new SearchValidationError('Invalid cursor');
  return Number(parsed.id);
}
