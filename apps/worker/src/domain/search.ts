import type { SearchFilters } from '@lastroweb/protocol';

export class SearchValidationError extends Error { constructor(message: string) { super(message); this.name = 'SearchValidationError'; } }
const SORTS = new Set<SearchFilters['sort']>(['price_asc', 'price_desc', 'updated_desc']);
export const DEFAULT_CURSOR_SECRET = 'lastroweb-local-cursor-secret-v1';
const MAX_CURSOR_LENGTH = 512;
export const SEARCH_INDEX_VERSION = 'trigram-short-v1';
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
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array { const output = new Uint8Array(left.length + right.length); output.set(left); output.set(right, left.length); return output; }
function sha256(message: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength); padded.set(message); padded[message.length] = 0x80;
  new DataView(padded.buffer).setUint32(paddedLength - 4, message.length * 8);
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const view = new DataView(padded.buffer, offset, 64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15]!; const w2 = words[index - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index]! + words[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const digest = new Uint8Array(32); const output = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) => output.setUint32(index * 4, value));
  return digest;
}
function hmacSha256(secret: string, value: string): Uint8Array {
  const rawKey = new TextEncoder().encode(secret); const key = rawKey.length > 64 ? new Uint8Array(sha256(rawKey)) : rawKey;
  const block = new Uint8Array(64); block.set(key); const inner = new Uint8Array(64); const outer = new Uint8Array(64);
  for (let index = 0; index < 64; index += 1) { inner[index] = block[index]! ^ 0x36; outer[index] = block[index]! ^ 0x5c; }
  return sha256(joinBytes(outer, sha256(joinBytes(inner, new TextEncoder().encode(value)))));
}
function base64urlBytes(value: Uint8Array): string { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function sign(value: string, secret: string): string { return base64urlBytes(hmacSha256(secret, value)); }
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
  const filters: SearchFilters = { limit, sort, ...(q ? { q, qMode: [...q].length <= 2 ? 'short_token' : 'fts' as const } : {}), ...(options.catalogVersion ? { catalogVersion: options.catalogVersion } : {}), ...(options.optionVersion ? { optionVersion: options.optionVersion } : {}), ...(options.searchIndexVersion ? { searchIndexVersion: options.searchIndexVersion } : {}) };
  const values: Array<[keyof SearchFilters, string]> = [['item_id','item_id'],['option_type','option_type'],['option_value','option_value'],['option_param','option_param'],['price_min','price_min'],['price_max','price_max']];
  for (const [field, query] of values) { const value = number(query); if (value !== undefined) (filters as unknown as Record<string, unknown>)[field] = value; }
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
  const canonical = JSON.stringify({ q: filters.q ?? null, qMode: filters.qMode ?? null, catalogVersion: filters.catalogVersion ?? null, optionVersion: filters.optionVersion ?? null, searchIndexVersion: filters.searchIndexVersion ?? null, item_id: filters.item_id ?? null, option_type: filters.option_type ?? null, option_value: filters.option_value ?? null, option_param: filters.option_param ?? null, options: options.length > 0 ? options : null, option_mode: filters.option_mode ?? 'all', price_min: filters.price_min ?? null, price_max: filters.price_max ?? null, map: filters.map ?? null, shop_type: filters.shop_type ?? null, include_stale: filters.include_stale ?? false, sort: filters.sort });
  return base64urlBytes(sha256(new TextEncoder().encode(canonical)));
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
