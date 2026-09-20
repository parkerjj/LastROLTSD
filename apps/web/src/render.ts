import type { HistoryPage, ListingSearchResult, SearchPage } from './types';
import type { SearchControllerState } from './search-controller';

export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export function renderSearchResults(container: HTMLElement, page: SearchPage<ListingSearchResult>, state: Pick<SearchControllerState, 'loading' | 'error' | 'empty'> & { cursor?: string | null }): void {
  if (state.loading) { container.innerHTML = '<p role="status">正在加载...</p>'; return; }
  if (state.error) { container.innerHTML = `<p role="alert">${escape(state.error)}</p>`; return; }
  if (state.empty || page.items.length === 0) { container.innerHTML = '<p role="status">没有匹配的在售商品</p>'; return; }
  container.innerHTML = `<div class="table-wrap"><table><caption class="sr-only">在售商品搜索结果</caption><thead><tr><th>物品</th><th>词条</th><th>价格</th><th>数量</th><th>地图</th><th>商店 / 玩家</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${page.items.map(renderListing).join('')}</tbody></table></div><div class="pager"><button id="next-page" type="button" ${page.nextCursor ? '' : 'disabled'} aria-label="下一页">下一页</button></div>`;
}

export function renderHistory(drawer: HTMLElement, history: HistoryPage, listingId?: number): void {
  const sales = history.inferredSales ?? [];
  drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="关闭历史">关闭</button><h2>价格历史</h2>${history.items.length ? `<ol>${history.items.map((item) => `<li><time>${new Date(item.observedAt).toLocaleString('zh-CN')}</time><strong>${item.price.toLocaleString('zh-CN')}</strong><span>数量 ${item.quantity} · ${escape(item.eventType)}</span></li>`).join('')}</ol>` : '<p>暂无历史记录</p>'}${sales.length ? `<h3>推断售出</h3><ul>${sales.map((sale) => `<li><strong>推断售出</strong>：${sale.soldQuantity}（${sale.fromQuantity} → ${sale.toQuantity}）· ${escape(sale.reason)} <time>${new Date(sale.observedAt).toLocaleString('zh-CN')}</time></li>`).join('')}</ul>` : ''}${history.nextCursor && listingId ? `<button type="button" id="next-history" data-listing-id="${listingId}" data-cursor="${escape(history.nextCursor)}" aria-label="历史下一页">下一页</button>` : ''}</div>`;
  drawer.hidden = false;
}

export function renderHistoryError(drawer: HTMLElement, message: string): void {
  drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="关闭历史">关闭</button><p role="alert">${escape(message)}</p></div>`;
  drawer.hidden = false;
}

function renderListing(item: ListingSearchResult): string {
  const itemName = item.itemName || `未知物品 #${item.itemId}`;
  const options = item.options.map((option) => escape(option.display || `未知词条 type=${option.type} value=${option.value} param=${option.param}`)).join('、') || '无';
  return `<tr><td><strong>${escape(itemName)}</strong><small>物品 ID：${escape(item.itemId)}</small></td><td>${options}</td><td>${item.price.toLocaleString('zh-CN')}</td><td>${item.quantity}</td><td>${escape(item.mapName)}</td><td>${escape(item.vendorName)}<small>${escape(item.title)}</small></td><td><time>${new Date(item.lastSeenAt).toLocaleString('zh-CN')}</time></td><td><button class="history-button" data-listing-id="${item.id}" type="button" aria-label="查看历史：${escape(itemName)}">查看历史</button></td></tr>`;
}
