import type { HistoryPage, ListingSearchResult, SearchPage } from './types';
import type { UiState } from './state';

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
export function renderSearchResults(container: HTMLElement, page: SearchPage<ListingSearchResult>, state: UiState): void {
  if (state.loading) { container.innerHTML = '<p role="status">Loading market listings...</p>'; return; }
  if (state.error) { container.innerHTML = `<p role="alert">${escape(state.error)}</p>`; return; }
  if (page.items.length === 0) { container.innerHTML = '<p role="status">No listings match these filters.</p>'; return; }
  container.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Options</th><th>Price</th><th>Qty</th><th>Location</th><th>Shop</th><th></th></tr></thead><tbody>${page.items.map((item) => `<tr><td><strong>${escape(item.itemName)}</strong><small>#${escape(item.itemId)}</small></td><td>${item.options.map((option) => escape(option.name ?? `${option.optionType}:${option.optionValue}:${option.optionParam}`)).join(', ') || 'None'}</td><td>${item.price.toLocaleString()}</td><td>${item.quantity}</td><td>${escape(item.mapName)}</td><td>${escape(item.vendorName)}<small>${escape(item.title)}</small></td><td><button class="history-button" data-listing-id="${item.id}" type="button">History</button></td></tr>`).join('')}</tbody></table></div><div class="pager"><button id="next-page" type="button" ${page.nextCursor ? '' : 'disabled'}>Next page</button></div>`;
}
export function renderHistory(drawer: HTMLElement, history: HistoryPage): void { drawer.innerHTML = `<div class="drawer-inner"><button type="button" id="close-history" aria-label="Close history">Close</button><h2>Price history</h2>${history.items.length ? `<ol>${history.items.map((item) => `<li><time>${new Date(item.observedAt).toLocaleString()}</time><strong>${item.price.toLocaleString()}</strong><span>Qty ${item.quantity} · ${escape(item.eventType)}</span></li>`).join('')}</ol>` : '<p>No history recorded.</p>'}</div>`; drawer.hidden = false; }
