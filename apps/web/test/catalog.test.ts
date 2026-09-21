import { describe, expect, it, vi } from 'vitest';
import { createCatalogLoader, findCatalogMatches, hydrateSearchPage } from '../src/catalog';
import type { ItemAutocomplete, ListingSearchResult } from '../src/types';

const catalog: ItemAutocomplete[] = [
  { itemId: 4002, name: '波利帽', aliases: ['波利头饰'] },
  { itemId: 4001, name: '波利卡片', aliases: ['利卡'] },
  { itemId: 9000, name: '利卡特价券', aliases: [] },
  { itemId: 100, name: '商店物品', aliases: [] },
];

describe('static browser catalog', () => {
  it('matches names, aliases, and numeric IDs with stable numeric ordering', () => {
    expect(findCatalogMatches(catalog, '利卡').map((item) => item.itemId)).toEqual([4001, 9000]);
    expect(findCatalogMatches(catalog, '4001').map((item) => item.itemId)).toEqual([4001]);
    expect(findCatalogMatches(catalog, '波利').map((item) => item.itemId)).toEqual([4001, 4002]);
  });

  it('caps results and never inspects shop or vendor fields', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ itemId: index + 1, name: `物品-${index}`, aliases: [] }));
    expect(findCatalogMatches(items, '物品').map((item) => item.itemId)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(findCatalogMatches([{ itemId: 1, name: '普通物品', aliases: [] }], '利卡')).toEqual([]);
  });

  it('loads the JSON asset once and hydrates item names on the client', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 'v1', items: catalog })));
    const load = createCatalogLoader(fetcher);
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const row = { id: 1, itemId: 4001, price: 10, quantity: 1, mapName: 'prontera', vendorName: '杰利卡', title: '利卡特价', options: [], lastSeenAt: 0 } as ListingSearchResult;
    expect(hydrateSearchPage({ items: [row], nextCursor: null }, catalog).items[0]?.itemName).toBe('波利卡片');
  });
});
