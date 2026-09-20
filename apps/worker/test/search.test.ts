import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { decodeCursor, encodeCursor, parseSearchParams, SearchValidationError, searchCursorContext } from '../src/domain/search';
import { registerSearchRoute } from '../src/routes/search';
import type { SearchFilters } from '@lastroweb/protocol';

describe('search filters', () => {
  it('parses bounded filters and a stable cursor', () => { const filters = parseSearchParams(new URL('https://x.test/api?q=sword&limit=99&price_min=10&price_max=20&sort=price_desc')); expect(filters.limit).toBe(50); expect(filters.q).toBe('sword'); const cursor = encodeCursor({ sort: 'price_desc', sortValue: 20, id: 4 }); expect(decodeCursor(cursor)).toEqual({ sort: 'price_desc', sortValue: 20, id: 4 }); });
  it('rejects unallowlisted sort and malformed ranges', () => { expect(() => parseSearchParams(new URL('https://x.test?sort=price'))).toThrow(); expect(() => parseSearchParams(new URL('https://x.test?price_min=20&price_max=10'))).toThrow(); });
  it('rejects a tampered or cross-sort cursor', () => {
    const cursor = encodeCursor({ sort: 'price_asc', sortValue: 20, id: 4 });
    expect(() => decodeCursor(`${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`)).toThrow('Invalid cursor');
    expect(() => parseSearchParams(new URL(`https://x.test?sort=price_desc&cursor=${cursor}`))).toThrow('Invalid cursor');
  });
  it('rejects an unsigned or context-mismatched cursor in query parameters', () => {
    const cursor = encodeCursor({ sort: 'price_asc', sortValue: 20, id: 4, context: JSON.stringify({ q: null, item_id: null, option_type: null, option_value: null, option_param: null, options: null, option_mode: 'all', price_min: null, price_max: null, map: null, shop_type: null, include_stale: false, sort: 'price_asc' }) });
    expect(() => parseSearchParams(new URL(`https://x.test?sort=price_desc&cursor=${cursor}`))).toThrow('Invalid cursor');
  });
  it('rejects a cursor when the filter context changes', () => {
    const cursor = encodeCursor({ sort: 'price_asc', sortValue: 20, id: 4, context: 'q=sword' });
    expect(() => decodeCursor(cursor, { sort: 'price_asc', context: 'q=shield' })).toThrow('Invalid cursor');
  });
  it('uses a configured HMAC-SHA-256 secret and rejects a different secret', () => {
    const secret = 'test-cursor-secret-which-is-long-enough';
    const cursor = encodeCursor({ sort: 'price_asc', sortValue: 20, id: 4 }, secret);
    const [body, signature] = cursor.split('.');
    expect(signature).toBe(createHmac('sha256', secret).update(body ?? '').digest('base64url'));
    expect(() => decodeCursor(cursor, undefined, 'different-cursor-secret')).toThrow('Invalid cursor');
  });
  it('parses repeated structured option filters with all/any mode', () => {
    const filters = parseSearchParams(new URL('https://x.test?option=1:gte:2&option=3:eq:4:5&option_mode=any'));
    expect(filters.options).toEqual([{ type: 1, operator: 'gte', value: '2' }, { type: 3, operator: 'eq', value: '4', param: 5 }]);
    expect(filters.option_mode).toBe('any');
  });
  it('bounds repeated option filters', () => {
    const query = Array.from({ length: 9 }, () => 'option=1:eq:2').join('&');
    expect(() => parseSearchParams(new URL(`https://x.test?${query}`))).toThrow('Too many option filters');
  });

  it('validates structured params and requires a complete legacy exact tuple', () => {
    expect(() => parseSearchParams(new URL('https://x.test?option=12:eq:50:not-an-integer'))).toThrow('Invalid option');
    expect(() => parseSearchParams(new URL(`https://x.test?option=12:eq:50:${Number.MAX_SAFE_INTEGER}0`))).toThrow('Invalid option');
    expect(() => parseSearchParams(new URL('https://x.test?option_type=12&option_value=50'))).toThrow('legacy option');
    expect(parseSearchParams(new URL('https://x.test?option_type=12&option_value=50&option_param=0'))).toMatchObject({ option_type: 12, option_value: 50, option_param: 0 });
  });

  it('normalizes NFKC whitespace and chooses Unicode code-point index modes', () => {
    const one = parseSearchParams(new URL('https://x.test?q=%E3%80%80%EF%BC%A1%E3%80%80'));
    expect(one).toMatchObject({ q: 'a', qMode: 'short_token' });
    expect(parseSearchParams(new URL('https://x.test?q=%E6%B3%A2%E5%88%A9'))).toMatchObject({ q: '波利', qMode: 'short_token' });
    expect(parseSearchParams(new URL('https://x.test?q=%E6%B3%A2%E5%88%A9%E5%8D%A1'))).toMatchObject({ q: '波利卡', qMode: 'fts' });
    expect(parseSearchParams(new URL('https://x.test?q=%E3%80%80%20'))).not.toHaveProperty('q');
    expect(() => parseSearchParams(new URL('https://x.test?q=' + encodeURIComponent('波'.repeat(81))))).toThrow('q is too long');
  });

  it('rejects mixed legacy and structured options and binds normalized context', () => {
    expect(() => parseSearchParams(new URL('https://x.test?option=12:gte:50&option_type=12'))).toThrow('Cannot mix');
    const filters = parseSearchParams(new URL('https://x.test?q=%EF%BC%A1&limit=50'), { verifyCursor: false });
    const cursor = encodeCursor({ sort: filters.sort, sortValue: 20, id: 4, context: searchCursorContext({ ...filters, catalogVersion: 'v1', optionVersion: 'o1', searchIndexVersion: 'i1' }) });
    expect(() => decodeCursor(cursor, { context: searchCursorContext({ ...filters, catalogVersion: 'v2', optionVersion: 'o1', searchIndexVersion: 'i1' }) })).toThrow('Invalid cursor');
    expect(() => decodeCursor(cursor, { context: searchCursorContext({ ...filters, q: 'b', catalogVersion: 'v1', optionVersion: 'o1', searchIndexVersion: 'i1' }) })).toThrow('Invalid cursor');
    const optionFilters = parseSearchParams(new URL('https://x.test?option=12:gte:50'), { verifyCursor: false });
    const optionCursor = encodeCursor({ sort: optionFilters.sort, sortValue: 20, id: 4, context: searchCursorContext({ ...optionFilters, catalogVersion: 'v1', optionVersion: 'o1', searchIndexVersion: 'i1' }) });
    expect(() => decodeCursor(optionCursor, { context: searchCursorContext({ ...optionFilters, options: [{ type: 12, operator: 'gte', value: '51' }], catalogVersion: 'v1', optionVersion: 'o1', searchIndexVersion: 'i1' }) })).toThrow('Invalid cursor');
    expect(() => decodeCursor(optionCursor, { context: searchCursorContext({ ...optionFilters, optionVersion: 'o2', catalogVersion: 'v1', searchIndexVersion: 'i1' }) })).toThrow('Invalid cursor');
  });

  it('returns the standard error envelope for invalid option and cursor contexts', async () => {
    const app = new Hono();
    registerSearchRoute(app, {
      getCatalogVersion: async () => 'catalog-v1',
      getOptionDefinitions: async () => ({ version: 'options-v1', items: [] }),
      searchListings: async (filters: SearchFilters) => {
        if (filters.options?.[0]?.type === 999) throw new SearchValidationError('Unknown option type: 999');
        return { items: [], nextCursor: encodeCursor({ sort: filters.sort, sortValue: 10, id: 1, context: searchCursorContext(filters) }) };
      },
    } as never, 'test-cursor-secret');

    const invalidOption = await app.request('/api/v1/market/search?option=999:eq:1', { headers: { 'cf-ray': 'request-option' } });
    expect(invalidOption.status).toBe(400);
    expect(await invalidOption.json()).toEqual({ error: { code: 'bad_request', message: 'Unknown option type: 999', request_id: 'request-option' } });

    const first = await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9');
    expect(first.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    const cursor = (await first.json() as { nextCursor: string }).nextCursor;
    const invalidCursor = await app.request(`/api/v1/market/search?q=%E6%B3%A2%E5%88%A9%E5%B8%BD&cursor=${encodeURIComponent(cursor)}`, { headers: { 'cf-ray': 'request-cursor' } });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({ error: { code: 'bad_request', request_id: 'request-cursor' } });
  });
});
