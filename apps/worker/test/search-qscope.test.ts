import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { encodeCursor, parseSearchParams, searchCursorContext } from '../src/domain/search';
import { matchCatalogItemIds, type CatalogEntry } from '../src/domain/catalog';
import { registerSearchRoute, searchResponse } from '../src/routes/search';
import type { SearchFilters } from '@lastroweb/protocol';

describe('q_scope parsing', () => {
  it('accepts allowlisted single scopes and rejects unknown values', () => {
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=item'))).toMatchObject({ q: 'a', q_scope: ['item'] });
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=shop'))).toMatchObject({ q_scope: ['shop'] });
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=vendor'))).toMatchObject({ q_scope: ['vendor'] });
    // 单独 all 归一化为缺省（不发范围），其余值报 400。
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=all'))).not.toHaveProperty('q_scope');
    expect(parseSearchParams(new URL('https://x.test?q=a'))).not.toHaveProperty('q_scope');
    expect(() => parseSearchParams(new URL('https://x.test?q=a&q_scope=name'))).toThrow('Invalid q_scope');
    expect(() => parseSearchParams(new URL('https://x.test?q=a&q_scope=all,item'))).toThrow('Invalid q_scope');
    expect(() => parseSearchParams(new URL('https://x.test?q=a&q_scope='))).toThrow('Invalid q_scope');
  });

  it('normalizes multi-value scopes to canonical order without duplicates', () => {
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=vendor,item'))).toMatchObject({ q_scope: ['item', 'vendor'] });
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=shop,item,shop'))).toMatchObject({ q_scope: ['item', 'shop'] });
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope= item , shop ,'))).toMatchObject({ q_scope: ['item', 'shop'] });
    expect(parseSearchParams(new URL('https://x.test?q=a&q_scope=vendor,shop,item'))).toMatchObject({ q_scope: ['item', 'shop', 'vendor'] });
  });

  it('merges resolved item ids before cursor context computation', () => {
    const merged = parseSearchParams(new URL('https://x.test?q=a&item_ids=1'), { resolvedItemIds: [2, 3, 2] });
    expect(merged.item_ids).toEqual([1, 2, 3]);
    // 游标两侧一致：同样带 resolvedItemIds 重放通过，缺失或不同则拒绝。
    const cursor = encodeCursor({ sort: merged.sort, sortValue: 10, id: 5, context: searchCursorContext(merged) });
    expect(() => parseSearchParams(new URL(`https://x.test?q=a&item_ids=1&cursor=${cursor}`), { resolvedItemIds: [2, 3] })).not.toThrow();
    expect(() => parseSearchParams(new URL(`https://x.test?q=a&item_ids=1&cursor=${cursor}`))).toThrow('Invalid cursor');
    expect(() => parseSearchParams(new URL(`https://x.test?q=a&item_ids=1&cursor=${cursor}`), { resolvedItemIds: [9] })).toThrow('Invalid cursor');
  });

  it('binds q_scope into the cursor context', () => {
    const base = { catalogVersion: 'c1', optionVersion: 'o1', searchIndexVersion: 'i1' } as const;
    const withScope = parseSearchParams(new URL('https://x.test?q=a&q_scope=shop'), { verifyCursor: false });
    const withMulti = parseSearchParams(new URL('https://x.test?q=a&q_scope=shop,vendor'), { verifyCursor: false });
    const withoutScope = parseSearchParams(new URL('https://x.test?q=a'), { verifyCursor: false });
    const context = (filters: SearchFilters) => searchCursorContext({ ...filters, ...base });
    expect(context(withScope)).not.toBe(context(withoutScope));
    expect(context(withMulti)).not.toBe(context(withScope));
    expect(context(withMulti)).toBe(context(withMulti));
  });
});

describe('catalog item matching', () => {
  const entries: CatalogEntry[] = [
    { itemId: 911, name: '波利卡', aliases: [] },
    { itemId: 909, name: '波利', aliases: ['Poring', '波利之王'] },
    { itemId: 501, name: '红色药水', aliases: [] },
  ];

  it('matches name, alias, and ID substrings with item-id ordering', () => {
    expect(matchCatalogItemIds(entries, '波利')).toEqual([909, 911]);
    expect(matchCatalogItemIds(entries, 'poring')).toEqual([909]);
    expect(matchCatalogItemIds(entries, 'ＰＯＲＩＮＧ')).toEqual([909]);
    expect(matchCatalogItemIds(entries, '501')).toEqual([501]);
    expect(matchCatalogItemIds(entries, '药水')).toEqual([501]);
    expect(matchCatalogItemIds(entries, '')).toEqual([]);
  });

  it('bounds the resolved id list at 50', () => {
    const many: CatalogEntry[] = Array.from({ length: 60 }, (_, index) => ({ itemId: index + 1, name: `道具${index + 1}`, aliases: [] }));
    expect(matchCatalogItemIds(many, '道具')).toHaveLength(50);
    expect(matchCatalogItemIds(many, '道具')[0]).toBe(1);
  });
});

describe('search route q_scope wiring', () => {
  const definitions = { version: 'options-v1', items: [] } as never;
  function makeApp(resolveItemIds?: (query: string) => Promise<number[]>) {
    const seen: SearchFilters[] = [];
    const app = new Hono();
    registerSearchRoute(app, {
      getCatalogVersion: async () => 'catalog-v1',
      getOptionDefinitions: async () => definitions,
      searchListings: async (filters: SearchFilters) => {
        seen.push(filters);
        return { items: [], nextCursor: encodeCursor({ sort: filters.sort, sortValue: 10, id: 1, context: searchCursorContext(filters) }) };
      },
    } as never, undefined, resolveItemIds);
    return { app, seen };
  }
  const resolver = vi.fn(async (query: string) => (query === '波利' ? [909, 911] : []));

  it('resolves q for all/item scopes and merges into repo filters', async () => {
    const { app, seen } = makeApp(resolver);
    await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=item');
    expect(resolver).toHaveBeenCalledWith('波利');
    expect(seen[0]?.item_ids).toEqual([909, 911]);
    expect(seen[0]?.q_scope).toEqual(['item']);
    await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9');
    expect(seen[1]?.item_ids).toEqual([909, 911]);
    expect(seen[1]).not.toHaveProperty('q_scope');
    // item 与 shop 组合：解析照常，q_scope 数组原样进入仓储层。
    await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=item,shop');
    expect(seen[2]?.item_ids).toEqual([909, 911]);
    expect(seen[2]?.q_scope).toEqual(['item', 'shop']);
  });

  it('skips resolution for shop/vendor scopes', async () => {
    const { app, seen } = makeApp(resolver);
    await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=shop');
    await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=vendor');
    await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=shop,vendor');
    expect(seen).toHaveLength(3);
    expect(seen.every((filters) => filters.item_ids === undefined)).toBe(true);
  });

  it('short-circuits an item-only query with no catalog hit and no explicit ids', async () => {
    const { app, seen } = makeApp(resolver);
    const response = await app.request('/api/v1/market/search?q=%E4%B8%8D%E5%AD%98%E5%9C%A8&q_scope=item');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
    expect(seen).toHaveLength(0);
    // 混合范围（item,shop）仍有商店标题 LIKE，不短路，正常走仓储层。
    await app.request('/api/v1/market/search?q=%E4%B8%8D%E5%AD%98%E5%9C%A8&q_scope=item,shop');
    expect(seen).toHaveLength(1);
  });

  it('keeps paginated item-scope cursors valid across resolution', async () => {
    const { app, seen } = makeApp(resolver);
    const first = await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=item');
    const { nextCursor } = await first.json() as { nextCursor: string };
    expect(seen).toHaveLength(1);
    const second = await app.request(`/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=item&cursor=${encodeURIComponent(nextCursor)}`);
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(2);
    // 同样的解析结果换 q_scope 后上下文失配，拒绝重放。
    const replayed = await app.request(`/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&cursor=${encodeURIComponent(nextCursor)}`);
    expect(replayed.status).toBe(400);
  });

  it('passes item-only queries to MySQL when no resolver is configured', async () => {
    const { app, seen } = makeApp(undefined);
    const response = await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&q_scope=item');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ items: [], nextCursor: expect.any(String) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ q: '波利', q_scope: ['item'] });
  });

  it('still answers direct searchResponse calls without a resolver', async () => {
    const response = await searchResponse(new Request('https://x.test/api/v1/market/search?q=abc'), {
      getCatalogVersion: async () => 'catalog-v1',
      getOptionDefinitions: async () => definitions,
      searchListings: async () => ({ items: [], nextCursor: null }),
    } as never);
    expect(response.status).toBe(200);
  });
});
