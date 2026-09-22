import type { HistoryPage, ListingSearchResult, SearchFilters, SearchPage } from './types';
import type { SearchControllerState } from './search-controller';
import { hydrateSearchPage } from './catalog';
import type { ItemAutocomplete, ItemDescription } from './types';
import { mapDetails, mapMarkerPosition } from './maps';

export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

type RenderState = Pick<SearchControllerState, 'loading' | 'error' | 'empty'> & {
  cursor?: string | null;
  filters?: SearchFilters;
  descriptionError?: string | null;
};

export function friendlyError(value: unknown, fallback = '本地接口暂不可用，请确认服务已启动。'): string {
  const message = String(value ?? '').trim();
  return /[\u3400-\u9fff]/u.test(message) ? message : fallback;
}

type RichListing = ListingSearchResult & {
  description?: string;
  itemDescription?: string;
  x?: number;
  y?: number;
  mapX?: number;
  mapY?: number;
  itemIcon?: string;
};

export function rmsAssetUrl(path: string): string {
  return `/api/v1/assets/${path.replace(/^\/+|\/+$/gu, '')}?lastroweb=v3`;
}

function proxyRmsAsset(value: string): string {
  try {
    const url = new URL(value, 'https://lastroweb.invalid');
    if (url.hostname === 'file5s.ratemyserver.net' || url.hostname === 'ratemyserver.net' || url.hostname.endsWith('.ratemyserver.net')) return rmsAssetUrl(url.pathname);
  } catch { /* Keep malformed or non-RMS values for the normal escaping path. */ }
  return value;
}

const GROUPS = [
  { key: 'name', label: '物品名称命中', hint: '名称中包含搜索词' },
  { key: 'description', label: '物品描述命中', hint: '描述或词条中包含搜索词' },
  { key: 'shop', label: '商店名称命中', hint: '商店标题中包含搜索词' },
  { key: 'vendor', label: '商人名称命中', hint: '摆摊玩家名称中包含搜索词' },
  { key: 'other', label: '其他命中', hint: '地图或其他字段命中' },
] as const;

export function parseRoMarkup(value: unknown): string {
  const source = String(value ?? '').replace(/\\n/g, '\n');
  const marker = /\^([0-9a-f]{6})\^?/gi;
  let html = '';
  let color = 'inherit';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    html += colorSpan(source.slice(cursor, match.index), color);
    const code = match[1] ?? '000000'; color = code.toLowerCase() === '000000' ? 'inherit' : `#${code}`;
    cursor = marker.lastIndex;
  }
  html += colorSpan(source.slice(cursor), color);
  return html.replace(/\n/g, '<br>');
}

function colorSpan(value: string, color: string): string {
  if (!value) return '';
  return color === 'inherit' ? escape(value) : `<span style="color:${escape(color)}">${escape(value)}</span>`;
}

export function renderSearchResults(container: HTMLElement, page: SearchPage<ListingSearchResult>, state: RenderState): void {
  if (state.loading) { container.innerHTML = '<p role="status" class="state-message">正在加载市场数据...</p>'; return; }
  const safeItems = page.items ?? [];
  if (state.error) { container.innerHTML = `<p role="alert" class="state-message">${escape(friendlyError(state.error, '市场查询接口暂不可用，请确认本地服务已启动。'))}</p>`; return; }
  if (state.empty || safeItems.length === 0) { container.innerHTML = '<p role="status" class="state-message">没有匹配的在售商品</p>'; return; }

  const groups = groupListings(safeItems, state.filters?.q);
  const sections = GROUPS
    .map((group, index) => {
      const items = groups[index] ?? [];
      if (items.length === 0) return '';
      return `<section class="result-group" data-group="${group.key}">
        <button type="button" class="group-toggle" aria-expanded="true" aria-controls="group-body-${group.key}">
          <span><strong>${group.label}</strong><small>${group.hint}</small></span><em>${items.length} 条</em><span class="toggle-mark" aria-hidden="true">⌃</span>
        </button>
        <div id="group-body-${group.key}" class="group-body">${items.map(renderListing).join('')}</div>
      </section>`;
    })
    .join('');
  const shown = safeItems.length;
  const descriptionNotice = state.descriptionError ? `<p role="status" class="description-notice">物品详细描述加载失败，当前显示词条信息。${escape(state.descriptionError)}</p>` : '';
  container.innerHTML = `${descriptionNotice}<div class="results-toolbar"><div><span class="results-kicker">查询结果</span><strong>共 ${shown} 条在售记录</strong></div><span class="results-note">按命中位置分组 · 按价格由低到高</span></div>${sections}<div class="pager"><button id="next-page" type="button" ${page.nextCursor ? '' : 'disabled'} aria-label="加载下一页">${page.nextCursor ? '加载下一页' : '已显示全部'}</button></div>`;
}

export function renderSearchResultsWithCatalog(
  container: HTMLElement,
  page: SearchPage<ListingSearchResult>,
  state: RenderState,
  catalog: readonly ItemAutocomplete[],
  descriptions: readonly ItemDescription[] = [],
): void {
  renderSearchResults(container, hydrateSearchPage(page, catalog, descriptions), state);
}

export function renderHistory(drawer: HTMLElement, history: HistoryPage, listingId?: number): void {
  const sales = history.inferredSales ?? [];
  drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="关闭价格历史">关闭</button><p class="drawer-kicker">成交观察</p><h2>价格历史</h2>${history.items.length ? `<ol>${history.items.map((item) => `<li><time>${new Date(item.observedAt).toLocaleString('zh-CN')}</time><strong>${item.price.toLocaleString('zh-CN')} <small>z / ${item.quantity} 件</small></strong><span>${translateHistoryEvent(item.eventType)}</span></li>`).join('')}</ol>` : '<p>暂无历史记录</p>'}${sales.length ? `<h3>推断售出</h3><ul>${sales.map((sale) => `<li><strong>推断售出</strong>：${sale.soldQuantity}（${sale.fromQuantity} → ${sale.toQuantity}）· ${escape(translateHistoryEvent(sale.reason))} <time>${new Date(sale.observedAt).toLocaleString('zh-CN')}</time></li>`).join('')}</ul>` : ''}${history.nextCursor && listingId ? `<button type="button" id="next-history" data-listing-id="${listingId}" data-cursor="${escape(history.nextCursor)}" aria-label="加载更多历史">加载更多</button>` : ''}</div>`;
  drawer.hidden = false;
}

export function renderHistoryError(drawer: HTMLElement, message: string): void {
  drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="关闭价格历史">关闭</button><p role="alert">${escape(friendlyError(message, '价格历史接口暂不可用，请确认本地服务已启动。'))}</p></div>`;
  drawer.hidden = false;
}

function groupListings(items: ListingSearchResult[], query?: string): ListingSearchResult[][] {
  const groups: ListingSearchResult[][] = GROUPS.map(() => []);
  const normalized = String(query ?? '').trim().toLocaleLowerCase('zh-CN');
  items.forEach((item) => {
    const rich = item as RichListing;
    if (!normalized) { groups[0]!.push(item); return; }
    const name = String(item.itemName ?? '').toLocaleLowerCase('zh-CN');
    const description = [rich.description, rich.itemDescription, ...item.options.map((option) => option.display)].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    const shop = String(item.title ?? '').toLocaleLowerCase('zh-CN');
    const vendor = String(item.vendorName ?? '').toLocaleLowerCase('zh-CN');
    const other = String(item.mapName ?? '').toLocaleLowerCase('zh-CN');
    if (name.includes(normalized)) groups[0]!.push(item);
    else if (description.includes(normalized)) groups[1]!.push(item);
    else if (shop.includes(normalized)) groups[2]!.push(item);
    else if (vendor.includes(normalized)) groups[3]!.push(item);
    else if (other.includes(normalized)) groups[4]!.push(item);
  });
  return groups;
}

function renderListing(item: ListingSearchResult): string {
  const rich = item as RichListing;
  const itemName = item.itemName || `未知物品 #${item.itemId}`;
  const rawName = String(item.itemName ?? '');
  const options = item.options.map((option) => escape(option.display || `未知词条 type=${option.type} value=${option.value} param=${option.param}`)).join('、') || '暂无词条';
  const description = rich.description ?? rich.itemDescription ?? (item.options.map((option) => option.display).filter(Boolean).join('\n') || '暂无详细描述');
  const icon = proxyRmsAsset(rich.itemIcon || rmsAssetUrl(`items/small/${encodeURIComponent(String(item.itemId))}.gif`));
  const largeIcon = rmsAssetUrl(`items/large/${encodeURIComponent(String(item.itemId))}.gif`);
  const map = mapInfo(item.mapName);
  const coordinates = getCoordinates(rich, item.mapName);
  const marker = mapMarkerPosition(item.mapName, coordinates.x, coordinates.y);
  const image = /[<>]/u.test(rawName) ? '' : `<img src="${escape(icon)}" alt="" loading="lazy" data-image-fallback /><span class="item-icon-fallback" aria-hidden="true" hidden>RO</span>`;
  const detailImage = /[<>]/u.test(rawName) ? '' : `<img src="${escape(largeIcon)}" alt="${escape(itemName)}" loading="lazy" data-image-fallback /><span class="detail-art-fallback" aria-hidden="true" hidden>RO</span>`;
  return `<article class="item-row">
    <div class="item-main">
      <div class="item-icon">${image || '<span class="item-icon-fallback" aria-hidden="true">RO</span>'}</div>
      <div class="item-copy"><span class="item-id">物品 ID ${escape(item.itemId)}</span><h3>${escape(itemName)}</h3><p class="option-line">${options}</p></div>
      <div class="item-detail-popover" role="tooltip"><div class="detail-art">${detailImage}</div><div><strong>${escape(itemName)}</strong><span class="detail-id">ID：${escape(item.itemId)}</span><p>${parseRoMarkup(description)}</p></div></div>
    </div>
    <div class="item-price"><span>价格</span><strong>${item.price.toLocaleString('zh-CN')} <small>z</small></strong><em>${item.quantity} 件</em></div>
    <div class="item-location"><span>地图</span><strong>${escape(map.name)}</strong><small>${coordinates.x}，${coordinates.y}</small><button type="button" class="map-button" data-map-name="${escape(map.name)}" data-map-image="${escape(map.image)}" data-map-code="${escape(map.code)}" data-map-x="${coordinates.x}" data-map-y="${coordinates.y}" data-map-marker-left="${marker.left}" data-map-marker-top="${marker.top}" aria-label="查看${escape(map.name)}地图">地图定位</button></div>
    <div class="item-shop"><span>商店 / 玩家</span><strong>${escape(item.title || '未命名商店')}</strong><small>${escape(item.vendorName || '未知玩家')}</small></div>
    <div class="item-updated"><span>最近变动</span><time>${new Date(item.lastChangedAt).toLocaleString('zh-CN')}</time></div>
    <div class="item-actions"><button class="history-button" data-listing-id="${escape(item.id)}" type="button" aria-label="查看${escape(itemName)}价格历史">价格历史</button></div>
  </article>`;
}

function mapInfo(mapName: string): { image: string; code: string; name: string } {
  const map = mapDetails(mapName);
  return map
    ? { code: map.code, name: map.name, image: rmsAssetUrl(map.image) }
    : { code: 'morocc', name: mapName || '未知地图', image: rmsAssetUrl('maps_xl/morocc_re.gif') };
}

function getCoordinates(item: RichListing, mapName: string): { x: number; y: number } {
  const source = `${mapName} ${String((item as unknown as Record<string, unknown>).coordinates ?? '')}`;
  const match = source.match(/(?:坐标|位置)?\s*[（(]?\s*(\d{1,3})\s*[,，]\s*(\d{1,3})/u);
  const rawX = item.x ?? item.mapX ?? Number(match?.[1]);
  const rawY = item.y ?? item.mapY ?? Number(match?.[2]);
  const map = mapDetails(mapName);
  const maxX = map?.maxX ?? 100;
  const maxY = map?.maxY ?? 100;
  return {
    x: Number.isFinite(rawX) ? Math.max(0, Math.min(maxX, Math.round(rawX))) : Math.round(maxX / 2),
    y: Number.isFinite(rawY) ? Math.max(0, Math.min(maxY, Math.round(rawY))) : Math.round(maxY / 2),
  };
}

function translateHistoryEvent(value: string): string {
  const labels: Record<string, string> = {
    observed: '观察到上架',
    quantity_decrease: '库存减少',
    price_change: '价格调整',
    quantity_increase: '库存增加',
  };
  return labels[value] ?? value.replace(/_/g, ' ');
}
