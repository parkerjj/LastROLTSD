import type { HistoryPage, ItemMarketHistory, ListingSearchResult, SearchFilters, SearchPage } from './types';
import type { SearchControllerState } from './search-controller';
import { hydrateSearchPage } from './catalog';
import type { ItemAutocomplete, ItemDescription } from './types';
import { mapDetails, mapMarkerPosition } from './maps';

export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

type RenderState = Pick<SearchControllerState, 'loading' | 'error' | 'empty'> & {
  cursor?: string | null;
  filters?: SearchFilters;
  descriptionError?: string | null;
  initialBrowse?: boolean;
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
  { key: 'shop', label: '商店名称命中', hint: '商店标题中包含搜索词' },
  { key: 'vendor', label: '商人名称命中', hint: '摆摊玩家名称中包含搜索词' },
] as const;

const SORT_OPTIONS: Array<{ value: SearchFilters['sort']; label: string; note: string }> = [
  { value: 'price_asc', label: '价格从低到高', note: '按价格由低到高' },
  { value: 'price_desc', label: '价格从高到低', note: '按价格由高到低' },
  { value: 'changed_desc', label: '最近变动', note: '按最近变动排序' },
];

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
        <header class="group-heading">
          <span class="group-heading-copy"><strong>${group.label}</strong><small>${group.hint}</small></span>
          <span class="group-count">${items.length} 条</span>
          <button type="button" class="group-toggle" aria-expanded="true" aria-controls="group-body-${group.key}" aria-label="收起${group.label}" title="收起${group.label}" data-group-label="${group.label}"><i class="ph ph-caret-down" aria-hidden="true"></i></button>
        </header>
        <div id="group-body-${group.key}" class="group-body">${items.map(renderListing).join('')}</div>
      </section>`;
    })
    .join('');
  const shown = safeItems.length;
  const resultCountLabel = state.initialBrowse ? `最新收录的 ${shown} 条数据` : `共 ${shown} 条在售记录`;
  const activeSort = SORT_OPTIONS.find((option) => option.value === state.filters?.sort) ?? SORT_OPTIONS[0]!;
  const sortOptions = SORT_OPTIONS.map((option) => `<option value="${option.value}"${option.value === activeSort.value ? ' selected' : ''}>${option.label}</option>`).join('');
  const descriptionNotice = state.descriptionError ? `<p role="status" class="description-notice">物品详细描述加载失败，当前显示词条信息。${escape(state.descriptionError)}</p>` : '';
  container.innerHTML = `${descriptionNotice}<div class="results-toolbar"><div class="results-overview"><div><strong>${resultCountLabel}</strong></div><span class="results-note">按命中位置分组 · ${activeSort.note}</span></div><label class="sort-control" for="result-sort"><span>排序</span><select id="result-sort" name="sort" aria-label="结果排序">${sortOptions}</select></label></div>${sections}<div class="pager"><button id="next-page" type="button" ${page.nextCursor ? '' : 'disabled'} aria-label="加载下一页">${page.nextCursor ? '加载下一页' : '已显示全部'}</button></div>`;
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

type HistoryItemBrief = Pick<ListingSearchResult, 'itemId' | 'itemName' | 'itemIcon'>;

export function renderHistory(drawer: HTMLElement, history: HistoryPage | ItemMarketHistory, item?: number | HistoryItemBrief): void {
  if ('currentListings' in history) {
    renderItemMarketHistory(drawer, history, typeof item === 'number' ? undefined : item);
    return;
  }
  const listingId = typeof item === 'number' ? item : undefined;
  const sales = history.inferredSales ?? [];
  drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="关闭价格历史">关闭</button><p class="drawer-kicker">成交观察</p><h2>价格历史</h2>${history.items.length ? `<ol>${history.items.map((item) => `<li><time>${new Date(item.observedAt).toLocaleString('zh-CN')}</time><strong>${item.price.toLocaleString('zh-CN')} <small>z / ${item.quantity} 件</small></strong><span>${translateHistoryEvent(item.eventType)}</span></li>`).join('')}</ol>` : '<p>暂无历史记录</p>'}${sales.length ? `<h3>售出</h3><ul>${sales.map((sale) => `<li><strong>售出</strong>：${sale.soldQuantity}（${sale.fromQuantity} → ${sale.toQuantity}）· ${escape(translateHistoryEvent(sale.reason))} <time>${new Date(sale.observedAt).toLocaleString('zh-CN')}</time></li>`).join('')}</ul>` : ''}${history.nextCursor && listingId ? `<button type="button" id="next-history" data-listing-id="${listingId}" data-cursor="${escape(history.nextCursor)}" aria-label="加载更多历史">加载更多</button>` : ''}</div>`;
  drawer.hidden = false;
}

function renderItemMarketHistory(drawer: HTMLElement, history: ItemMarketHistory, item?: HistoryItemBrief): void {
  const itemName = item?.itemName || `未知物品 #${history.itemId}`;
  const itemIcon = proxyRmsAsset(item?.itemIcon || rmsAssetUrl(`items/large/${encodeURIComponent(String(history.itemId))}.gif`));
  const activeUnits = history.currentListings.reduce((sum, listing) => sum + listing.quantity, 0);
  const eventRange = `${formatShortDate(history.windowStart)} - ${formatShortDate(history.windowEnd)}`;
  const currentListings = history.currentListings.length
    ? `<ul class="history-list current-listings">${history.currentListings.map((listing) => `<li><div><strong>${listing.price.toLocaleString('zh-CN')} <small>z</small></strong><span>${escape(listing.title || '未命名商店')} · ${escape(listing.vendorName || '未知玩家')}</span></div><div class="history-row-meta"><span>${listing.quantity} 件 · ${escape(listing.mapName || '未知地图')}</span><time>${new Date(listing.lastChangedAt).toLocaleString('zh-CN')}</time></div></li>`).join('')}</ul>`
    : '<p class="history-empty">当前没有正在出售的记录</p>';
  const sales = history.sales.length
    ? `<ul class="history-list history-sales">${history.sales.map((sale) => `<li><div><span>此道具在 <time>${new Date(sale.observedAt).toLocaleString('zh-CN')}</time> 以 ${sale.price.toLocaleString('zh-CN')} Zeny 售出 ${sale.soldQuantity} 个 · ${escape(sale.title || '未命名商店')} / ${escape(sale.vendorName || '未知玩家')}</span></div></li>`).join('')}</ul>`
    : '<p class="history-empty">30 天内没有可确认的售出变动</p>';
  drawer.innerHTML = `<div class="drawer-inner history-drawer-inner">
    <button type="button" id="close-history" aria-label="关闭价格历史">关闭</button>
    <section class="history-item-summary" aria-label="查询物品">
      <div class="history-item-art"><img src="${escape(itemIcon)}" alt="${escape(itemName)}" data-image-fallback /><span class="detail-art-fallback" aria-hidden="true" hidden>RO</span></div>
      <div><p class="drawer-kicker">物品市场</p><h2>${escape(itemName)}</h2><p>物品 ID ${history.itemId}</p></div>
    </section>
    <div class="history-stat-strip" aria-label="市场概览"><span><strong>${history.currentListings.length}</strong> 间在售商店</span><span><strong>${activeUnits}</strong> 件当前库存</span><span><strong>${history.sales.length}</strong> 次售出记录</span></div>
    <section class="history-section">
      <div class="history-section-heading"><div><p class="drawer-kicker">30 天市场走势</p><h3>价格与库存</h3></div><time>${eventRange}</time></div>
      <p class="history-chart-explanation">横轴是时间，左轴是价格，右轴是对应市场观察记录的库存数量。折线以服务器观察点平滑连接，用于识别价格变化、补货与售出趋势。</p>
      ${renderHistoryTrend(history)}
    </section>
    <section class="history-section"><div class="history-section-heading"><div><p class="drawer-kicker">当前在售</p><h3>所有出售商店</h3></div><span>${history.currentListings.length} 条</span></div>${currentListings}</section>
    <section class="history-section"><div class="history-section-heading"><div><p class="drawer-kicker">历史成交</p><h3>售出记录</h3></div><span>${history.sales.length} 条</span></div>${sales}</section>
  </div>`;
  drawer.hidden = false;
}

function renderHistoryTrend(history: ItemMarketHistory): string {
  const events = history.events;
  if (events.length === 0) return '<p class="history-empty">30 天内没有足够的价格或库存变动，暂时无法绘制走势。</p>';
  const frame = { left: 54, top: 20, width: 312, height: 152 };
  const priceExtent = paddedExtent(events.map((event) => event.price));
  const quantityExtent = paddedExtent(events.map((event) => event.quantity));
  const timeRange = Math.max(1, history.windowEnd - history.windowStart);
  const x = (value: number) => frame.left + ((value - history.windowStart) / timeRange) * frame.width;
  const y = (value: number, extent: [number, number]) => frame.top + (1 - (value - extent[0]) / (extent[1] - extent[0])) * frame.height;
  const pricePoints = events.map((event) => ({ x: x(event.observedAt), y: y(event.price, priceExtent) }));
  const quantityPoints = events.map((event) => ({ x: x(event.observedAt), y: y(event.quantity, quantityExtent) }));
  return `<div class="history-chart" data-history-chart><div class="history-chart-legend"><span><i class="chart-key chart-key-price"></i>价格</span><span><i class="chart-key chart-key-quantity"></i>库存</span></div><svg viewBox="0 0 420 220" role="img" aria-label="30 天价格和库存走势"><rect x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" class="history-chart-frame"/><path d="M${frame.left} ${frame.top + frame.height / 2}H${frame.left + frame.width}" class="history-chart-grid"/><path d="${smoothPath(pricePoints)}" class="history-chart-price"/><path d="${smoothPath(quantityPoints)}" class="history-chart-quantity"/>${pricePoints.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.5" class="history-chart-price-point"/>`).join('')}${quantityPoints.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.5" class="history-chart-quantity-point"/>`).join('')}<text x="4" y="${frame.top + 4}" class="history-chart-label">${formatCompact(priceExtent[1])} z</text><text x="4" y="${frame.top + frame.height}" class="history-chart-label">${formatCompact(priceExtent[0])} z</text><text x="${frame.left + frame.width + 8}" y="${frame.top + 4}" class="history-chart-label">${formatCompact(quantityExtent[1])} 件</text><text x="${frame.left + frame.width + 8}" y="${frame.top + frame.height}" class="history-chart-label">${formatCompact(quantityExtent[0])} 件</text><text x="${frame.left}" y="204" class="history-chart-label">${formatShortDate(history.windowStart)}</text><text x="${frame.left + frame.width}" y="204" text-anchor="end" class="history-chart-label">${formatShortDate(history.windowEnd)}</text></svg></div>`;
}

function paddedExtent(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [Math.max(0, min - 1), max + 1];
  const padding = Math.max(1, (max - min) * .12);
  return [Math.max(0, min - padding), max + padding];
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0]!.x} ${points[0]!.y}`;
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    const midpointX = (previous.x + point.x) / 2;
    return `Q${previous.x} ${previous.y} ${midpointX} ${(previous.y + point.y) / 2}`;
  });
  const last = points.at(-1)!;
  return `M${points[0]!.x} ${points[0]!.y}${segments.join('')}L${last.x} ${last.y}`;
}

function formatCompact(value: number): string { return Math.round(value).toLocaleString('zh-CN'); }
function formatShortDate(value: number): string { return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }); }

export function renderHistoryError(drawer: HTMLElement, message: string): void {
  drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="关闭价格历史">关闭</button><p role="alert">${escape(friendlyError(message, '价格历史接口暂不可用，请确认本地服务已启动。'))}</p></div>`;
  drawer.hidden = false;
}

function groupListings(items: ListingSearchResult[], query?: string): ListingSearchResult[][] {
  const groups: ListingSearchResult[][] = GROUPS.map(() => []);
  const normalized = normalizeGroupValue(query);
  items.forEach((item) => {
    if (!normalized) { groups[0]!.push(item); return; }
    const name = normalizeGroupValue(item.itemName);
    const shop = normalizeGroupValue(item.title);
    const vendor = normalizeGroupValue(item.vendorName);
    if (name.includes(normalized)) groups[0]!.push(item);
    else if (shop.includes(normalized)) groups[1]!.push(item);
    else if (vendor.includes(normalized)) groups[2]!.push(item);
  });
  return groups;
}

function normalizeGroupValue(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
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
    <div class="item-location"><strong>${escape(map.name)}</strong><small>${coordinates.x}，${coordinates.y}</small><button type="button" class="map-button" data-map-name="${escape(map.name)}" data-map-image="${escape(map.image)}" data-map-code="${escape(map.code)}" data-map-x="${coordinates.x}" data-map-y="${coordinates.y}" data-map-marker-left="${marker.left}" data-map-marker-top="${marker.top}" aria-label="查看${escape(map.name)}地图">地图定位</button></div>
    <div class="item-shop"><span>商店 / 玩家</span><strong>${escape(item.title || '未命名商店')}</strong><small>${escape(item.vendorName || '未知玩家')}</small></div>
    <div class="item-updated"><span>最近变动</span><time>${new Date(item.lastChangedAt).toLocaleString('zh-CN')}</time></div>
    <div class="item-actions"><button class="history-button" data-listing-id="${escape(item.id)}" data-item-id="${escape(item.itemId)}" data-item-name="${escape(itemName)}" data-item-icon="${escape(icon)}" type="button" aria-label="查看${escape(itemName)}价格历史">价格历史</button></div>
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
