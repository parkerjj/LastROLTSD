import './styles.css';
import { MarketApi } from './api';
import { initialState, type UiState } from './state';
import { renderHistory, renderHistoryError, renderSearchResults } from './render';
import { appendOptionRow, serializeSearchForm } from './query-form';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing app root');
const api = new MarketApi(); let state: UiState = { ...initialState }; let controller: AbortController | undefined;
root.innerHTML = `<header><h1>LastRO Market</h1><span>Current listings</span></header><section class="search-panel"><form id="search-form"><div class="filters"><label>Search<input name="q" placeholder="Item, shop, vendor" /></label><label>Item ID<input name="item_id" inputmode="numeric" /></label><label>Min price<input name="price_min" inputmode="numeric" /></label><label>Max price<input name="price_max" inputmode="numeric" /></label><label>Map<input name="map" /></label><label>Shop type<select name="shop_type"><option value="">Any</option><option value="sell">Sell</option><option value="buy">Buy</option></select></label></div><fieldset class="option-filters"><legend>Options</legend><div class="option-mode"><label><input type="radio" name="option_mode" value="all" checked />All</label><label><input type="radio" name="option_mode" value="any" />Any</label></div><div id="option-rows"></div><button type="button" id="add-option">Add option</button></fieldset><button type="submit">Search</button></form></section><section id="results" aria-live="polite"></section><aside id="history-drawer" hidden></aside>`;
const results = root.querySelector<HTMLElement>('#results')!; const form = root.querySelector<HTMLFormElement>('#search-form')!; const drawer = root.querySelector<HTMLElement>('#history-drawer')!;
const optionRows = root.querySelector<HTMLElement>('#option-rows')!;
root.querySelector<HTMLButtonElement>('#add-option')?.addEventListener('click', () => appendOptionRow(optionRows));
function formFilters(): UiState['filters'] { return serializeSearchForm(form); }
async function search(): Promise<void> { controller?.abort(); controller = new AbortController(); state = { ...state, loading: true, error: null }; renderSearchResults(results, { items: [], nextCursor: null }, state); try { const page = await api.search(state.filters, controller.signal); state = { ...state, loading: false, empty: page.items.length === 0, cursor: page.nextCursor }; renderSearchResults(results, page, state); } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; state = { ...state, loading: false, error: error instanceof Error ? error.message : 'Network error' }; renderSearchResults(results, { items: [], nextCursor: null }, state); } }
form.addEventListener('submit', (event) => { event.preventDefault(); state = { ...state, filters: formFilters(), cursor: null }; void search(); });
results.addEventListener('click', (event) => { const target = event.target as HTMLElement; const historyButton = target.closest<HTMLButtonElement>('.history-button'); if (historyButton) { drawer.hidden = false; drawer.innerHTML = '<div class="drawer-inner"><p role="status">Loading history...</p></div>'; void api.getHistory(Number(historyButton.dataset.listingId)).then((history) => renderHistory(drawer, history)).catch((error) => renderHistoryError(drawer, error instanceof Error ? error.message : 'Unable to load history')); } const next = target.closest<HTMLButtonElement>('#next-page'); if (next && state.cursor) { state = { ...state, filters: { ...state.filters, cursor: state.cursor } }; void search(); } });
drawer.addEventListener('click', (event) => { if ((event.target as HTMLElement).closest('#close-history')) drawer.hidden = true; });
void search();
