import type { ItemAutocomplete, ItemAutocompletePage, ListingSearchResult, SearchPage } from './types';

export const AUTOCOMPLETE_LIMIT = 20;
export const SEARCH_ITEM_ID_LIMIT = 50;

export function normalizeCatalogQuery(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function findCatalogMatches(
  items: readonly ItemAutocomplete[],
  query: string,
  limit = AUTOCOMPLETE_LIMIT,
): ItemAutocomplete[] {
  const normalized = normalizeCatalogQuery(query);
  if (!normalized) return [];
  const boundedLimit = Math.min(Math.max(0, Math.trunc(limit)), SEARCH_ITEM_ID_LIMIT);
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => [item.name, ...item.aliases, String(item.itemId)].some((value) => normalizeCatalogQuery(value).includes(normalized)))
    .sort((left, right) => left.item.itemId - right.item.itemId || normalizeCatalogQuery(left.item.name).localeCompare(normalizeCatalogQuery(right.item.name)) || left.index - right.index)
    .slice(0, boundedLimit)
    .map(({ item }) => item);
}

export function createCatalogLoader(
  fetcher: typeof fetch = fetch,
  path = '/catalog/items.json',
): () => Promise<ItemAutocompletePage> {
  let pending: Promise<ItemAutocompletePage> | undefined;
  return () => {
    pending ??= fetcher(path).then(async (response) => {
      if (!response.ok) throw new Error('catalog unavailable');
      const payload = await response.json() as ItemAutocompletePage;
      if (!payload || !Array.isArray(payload.items)) throw new Error('catalog invalid');
      return payload;
    });
    return pending;
  };
}

export function catalogItemIds(items: readonly ItemAutocomplete[], query: string): number[] {
  return findCatalogMatches(items, query, SEARCH_ITEM_ID_LIMIT).map((item) => item.itemId);
}

export function hydrateSearchPage(
  page: SearchPage<ListingSearchResult>,
  items: readonly ItemAutocomplete[],
): SearchPage<ListingSearchResult> {
  const names = new Map(items.map((item) => [item.itemId, item.name]));
  return {
    ...page,
    items: page.items.map((item) => {
      const name = names.get(item.itemId);
      return name === undefined ? item : { ...item, itemName: name };
    }),
  };
}
