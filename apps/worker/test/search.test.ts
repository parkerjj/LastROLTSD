import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { decodeCursor, encodeCursor, parseSearchParams } from '../src/domain/search';

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
    const filters = parseSearchParams(new URL('https://x.test?option=1:2:0&option=3:4:5&option_mode=any'));
    expect(filters.options).toEqual([{ type: 1, value: 2, param: 0 }, { type: 3, value: 4, param: 5 }]);
    expect(filters.option_mode).toBe('any');
  });
  it('bounds repeated option filters', () => {
    const query = Array.from({ length: 9 }, () => 'option=1:2:0').join('&');
    expect(() => parseSearchParams(new URL(`https://x.test?${query}`))).toThrow('Too many option filters');
  });
});
