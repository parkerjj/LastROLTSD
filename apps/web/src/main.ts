import './styles.css';
import { MarketApi } from './api';
import { OptionDictionaryStore } from './option-state';
import { appendOptionRow, serializeSearchForm } from './query-form';
import { renderHistory, renderHistoryError, renderSearchResults } from './render';
import { SearchController } from './search-controller';
import { initialState } from './state';
import type { ItemAutocomplete, SearchFilters } from './types';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing app root');

const api = new MarketApi();
const dictionary = new OptionDictionaryStore(api);
const searchController = new SearchController(api);

root.innerHTML = `
  <header class="page-header">
    <div>
      <p class="eyebrow">LastRO</p>
      <h1>LastRO 市场</h1>
      <p class="subtitle">浏览当前在售商品和商店信息</p>
    </div>
    <span class="header-status">实时查询</span>
  </header>
  <section class="search-panel" aria-labelledby="search-title">
    <h2 id="search-title" class="sr-only">市场搜索</h2>
    <form id="search-form" aria-describedby="form-error">
      <div class="global-search">
        <label for="global-query">搜索物品、商店或玩家</label>
        <div class="autocomplete">
          <input id="global-query" name="q" role="combobox" aria-autocomplete="list" aria-controls="item-suggestions" aria-expanded="false" aria-describedby="search-help" autocomplete="off" placeholder="例如：波利" />
          <ul id="item-suggestions" class="suggestions" role="listbox" hidden></ul>
        </div>
        <p id="search-help" class="field-help">可搜索物品名称、商店名和玩家名。</p>
      </div>
      <div class="filters">
        <label for="item-id">物品 ID<input id="item-id" name="item_id" inputmode="numeric" type="number" min="1" /></label>
        <label for="price-min">最低价格<input id="price-min" name="price_min" inputmode="numeric" type="number" min="0" /></label>
        <label for="price-max">最高价格<input id="price-max" name="price_max" inputmode="numeric" type="number" min="0" /></label>
        <label for="map-name">地图<input id="map-name" name="map" /></label>
        <label for="shop-type">商店类型<select id="shop-type" name="shop_type"><option value="">全部</option><option value="sell">出售</option><option value="buy">收购</option></select></label>
      </div>
      <div id="option-dictionary-status" class="option-dictionary-status" role="status" aria-live="polite"></div>
      <fieldset id="option-fieldset" class="option-filters">
        <legend>词条条件</legend>
        <div class="option-mode" role="group" aria-label="词条匹配方式">
          <label><input type="radio" name="option_mode" value="all" checked />匹配全部</label>
          <label><input type="radio" name="option_mode" value="any" />匹配任一</label>
        </div>
        <div id="option-rows"></div>
        <button type="button" id="add-option" disabled aria-label="添加词条条件">添加词条条件</button>
      </fieldset>
      <p id="form-error" class="form-error" role="alert" hidden></p>
      <button type="submit" class="submit-button" aria-label="搜索">搜索</button>
    </form>
  </section>
  <section id="results" class="results" aria-live="polite" aria-atomic="true"></section>
  <aside id="history-drawer" role="dialog" aria-modal="true" aria-label="价格历史" hidden></aside>
`;

const form = root.querySelector<HTMLFormElement>('#search-form')!;
const results = root.querySelector<HTMLElement>('#results')!;
const optionRows = root.querySelector<HTMLElement>('#option-rows')!;
const optionFieldset = root.querySelector<HTMLFieldSetElement>('#option-fieldset')!;
const optionStatus = root.querySelector<HTMLElement>('#option-dictionary-status')!;
const addOptionButton = root.querySelector<HTMLButtonElement>('#add-option')!;
const formError = root.querySelector<HTMLElement>('#form-error')!;
const historyDrawer = root.querySelector<HTMLElement>('#history-drawer')!;
const queryInput = root.querySelector<HTMLInputElement>('#global-query')!;
const itemIdInput = root.querySelector<HTMLInputElement>('#item-id')!;
const suggestions = root.querySelector<HTMLUListElement>('#item-suggestions')!;

let autocompleteController: AbortController | undefined;
let autocompleteRequestId = 0;
let autocompleteItems: ItemAutocomplete[] = [];
let activeSuggestion = -1;

function renderSearchState(): void {
  const current = searchController.getState();
  renderSearchResults(results, current.page ?? { items: [], nextCursor: null }, current);
}

async function performSearch(filters: SearchFilters): Promise<void> {
  const pending = searchController.search(filters);
  renderSearchState();
  await pending;
  renderSearchState();
}

async function loadNextPage(): Promise<void> {
  const pending = searchController.nextPage();
  renderSearchState();
  await pending;
  renderSearchState();
}

function setFormError(message: string | null): void {
  formError.textContent = message ?? '';
  formError.hidden = !message;
}

function renderOptionDictionary(): void {
  const state = dictionary.getState();
  const ready = state.status === 'ready';
  optionFieldset.disabled = !ready;
  addOptionButton.disabled = !ready;
  optionStatus.replaceChildren();
  optionStatus.hidden = false;
  optionStatus.setAttribute('role', state.status === 'error' ? 'alert' : 'status');

  if (state.status === 'loading' || state.status === 'idle') {
    optionStatus.textContent = '正在加载词条字典...';
    return;
  }
  if (state.status === 'empty') {
    optionStatus.textContent = '暂无可用词条条件。';
    return;
  }
  if (state.status === 'error') {
    const message = document.createElement('span');
    message.textContent = state.error ?? '词条字典加载失败';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'inline-action';
    retry.textContent = '重试词条字典';
    retry.setAttribute('aria-label', '重试词条字典');
    retry.addEventListener('click', () => void retryOptionDictionary());
    optionStatus.append(message, retry);
    return;
  }
  optionStatus.hidden = true;
}

async function loadOptionDictionary(): Promise<void> {
  const pending = dictionary.load();
  renderOptionDictionary();
  await pending;
  renderOptionDictionary();
}

async function retryOptionDictionary(): Promise<void> {
  const pending = dictionary.retry();
  renderOptionDictionary();
  await pending;
  renderOptionDictionary();
}

function hideSuggestions(): void {
  autocompleteItems = [];
  activeSuggestion = -1;
  suggestions.replaceChildren();
  suggestions.hidden = true;
  queryInput.setAttribute('aria-expanded', 'false');
  queryInput.removeAttribute('aria-activedescendant');
}

function updateSuggestionSelection(): void {
  const options = Array.from(suggestions.querySelectorAll<HTMLElement>('[role="option"]'));
  options.forEach((option, index) => {
    const selected = index === activeSuggestion;
    option.setAttribute('aria-selected', String(selected));
    if (selected) queryInput.setAttribute('aria-activedescendant', option.id);
  });
  if (activeSuggestion < 0) queryInput.removeAttribute('aria-activedescendant');
}

function chooseSuggestion(index: number): void {
  const item = autocompleteItems[index];
  if (!item) return;
  itemIdInput.value = String(item.itemId);
  hideSuggestions();
  queryInput.focus();
}

function renderSuggestions(items: ItemAutocomplete[]): void {
  autocompleteItems = items;
  activeSuggestion = -1;
  suggestions.replaceChildren();
  items.forEach((item, index) => {
    const option = document.createElement('li');
    option.id = `item-suggestion-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.tabIndex = -1;
    const name = document.createElement('strong');
    name.textContent = item.name;
    const itemId = document.createElement('small');
    itemId.textContent = `物品 ID：${item.itemId}`;
    option.append(name, itemId);
    option.addEventListener('click', () => chooseSuggestion(index));
    suggestions.append(option);
  });
  suggestions.hidden = items.length === 0;
  queryInput.setAttribute('aria-expanded', String(items.length > 0));
}

async function loadSuggestions(query: string): Promise<void> {
  autocompleteController?.abort();
  const controller = new AbortController();
  autocompleteController = controller;
  const requestId = ++autocompleteRequestId;
  const normalized = query.trim();
  if (!normalized) {
    hideSuggestions();
    return;
  }
  try {
    const page = await api.getItems(normalized, controller.signal);
    if (controller.signal.aborted || requestId !== autocompleteRequestId) return;
    renderSuggestions(page.items);
  } catch {
    if (controller.signal.aborted || requestId !== autocompleteRequestId) return;
    renderSuggestions([]);
  }
}

async function openHistory(listingId: number): Promise<void> {
  historyDrawer.hidden = false;
  historyDrawer.innerHTML = '<div class="drawer-inner"><p role="status">正在加载历史...</p></div>';
  try {
    const history = await api.getHistory(listingId);
    renderHistory(historyDrawer, history, listingId);
  } catch (error) {
    renderHistoryError(historyDrawer, error instanceof Error ? error.message : '历史加载失败');
  }
}

function closeHistory(): void {
  historyDrawer.hidden = true;
}

queryInput.addEventListener('input', () => {
  itemIdInput.value = '';
  void loadSuggestions(queryInput.value);
});

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && autocompleteItems.length > 0) {
    event.preventDefault();
    activeSuggestion = (activeSuggestion + 1) % autocompleteItems.length;
    updateSuggestionSelection();
  } else if (event.key === 'ArrowUp' && autocompleteItems.length > 0) {
    event.preventDefault();
    activeSuggestion = (activeSuggestion - 1 + autocompleteItems.length) % autocompleteItems.length;
    updateSuggestionSelection();
  } else if (event.key === 'Enter' && activeSuggestion >= 0) {
    event.preventDefault();
    chooseSuggestion(activeSuggestion);
  } else if (event.key === 'Escape') {
    hideSuggestions();
  }
});

addOptionButton.addEventListener('click', () => {
  const state = dictionary.getState();
  if (state.status === 'ready') appendOptionRow(optionRows, state.definitions);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const filters = serializeSearchForm(form, dictionary.getState().definitions);
    setFormError(null);
    hideSuggestions();
    void performSearch(filters);
  } catch (error) {
    setFormError(error instanceof Error ? error.message : '请检查搜索条件');
  }
});

results.addEventListener('click', (event) => {
  const target = event.target as Element;
  const historyButton = target.closest<HTMLButtonElement>('.history-button');
  if (historyButton) {
    const listingId = Number(historyButton.dataset.listingId);
    if (Number.isSafeInteger(listingId)) void openHistory(listingId);
    return;
  }
  if (target.closest<HTMLButtonElement>('#next-page')) void loadNextPage();
});

historyDrawer.addEventListener('click', (event) => {
  const target = event.target as Element;
  if (target.closest('#close-history')) {
    closeHistory();
    return;
  }
  const next = target.closest<HTMLButtonElement>('#next-history');
  if (!next) return;
  const listingId = Number(next.dataset.listingId);
  const cursor = next.dataset.cursor;
  if (!Number.isSafeInteger(listingId) || !cursor) return;
  historyDrawer.innerHTML = '<div class="drawer-inner"><p role="status">正在加载历史...</p></div>';
  void api.getHistory(listingId, cursor)
    .then((history) => renderHistory(historyDrawer, history, listingId))
    .catch((error) => renderHistoryError(historyDrawer, error instanceof Error ? error.message : '历史加载失败'));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !suggestions.hidden) hideSuggestions();
  else if (event.key === 'Escape' && !historyDrawer.hidden) closeHistory();
});

renderOptionDictionary();
renderSearchState();
void loadOptionDictionary();
void performSearch(initialState.filters);
