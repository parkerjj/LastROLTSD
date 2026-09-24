import { MarketApi, type MarketApiClient } from './api';
import { createCatalogLoader, createDescriptionLoader, findCatalogMatches } from './catalog';
import { cleanItemDescription, rmsAssetUrl } from './render';
import type { GuestbookCategory, GuestbookEntry, GuestbookFilters, GuestbookSubmissionInput, ItemAutocomplete, ItemDescription } from './types';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

interface KindStyle {
  readonly label: string;
  readonly icon: string;
}

const kindStyles: Record<GuestbookCategory, KindStyle> = {
  buy: { label: '我要收购', icon: 'ph-hand-coins' },
  sell: { label: '我要出售', icon: 'ph-storefront' },
  suggestion: { label: '网站建议', icon: 'ph-chat-centered-text' },
};

type EntryCatalog = ReadonlyMap<number, ItemAutocomplete>;
type EntryDescriptions = ReadonlyMap<number, ItemDescription>;
type GuestbookTab = '' | GuestbookCategory;

function itemIconUrl(itemId: number, itemName: string): string {
  const file = itemName.endsWith('卡片') ? 'card' : String(itemId);
  return rmsAssetUrl(`items/large/${encodeURIComponent(file)}.gif`);
}

function entryMarkup(entry: GuestbookEntry, catalog: EntryCatalog, descriptions: EntryDescriptions): string {
  const catalogItem = entry.itemId === null ? undefined : catalog.get(entry.itemId);
  const itemName = entry.isZeny ? 'Zeny 游戏币' : catalogItem?.name ?? '目录道具';
  const itemDescription = entry.itemId === null ? '' : cleanItemDescription(descriptions.get(entry.itemId)?.description ?? '');
  const expiry = entry.expiresAt === null ? '永久有效' : `截止 ${new Date(entry.expiresAt).toLocaleString('zh-CN')}`;
  const kind = kindStyles[entry.category];
  const itemCells = entry.category === 'suggestion' ? '' : `
      <span class="guestbook-item-thumb">${entry.isZeny ? '<span class="guestbook-zeny-glyph" aria-hidden="true">Z</span>' : `<img src="${escapeHtml(itemIconUrl(entry.itemId ?? 0, itemName))}" alt="" loading="lazy" data-item-image>`}</span>
      <span class="guestbook-item-meta"><span class="guestbook-item-idline"><strong class="guestbook-item-name">${escapeHtml(itemName)}</strong></span><span class="guestbook-item-id">${entry.isZeny ? '游戏货币' : `ItemID ${entry.itemId}`}</span>${itemDescription ? `<span class="guestbook-item-description">${escapeHtml(itemDescription)}</span>` : '<span class="guestbook-item-description is-muted">目录暂无详细描述</span>'}</span>`;
  return `<article class="guestbook-entry guestbook-entry--${entry.category}${entry.isExpired ? ' is-expired' : ''}" data-entry-id="${entry.id}">
    <div class="guestbook-entry-bar"><span class="guestbook-entry-kind"><i class="ph ${kind.icon}" aria-hidden="true"></i>${kind.label}</span><span class="guestbook-entry-bar-meta"><time datetime="${new Date(entry.createdAt).toISOString()}">${new Date(entry.createdAt).toLocaleString('zh-CN')}</time>${entry.isExpired ? '<span class="guestbook-expired-stamp" aria-label="此留言已过期">已过期</span>' : ''}</span></div>
    <div class="guestbook-entry-row${entry.category === 'suggestion' ? ' guestbook-entry-row--suggestion' : ''}">${itemCells}
      <p class="guestbook-content">${escapeHtml(entry.content)}</p>
    </div>
    <footer class="guestbook-entry-footer">${entry.contact ? `<span class="guestbook-contact"><i class="ph ph-identification-card" aria-hidden="true"></i>${escapeHtml(entry.contact)}</span>` : '<span class="guestbook-footer-spacer"></span>'}<span class="guestbook-entry-expiry"><i class="ph ph-clock" aria-hidden="true"></i>${escapeHtml(entry.category === 'suggestion' ? '匿名发布' : expiry)}</span></footer>
  </article>`;
}

export function mountGuestbookPage(root: HTMLElement, api: MarketApiClient = new MarketApi()): void {
  document.title = '玩家登记簿 · 露天商店.Ro';
  root.innerHTML = `
    <header class="site-header"><div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      <nav class="site-nav" aria-label="主导航"><a href="/#search">搜索市场</a><a class="active" href="/guestbook" aria-current="page">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://github.com/parkerjj/LastROLTSD" target="_blank" rel="noreferrer">代码仓库</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></nav>
    </div></header>
    <main class="guestbook-main page-width">
      <section class="guestbook-intro"><div><p class="eyebrow">露天市场 / 玩家交流</p><h1>玩家登记簿</h1><p>发布收购、出售或给网站的建议，让市场里的每一份需求都能被看见。</p></div><span class="guestbook-ledger-mark" aria-hidden="true">No. 01<br><strong>公开登记</strong></span></section>
      <section class="guestbook-compose" aria-labelledby="guestbook-compose-title">
        <div class="section-heading"><div><p class="eyebrow">发布一则登记</p><h2 id="guestbook-compose-title">写下你的需求</h2></div><p>无需登录，提交后会立即公开显示。</p></div>
        <form id="guestbook-form" class="guestbook-form" aria-describedby="guestbook-form-status">
          <fieldset class="guestbook-kind-select"><legend>登记类别</legend><label><input type="radio" name="category" value="buy" checked><span><i class="ph ph-hand-coins" aria-hidden="true"></i>收购</span></label><label><input type="radio" name="category" value="sell"><span><i class="ph ph-storefront" aria-hidden="true"></i>出售</span></label><label><input type="radio" name="category" value="suggestion"><span><i class="ph ph-chat-centered-text" aria-hidden="true"></i>网站建议</span></label></fieldset>
          <div id="guestbook-trade-fields" class="guestbook-trade-fields">
            <fieldset class="guestbook-item-choice"><legend>交易物品</legend><div id="guestbook-item-picker" class="autocomplete"><input id="guestbook-item-query" role="combobox" aria-autocomplete="list" aria-controls="guestbook-item-suggestions" aria-expanded="false" autocomplete="off" placeholder="输入道具名称搜索" aria-label="搜索并选择道具" /><ul id="guestbook-item-suggestions" class="suggestions" role="listbox" hidden></ul></div><p id="guestbook-item-selected" class="field-help">请选择道具或 Zeny。</p></fieldset>
            <label for="guestbook-contact">联系方式<input id="guestbook-contact" maxlength="120" placeholder="微信、QQ 号或游戏角色名" required></label>
            <label for="guestbook-duration">有效期限<select id="guestbook-duration" required><option value="1d">1 天</option><option value="3d">3 天</option><option value="7d">7 天</option><option value="permanent">永久</option></select></label>
          </div>
          <label for="guestbook-content">详细内容<textarea id="guestbook-content" maxlength="2000" rows="4" required placeholder="写下物品数量、价格范围或你的建议"></textarea><span class="guestbook-count"><span id="guestbook-content-count">0</span> / 2000</span></label>
          <div class="guestbook-form-actions"><p id="guestbook-form-status" role="status" aria-live="polite"></p><button type="submit" id="guestbook-submit"><i class="ph ph-paper-plane-tilt" aria-hidden="true"></i> 发布登记</button></div>
        </form>
      </section>
      <section class="guestbook-list-section" aria-labelledby="guestbook-list-title"><div class="section-heading"><div><p class="eyebrow">公开登记</p><h2 id="guestbook-list-title">玩家留言</h2></div><p>收购与出售记录到期后仍会保留，并标注过期状态。</p></div>
        <div id="guestbook-tabs" class="guestbook-tabs" role="tablist" aria-label="按类别筛选登记"><button class="guestbook-tab guestbook-tab--all is-active" role="tab" aria-selected="true" aria-controls="guestbook-results" data-tab=""><i class="ph ph-rows" aria-hidden="true"></i><span>全部</span></button><button class="guestbook-tab guestbook-tab--buy" role="tab" aria-selected="false" aria-controls="guestbook-results" data-tab="buy"><i class="ph ph-hand-coins" aria-hidden="true"></i><span>收购</span></button><button class="guestbook-tab guestbook-tab--sell" role="tab" aria-selected="false" aria-controls="guestbook-results" data-tab="sell"><i class="ph ph-storefront" aria-hidden="true"></i><span>出售</span></button><button class="guestbook-tab guestbook-tab--other" role="tab" aria-selected="false" aria-controls="guestbook-results" data-tab="suggestion"><i class="ph ph-chat-centered-text" aria-hidden="true"></i><span>其他</span></button></div>
        <form id="guestbook-search" class="guestbook-search"><label for="guestbook-search-q">关键词<input id="guestbook-search-q" placeholder="搜索正文或联系方式"></label><div class="autocomplete"><label for="guestbook-filter-item">道具筛选<input id="guestbook-filter-item" role="combobox" aria-autocomplete="list" aria-controls="guestbook-filter-suggestions" aria-expanded="false" autocomplete="off" placeholder="全部道具"></label><ul id="guestbook-filter-suggestions" class="suggestions" role="listbox" hidden></ul></div><button type="submit"><i class="ph ph-magnifying-glass" aria-hidden="true"></i> 搜索</button><button id="guestbook-clear-filter" class="secondary-button" type="button" aria-label="清除筛选"><i class="ph ph-x" aria-hidden="true"></i></button></form>
        <div id="guestbook-results" class="guestbook-results" aria-live="polite" aria-busy="false"></div><div class="guestbook-pager"><button id="guestbook-prev" class="secondary-button" type="button" disabled><i class="ph ph-arrow-left" aria-hidden="true"></i> 上一页</button><span id="guestbook-page-status">第 1 页</span><button id="guestbook-next" class="secondary-button" type="button" disabled>下一页 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div>
      </section>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>`;

  const form = root.querySelector<HTMLFormElement>('#guestbook-form')!;
  const tradeFields = root.querySelector<HTMLElement>('#guestbook-trade-fields')!;
  const content = root.querySelector<HTMLTextAreaElement>('#guestbook-content')!;
  const contentCount = root.querySelector<HTMLElement>('#guestbook-content-count')!;
  const status = root.querySelector<HTMLElement>('#guestbook-form-status')!;
  const submit = root.querySelector<HTMLButtonElement>('#guestbook-submit')!;
  const itemQuery = root.querySelector<HTMLInputElement>('#guestbook-item-query')!;
  const itemSuggestions = root.querySelector<HTMLUListElement>('#guestbook-item-suggestions')!;
  const selectedHelp = root.querySelector<HTMLElement>('#guestbook-item-selected')!;
  const searchForm = root.querySelector<HTMLFormElement>('#guestbook-search')!;
  const tabButtons = () => [...root.querySelectorAll<HTMLButtonElement>('.guestbook-tab')];
  const results = root.querySelector<HTMLElement>('#guestbook-results')!;
  const prev = root.querySelector<HTMLButtonElement>('#guestbook-prev')!;
  const next = root.querySelector<HTMLButtonElement>('#guestbook-next')!;
  const pageStatus = root.querySelector<HTMLElement>('#guestbook-page-status')!;
  const loadCatalog = createCatalogLoader();
  const loadDescriptions = createDescriptionLoader();
  let catalog: ItemAutocomplete[] = [];
  let descriptions: ItemDescription[] = [];
  let catalogById: EntryCatalog = new Map();
  let descriptionsById: EntryDescriptions = new Map();
  let selectedItem: ItemAutocomplete | null = null;
  let activeIndex = -1;
  let pageIndex = 0;
  let pageCursors: Array<string | null> = [null];
  let nextCursor: string | null = null;
  let currentFilters: GuestbookFilters = { limit: 20 };

  const syncTabs = (tab: GuestbookTab): void => {
    tabButtons().forEach((button) => {
      const active = (button.dataset.tab ?? '') === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
  };

  const categoryInput = (): GuestbookCategory => form.querySelector<HTMLInputElement>('input[name="category"]:checked')!.value as GuestbookCategory;
  const setKind = (): void => { const suggestion = categoryInput() === 'suggestion'; tradeFields.hidden = suggestion; tradeFields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach((field) => { field.disabled = suggestion; field.required = !suggestion && field.id !== 'guestbook-item-query'; }); if (suggestion) { selectedItem = null; itemQuery.value = ''; } };
  const hideSuggestions = (): void => { itemSuggestions.hidden = true; itemQuery.setAttribute('aria-expanded', 'false'); activeIndex = -1; };
  const renderSuggestions = (items: ItemAutocomplete[]): void => {
    const zenyMarkup = `<li><button type="button" role="option" aria-selected="${activeIndex === 0}" data-zeny="true"><i class="ph ph-coins" aria-hidden="true"></i> Zeny 游戏币 <small>特殊交易项</small></button></li>`;
    itemSuggestions.innerHTML = `${zenyMarkup}${items.map((item, index) => `<li><button type="button" role="option" aria-selected="${index + 1 === activeIndex}" data-index="${index}">${escapeHtml(item.name)}</button></li>`).join('')}`;
    itemSuggestions.hidden = false;
    itemQuery.setAttribute('aria-expanded', 'true');
  };
  const chooseItem = (item: ItemAutocomplete): void => { selectedItem = item; itemQuery.value = item.name; selectedHelp.textContent = `已选择：${item.name} · ItemID ${item.itemId}`; hideSuggestions(); };
  const chooseZeny = (): void => { selectedItem = null; itemQuery.value = 'Zeny 游戏币'; selectedHelp.textContent = '已选择：Zeny 游戏币'; hideSuggestions(); };

  form.querySelectorAll<HTMLInputElement>('input[name="category"]').forEach((input) => input.addEventListener('change', setKind));
  setKind();
  content.addEventListener('input', () => { contentCount.textContent = String([...content.value].length); });
  itemQuery.addEventListener('input', async () => {
    selectedItem = null;
    activeIndex = -1;
    selectedHelp.textContent = '请从搜索结果中选择道具或 Zeny。';
    try { catalog = (await loadCatalog()).items; catalogById = new Map(catalog.map((item) => [item.itemId, item])); renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); } catch { renderSuggestions([]); }
  });
  itemQuery.addEventListener('focus', () => {
    if (!itemSuggestions.hidden) return;
    void loadCatalog().then((page) => { catalog = page.items; catalogById = new Map(catalog.map((item) => [item.itemId, item])); renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); }).catch(() => renderSuggestions([]));
  });
  itemQuery.addEventListener('keydown', (event) => {
    const options = [...itemSuggestions.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    if (event.key === 'Escape') hideSuggestions();
    else if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); activeIndex = (activeIndex + 1) % options.length; renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); activeIndex = (activeIndex - 1 + options.length) % options.length; renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); }
    else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      if (activeIndex === 0) { chooseZeny(); return; }
      const item = findCatalogMatches(catalog, itemQuery.value)[activeIndex - 1];
      if (item) chooseItem(item);
    }
  });
  itemSuggestions.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="option"]'); if (!button) return; if (button.dataset.zeny) { chooseZeny(); return; } const item = findCatalogMatches(catalog, itemQuery.value)[Number(button.dataset.index)]; if (item) chooseItem(item); });

  async function loadPage(cursor?: string): Promise<void> {
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<div class="guestbook-state"><span class="guestbook-skeleton"></span><span class="guestbook-skeleton"></span></div>';
    try {
      const page = await api.searchGuestbook({ ...currentFilters, ...(cursor ? { cursor } : {}) });
      try { catalog = (await loadCatalog()).items; catalogById = new Map(catalog.map((item) => [item.itemId, item])); } catch { catalog = []; catalogById = new Map(); }
      try { descriptions = (await loadDescriptions()).descriptions; descriptionsById = new Map(descriptions.map((item) => [item.itemId, item])); } catch { descriptions = []; descriptionsById = new Map(); }
      results.innerHTML = page.items.length ? page.items.map((entry) => entryMarkup(entry, catalogById, descriptionsById)).join('') : '<div class="guestbook-state"><i class="ph ph-notebook" aria-hidden="true"></i><strong>暂时没有符合条件的登记</strong><span>调整筛选条件，或发布第一条登记。</span></div>';
      nextCursor = page.nextCursor;
      next.disabled = !nextCursor;
      prev.disabled = pageIndex === 0;
      pageStatus.textContent = `第 ${pageIndex + 1} 页 · ${page.items.length} 条`;
    } catch (error) {
      results.innerHTML = `<div class="guestbook-state guestbook-state--error"><i class="ph ph-warning-circle" aria-hidden="true"></i><strong>登记加载失败</strong><span>${escapeHtml(error instanceof Error ? error.message : '请稍后重试')}</span><button type="button" id="guestbook-retry">重新加载</button></div>`;
      results.querySelector('#guestbook-retry')?.addEventListener('click', () => void loadPage(pageCursors[pageIndex] ?? undefined));
    } finally { results.setAttribute('aria-busy', 'false'); }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const category = categoryInput();
    if (category !== 'suggestion' && !selectedItem && itemQuery.value !== 'Zeny 游戏币') { status.textContent = '请选择目录中的道具或 Zeny。'; itemQuery.focus(); return; }
    const input: GuestbookSubmissionInput = category === 'suggestion'
      ? { category, content: content.value }
      : {
          category,
          content: content.value,
          isZeny: itemQuery.value === 'Zeny 游戏币',
          ...(selectedItem ? { itemId: selectedItem.itemId } : {}),
          contact: root.querySelector<HTMLInputElement>('#guestbook-contact')!.value,
          duration: root.querySelector<HTMLSelectElement>('#guestbook-duration')!.value as NonNullable<GuestbookSubmissionInput['duration']>,
        };
    submit.disabled = true; status.textContent = '正在提交…';
    try { await api.createGuestbookEntry(input); form.reset(); selectedItem = null; contentCount.textContent = '0'; selectedHelp.textContent = '请选择道具或 Zeny。'; setKind(); status.textContent = '登记已发布。'; currentFilters = { limit: 20 }; syncTabs(''); pageIndex = 0; pageCursors = [null]; await loadPage(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : '提交失败，请稍后重试。'; }
    finally { submit.disabled = false; }
  });

  root.querySelector<HTMLElement>('#guestbook-tabs')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.guestbook-tab');
    if (!button || button.classList.contains('is-active')) return;
    const tab = (button.dataset.tab ?? '') as GuestbookTab;
    const q = root.querySelector<HTMLInputElement>('#guestbook-search-q')!.value.trim();
    const selectedId = Number(searchForm.dataset.itemId);
    currentFilters = { limit: 20, ...(tab ? { category: tab } : {}), ...(q ? { q } : {}), ...(Number.isSafeInteger(selectedId) && selectedId > 0 ? { itemId: selectedId } : {}) };
    syncTabs(tab);
    pageIndex = 0; pageCursors = [null]; void loadPage();
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const category = currentFilters.category ?? '';
    const q = root.querySelector<HTMLInputElement>('#guestbook-search-q')!.value.trim();
    const selectedId = Number(searchForm.dataset.itemId);
    currentFilters = { limit: 20, ...(category ? { category } : {}), ...(q ? { q } : {}), ...(Number.isSafeInteger(selectedId) && selectedId > 0 ? { itemId: selectedId } : {}) };
    syncTabs(category);
    pageIndex = 0; pageCursors = [null]; void loadPage();
  });
  root.querySelector<HTMLButtonElement>('#guestbook-clear-filter')!.addEventListener('click', () => { searchForm.reset(); delete searchForm.dataset.itemId; currentFilters = { limit: 20 }; syncTabs(''); pageIndex = 0; pageCursors = [null]; void loadPage(); });
  next.addEventListener('click', () => { if (!nextCursor) return; pageCursors[pageIndex + 1] = nextCursor; pageIndex += 1; void loadPage(nextCursor); });
  prev.addEventListener('click', () => { if (pageIndex === 0) return; pageIndex -= 1; void loadPage(pageCursors[pageIndex] ?? undefined); });

  const filterQuery = root.querySelector<HTMLInputElement>('#guestbook-filter-item')!;
  const filterSuggestions = root.querySelector<HTMLUListElement>('#guestbook-filter-suggestions')!;
  filterQuery.addEventListener('input', async () => { try { catalog = (await loadCatalog()).items; const matches = findCatalogMatches(catalog, filterQuery.value); filterSuggestions.innerHTML = matches.map((item) => `<li><button type="button" role="option" data-id="${item.itemId}">${escapeHtml(item.name)}</button></li>`).join(''); filterSuggestions.hidden = matches.length === 0; filterQuery.setAttribute('aria-expanded', String(matches.length > 0)); } catch { filterSuggestions.hidden = true; } });
  filterSuggestions.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-id]'); if (!button) return; searchForm.dataset.itemId = button.dataset.id ?? ''; filterQuery.value = button.textContent?.trim() ?? ''; filterSuggestions.hidden = true; filterQuery.setAttribute('aria-expanded', 'false'); });
  void loadPage();
}
