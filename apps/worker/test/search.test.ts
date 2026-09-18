import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, parseSearchParams } from '../src/domain/search';

describe('search filters', () => {
  it('parses bounded filters and a stable cursor', () => { const filters = parseSearchParams(new URL('https://x.test/api?q=sword&limit=99&price_min=10&price_max=20&sort=price_desc')); expect(filters.limit).toBe(50); expect(filters.q).toBe('sword'); const cursor = encodeCursor({ sortValue: 20, id: 4 }); expect(decodeCursor(cursor)).toEqual({ sortValue: 20, id: 4 }); });
  it('rejects unallowlisted sort and malformed ranges', () => { expect(() => parseSearchParams(new URL('https://x.test?sort=price'))).toThrow(); expect(() => parseSearchParams(new URL('https://x.test?price_min=20&price_max=10'))).toThrow(); });
});
