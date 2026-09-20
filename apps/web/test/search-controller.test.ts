import { describe, expect, it, vi } from 'vitest';
import { SearchController } from '../src/search-controller';
import type { ListingSearchResult, SearchFilters, SearchPage } from '../src/types';

const page = (id: number): SearchPage<ListingSearchResult> => ({ items: [{ id, itemId: id, itemName: `物品${id}`, price: id, quantity: 1, mapName: '地图', vendorName: '玩家', title: '商店', options: [], lastSeenAt: id }], nextCursor: id === 1 ? 'next' : null });

describe('search controller', () => {
  it('aborts a stale request and keeps the newer result', async () => {
    const deferred: Array<{ resolve: (value: SearchPage<ListingSearchResult>) => void; signal: AbortSignal | undefined }> = [];
    const api = { search: vi.fn((_: SearchFilters, signal?: AbortSignal) => new Promise<SearchPage<ListingSearchResult>>((resolve) => { deferred.push({ resolve, signal }); })) };
    const controller = new SearchController(api);
    const first = controller.search({ q: '旧', limit: 20, sort: 'price_asc' });
    const second = controller.search({ q: '新', limit: 20, sort: 'price_asc' });
    expect(deferred[0]?.signal?.aborted).toBe(true);
    deferred[1]!.resolve(page(2));
    await second;
    deferred[0]!.resolve(page(1));
    await first;
    expect(controller.getState()).toMatchObject({ loading: false, error: null, empty: false });
    expect(controller.getState().page?.items[0]?.id).toBe(2);
  });

  it('loads the next cursor while preserving current filters', async () => {
    const search = vi.fn().mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2));
    const controller = new SearchController({ search });
    await controller.search({ q: '波利', limit: 20, sort: 'price_asc' });
    await controller.nextPage();
    expect(search).toHaveBeenLastCalledWith({ q: '波利', limit: 20, sort: 'price_asc', cursor: 'next' }, expect.any(AbortSignal));
  });
});
