// 服务端图鉴匹配：与 web 前端 catalog.ts 的 findCatalogMatches 规则保持一致
// （NFKC 归一化后对 名称/别名/ID 字符串 做 includes 子串匹配，按 item_id 升序取前 limit 个），
// 使 q_scope=item/all 的名字解析结果与 web 客户端本地解析的 item_ids 集合一致。
const SEARCH_ITEM_ID_LIMIT = 50;

export interface CatalogEntry { itemId: number; name: string; aliases: readonly string[] }

export function normalizeCatalogQuery(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function matchCatalogItemIds(items: readonly CatalogEntry[], query: string, limit = SEARCH_ITEM_ID_LIMIT): number[] {
  const normalized = normalizeCatalogQuery(query);
  if (!normalized) return [];
  const boundedLimit = Math.min(Math.max(0, Math.trunc(limit)), SEARCH_ITEM_ID_LIMIT);
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => [item.name, ...item.aliases, String(item.itemId)].some((value) => normalizeCatalogQuery(value).includes(normalized)))
    .sort((left, right) => left.item.itemId - right.item.itemId || normalizeCatalogQuery(left.item.name).localeCompare(normalizeCatalogQuery(right.item.name)) || left.index - right.index)
    .slice(0, boundedLimit)
    .map(({ item }) => item.itemId);
}
