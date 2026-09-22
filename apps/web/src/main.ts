import './styles.css';
import { MarketApi } from './api';
import { OptionDictionaryStore } from './option-state';
import { appendOptionRow, serializeSearchForm } from './query-form';
import { friendlyError, renderHistory, renderHistoryError, renderSearchResultsWithCatalog, rmsAssetUrl } from './render';
import { mapFilterOptions } from './maps';
import { SearchController } from './search-controller';
import { initialState } from './state';
import type { ItemAutocomplete, ItemDescription, SearchFilters } from './types';
import { createCatalogLoader, createDescriptionLoader, findCatalogMatches } from './catalog';
import { mountReleasePage } from './release-page';

const root = document.querySelector<HTMLElement>('#app')!;
if (!root) throw new Error('Missing app root');

const isReleasePage = /^\/updates\/?$/u.test(window.location.pathname);
const mapFilterMarkup = mapFilterOptions().map((map) => `<option value="${map.value}">${map.label}</option>`).join('');

function mountSearchPage(): void {
const api = new MarketApi();
const dictionary = new OptionDictionaryStore(api);
const searchController = new SearchController(api);

root.innerHTML = `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="#top" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      <nav class="site-nav" aria-label="主导航"><a class="active" href="#search">搜索市场</a><a href="/updates">更新说明</a><a href="https://github.com/parkerjj/LastROLTSD" target="_blank" rel="noreferrer">代码仓库</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></nav>
    </div>
  </header>
  <main id="top" class="page-width">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy"><p class="eyebrow">露天市场 / 交易索引</p><h1 id="page-title">露天商店<span>.Ro</span></h1><p class="hero-subtitle">在四座城市之间，找到你要的装备与词条。</p><div class="hero-meta"><span><i class="status-dot"></i>市场数据在线</span><span>更新于今日</span><span>支持四城地图定位</span></div></div>
    </section>
    <section id="site-notice" class="site-notice" aria-label="站点公告">
      <span class="notice-badge">公告</span>
      <div class="notice-body"><p>本站刚刚新建，正在持续优化与扩充功能。如有建议或反馈，欢迎加入 QQ 交流群：<button type="button" id="copy-qq-group" class="notice-copy" data-copy="725955796" aria-label="复制QQ群号 725955796"><span class="qq-number">725955796</span><span class="copy-hint" aria-hidden="true">复制</span></button></p></div>
    </section>
    <section id="search" class="search-panel" aria-labelledby="search-title">
      <div class="section-heading"><div><p class="eyebrow">市场搜索</p><h2 id="search-title">搜索市场</h2></div><p>名称、描述、商店与玩家会按命中位置自动分组。</p></div>
      <form id="search-form" aria-describedby="form-error">
        <div class="search-command">
          <div class="global-search"><label for="global-query">搜索关键词</label><div class="autocomplete"><input id="global-query" name="q" role="combobox" aria-autocomplete="list" aria-controls="item-suggestions" aria-expanded="false" aria-describedby="search-help" autocomplete="off" placeholder="例如：波利卡片、深红之弓、蓝宝石、赏金" /><ul id="item-suggestions" class="suggestions" role="listbox" hidden></ul></div><p id="search-help" class="field-help">名称、描述、商店标题和玩家名称都可以搜索。</p></div>
          <div class="search-command-actions">
            <button type="submit" class="submit-button" aria-label="搜索市场">搜索市场 <span aria-hidden="true">→</span></button>
            <button type="button" class="search-toggle" data-panel="advanced-filters" aria-controls="advanced-filters" aria-expanded="false" aria-pressed="false"><span aria-hidden="true">＋</span>高级搜索</button>
            <button type="button" class="search-toggle" data-panel="option-search-panel" aria-controls="option-search-panel" aria-expanded="false" aria-pressed="false"><span aria-hidden="true">＋</span>词条搜索</button>
          </div>
        </div>
        <div id="advanced-filters" class="search-reveal advanced-filters" hidden><div class="reveal-heading"><div><strong>高级搜索</strong><span>缩小价格、地图和商店类型范围</span></div><span class="reveal-caption">可选</span></div><div class="filters"><label for="price-max">最高价格<input id="price-max" name="price_max" inputmode="numeric" type="number" min="0" placeholder="不限" /></label><label for="map-name">地图<select id="map-name" name="map"><option value="">全部</option>${mapFilterMarkup}</select></label><label for="shop-type">商店类型<select id="shop-type" name="shop_type"><option value="">全部类型</option><option value="sell">出售</option><option value="buy">收购</option></select></label></div></div>
        <div id="option-search-panel" class="search-reveal option-search-panel" hidden><div id="option-dictionary-status" class="option-dictionary-status" role="status" aria-live="polite"></div><fieldset id="option-fieldset" class="option-filters"><legend>词条搜索与过滤</legend><div class="option-heading"><p>添加词条条件，筛选精炼、卡片与装备属性。</p><div class="option-mode" role="group" aria-label="词条匹配方式"><label><input type="radio" name="option_mode" value="all" checked />全部满足</label><label><input type="radio" name="option_mode" value="any" />满足任一</label></div></div><div id="option-rows"></div><button type="button" id="add-option" class="secondary-button" disabled aria-label="添加词条条件">＋ 添加词条条件</button></fieldset></div>
        <p id="form-error" class="form-error" role="alert" hidden></p>
      </form>
    </section>
    <section id="results" class="results" aria-live="polite" aria-atomic="true"></section>
  </main>
  <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="#top"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="#search">搜索市场</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  <aside id="history-drawer" class="drawer" role="dialog" aria-modal="true" aria-label="价格历史" hidden></aside>
  <aside id="map-drawer" class="drawer map-drawer" role="dialog" aria-modal="true" aria-label="地图定位" hidden></aside>
`;

const form = root.querySelector<HTMLFormElement>('#search-form')!;
const results = root.querySelector<HTMLElement>('#results')!;
const optionRows = root.querySelector<HTMLElement>('#option-rows')!;
const optionFieldset = root.querySelector<HTMLFieldSetElement>('#option-fieldset')!;
const optionStatus = root.querySelector<HTMLElement>('#option-dictionary-status')!;
const addOptionButton = root.querySelector<HTMLButtonElement>('#add-option')!;
const formError = root.querySelector<HTMLElement>('#form-error')!;
const historyDrawer = root.querySelector<HTMLElement>('#history-drawer')!;
const mapDrawer = root.querySelector<HTMLElement>('#map-drawer')!;
const queryInput = root.querySelector<HTMLInputElement>('#global-query')!;
const suggestions = root.querySelector<HTMLUListElement>('#item-suggestions')!;
const searchToggles = Array.from(root.querySelectorAll<HTMLButtonElement>('.search-toggle'));
const copyQqGroupButton = root.querySelector<HTMLButtonElement>('#copy-qq-group')!;

let copyHintTimer: number | undefined;
copyQqGroupButton.addEventListener('click', async () => {
  const qqGroup = copyQqGroupButton.dataset.copy ?? '';
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(qqGroup);
      copied = true;
    }
  } catch {
    // Clipboard API 不可用（权限或非安全上下文）时使用降级方案。
  }
  if (!copied) {
    try {
      const fallback = document.createElement('input');
      fallback.value = qqGroup;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
      copied = true;
    } catch {
      copied = false;
    }
  }
  const hint = copyQqGroupButton.querySelector('.copy-hint');
  if (copied && hint) {
    hint.textContent = '已复制';
    window.clearTimeout(copyHintTimer);
    copyHintTimer = window.setTimeout(() => { if (hint) hint.textContent = '复制'; }, 1800);
  } else if (!copied) {
    copyQqGroupButton.setAttribute('aria-label', `QQ群号 ${qqGroup}，请手动复制`);
  }
});

let autocompleteRequestId = 0;
let autocompleteItems: ItemAutocomplete[] = [];
let catalogItems: ItemAutocomplete[] = [];
let itemDescriptions: ItemDescription[] = [];
let itemDescriptionError: string | null = null;
const loadCatalog = createCatalogLoader();
const loadItemDescriptions = createDescriptionLoader();
let activeSuggestion = -1;

function renderSearchState(): void {
  const current = searchController.getState();
  renderSearchResultsWithCatalog(results, current.page ?? { items: [], nextCursor: null }, { ...current, descriptionError: itemDescriptionError }, catalogItems, itemDescriptions);
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
  if (state.status === 'loading' || state.status === 'idle') { optionStatus.textContent = '正在加载词条字典...'; return; }
  if (state.status === 'empty') { optionStatus.textContent = '暂无可用词条条件。'; return; }
  if (state.status === 'error') {
    const message = document.createElement('span'); message.textContent = friendlyError(state.error, '词条字典接口暂不可用，请确认本地服务已启动。');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'inline-action'; retry.textContent = '重试词条字典'; retry.setAttribute('aria-label', '重试词条字典'); retry.addEventListener('click', () => void retryOptionDictionary());
    optionStatus.append(message, retry); return;
  }
  optionStatus.hidden = true;
  if (optionRows.querySelectorAll('[data-option-row]').length === 0) appendOptionRow(optionRows, state.definitions);
}

async function loadOptionDictionary(): Promise<void> { const pending = dictionary.load(); renderOptionDictionary(); await pending; renderOptionDictionary(); }
async function retryOptionDictionary(): Promise<void> { const pending = dictionary.retry(); renderOptionDictionary(); await pending; renderOptionDictionary(); }

function hideSuggestions(): void { autocompleteItems = []; activeSuggestion = -1; suggestions.replaceChildren(); suggestions.hidden = true; queryInput.setAttribute('aria-expanded', 'false'); queryInput.removeAttribute('aria-activedescendant'); }

function updateSuggestionSelection(): void {
  const options = Array.from(suggestions.querySelectorAll<HTMLElement>('[role="option"]'));
  options.forEach((option, index) => { const selected = index === activeSuggestion; option.setAttribute('aria-selected', String(selected)); if (selected) queryInput.setAttribute('aria-activedescendant', option.id); });
  if (activeSuggestion < 0) queryInput.removeAttribute('aria-activedescendant');
}

function chooseSuggestion(index: number): void { const item = autocompleteItems[index]; if (!item) return; queryInput.value = item.name; hideSuggestions(); queryInput.focus(); }

function renderSuggestions(items: ItemAutocomplete[]): void {
  autocompleteItems = items; activeSuggestion = -1; suggestions.replaceChildren();
  items.forEach((item, index) => { const option = document.createElement('li'); option.id = `item-suggestion-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.tabIndex = -1; const name = document.createElement('strong'); name.textContent = item.name; const itemId = document.createElement('small'); itemId.textContent = `物品 ID：${item.itemId}`; option.append(name, itemId); option.addEventListener('click', () => chooseSuggestion(index)); suggestions.append(option); });
  suggestions.hidden = items.length === 0; queryInput.setAttribute('aria-expanded', String(items.length > 0));
}

async function loadSuggestions(query: string): Promise<void> {
  const requestId = ++autocompleteRequestId;
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
  if (!normalized) { hideSuggestions(); return; }
  try {
    const page = await loadCatalog();
    catalogItems = page.items;
    if (requestId !== autocompleteRequestId) return;
    renderSuggestions(findCatalogMatches(page.items, normalized));
  } catch { if (requestId === autocompleteRequestId) renderSuggestions([]); }
}

async function openHistory(listingId: number): Promise<void> {
  historyDrawer.hidden = false; historyDrawer.innerHTML = '<div class="drawer-inner"><p role="status">正在加载价格历史...</p></div>';
  try { renderHistory(historyDrawer, await api.getHistory(listingId), listingId); }
  catch (error) {
    renderHistoryError(historyDrawer, friendlyError(error, '价格历史接口暂不可用，请确认本地服务已启动。'));
  }
}

function closeHistory(): void { historyDrawer.hidden = true; }

function openMap(button: HTMLButtonElement): void {
  const name = button.dataset.mapName || '未知地图'; const image = button.dataset.mapImage || rmsAssetUrl('maps_xl/morocc_re.gif'); const code = button.dataset.mapCode || 'morocc'; const rawX = Number(button.dataset.mapX); const rawY = Number(button.dataset.mapY); const rawLeft = Number(button.dataset.mapMarkerLeft); const rawTop = Number(button.dataset.mapMarkerTop); const x = Number.isFinite(rawX) ? rawX : 50; const y = Number.isFinite(rawY) ? rawY : 50; const left = Number.isFinite(rawLeft) ? rawLeft : 50; const top = Number.isFinite(rawTop) ? rawTop : 50;
  mapDrawer.innerHTML = `<div class="drawer-inner map-inner"><button type="button" id="close-map" aria-label="关闭地图">关闭</button><p class="drawer-kicker">地图定位 / ${code}</p><h2>${name}</h2><p class="map-coordinates">商人坐标：${x}，${y}</p><div class="map-frame"><img src="${image}" alt="${name}地图" /><span class="map-star" style="left:${left}%;top:${top}%" aria-label="商人位置">★</span></div><p class="map-note">星标为当前商人位置，坐标来自市场记录。</p></div>`;
  mapDrawer.hidden = false;
}

function closeMap(): void { mapDrawer.hidden = true; }

function setSearchPanel(toggle: HTMLButtonElement, open: boolean): void {
  const panelId = toggle.dataset.panel;
  if (!panelId) return;
  const panel = form.querySelector<HTMLElement>(`#${panelId}`);
  if (!panel) return;
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-pressed', String(open));
  toggle.classList.toggle('is-active', open);
  const marker = toggle.querySelector<HTMLElement>('[aria-hidden="true"]');
  if (marker) marker.textContent = open ? '−' : '＋';
}

searchToggles.forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    setSearchPanel(toggle, !expanded);
  });
});

queryInput.addEventListener('input', () => { void loadSuggestions(queryInput.value); });
queryInput.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' && autocompleteItems.length > 0) { event.preventDefault(); activeSuggestion = (activeSuggestion + 1) % autocompleteItems.length; updateSuggestionSelection(); } else if (event.key === 'ArrowUp' && autocompleteItems.length > 0) { event.preventDefault(); activeSuggestion = (activeSuggestion - 1 + autocompleteItems.length) % autocompleteItems.length; updateSuggestionSelection(); } else if (event.key === 'Enter' && activeSuggestion >= 0) { event.preventDefault(); chooseSuggestion(activeSuggestion); } else if (event.key === 'Escape') hideSuggestions(); });
addOptionButton.addEventListener('click', () => { const state = dictionary.getState(); if (state.status === 'ready') appendOptionRow(optionRows, state.definitions); });
form.addEventListener('submit', (event) => { event.preventDefault(); void (async () => { try { const catalog = await loadCatalog(); catalogItems = catalog.items; const filters = serializeSearchForm(form, dictionary.getState().definitions, catalog.items); setFormError(null); hideSuggestions(); void performSearch(filters); } catch (error) { setFormError(error instanceof Error ? error.message : '请检查搜索条件'); } })(); });

results.addEventListener('click', (event) => {
  const target = event.target as Element;
  const historyButton = target.closest<HTMLButtonElement>('.history-button');
  if (historyButton) { const listingId = Number(historyButton.dataset.listingId); if (Number.isSafeInteger(listingId)) void openHistory(listingId); return; }
  const mapButton = target.closest<HTMLButtonElement>('.map-button');
  if (mapButton) { openMap(mapButton); return; }
  const groupToggle = target.closest<HTMLButtonElement>('.group-toggle');
  if (groupToggle) { const body = document.getElementById(groupToggle.getAttribute('aria-controls') ?? ''); const expanded = groupToggle.getAttribute('aria-expanded') === 'true'; groupToggle.setAttribute('aria-expanded', String(!expanded)); body?.toggleAttribute('hidden', expanded); return; }
  if (target.closest<HTMLButtonElement>('#next-page')) void loadNextPage();
});
results.addEventListener('error', (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.hasAttribute('data-image-fallback')) return;
  image.hidden = true;
  image.parentElement?.querySelector<HTMLElement>('.item-icon-fallback, .detail-art-fallback')?.removeAttribute('hidden');
}, true);

historyDrawer.addEventListener('click', (event) => { const target = event.target as Element; if (target.closest('#close-history')) { closeHistory(); return; } const next = target.closest<HTMLButtonElement>('#next-history'); if (!next) return; const listingId = Number(next.dataset.listingId); const cursor = next.dataset.cursor; if (!Number.isSafeInteger(listingId) || !cursor) return; historyDrawer.innerHTML = '<div class="drawer-inner"><p role="status">正在加载更多历史...</p></div>'; void api.getHistory(listingId, cursor).then((history) => renderHistory(historyDrawer, history, listingId)).catch((error) => renderHistoryError(historyDrawer, friendlyError(error, '价格历史接口暂不可用，请确认本地服务已启动。'))); });
mapDrawer.addEventListener('click', (event) => { if ((event.target as Element).closest('#close-map')) closeMap(); });
document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (!suggestions.hidden) hideSuggestions(); else if (!historyDrawer.hidden) closeHistory(); else if (!mapDrawer.hidden) closeMap(); });

renderOptionDictionary();
renderSearchState();
void loadOptionDictionary();
void loadCatalog().then((catalog) => { catalogItems = catalog.items; renderSearchState(); }).catch(() => undefined);
void Promise.resolve().then(() => loadItemDescriptions()).then((payload) => {
  itemDescriptions = payload.descriptions;
  itemDescriptionError = null;
  renderSearchState();
}).catch((error: unknown) => {
  itemDescriptionError = error instanceof Error ? error.message : 'unknown error';
  console.warn('[catalog] item descriptions failed to load', error);
  renderSearchState();
});
void performSearch(initialState.filters);
}

if (isReleasePage) mountReleasePage(root);
else mountSearchPage();
