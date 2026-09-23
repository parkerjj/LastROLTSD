import { MarketApi, type MarketApiClient } from './api';
import { createCatalogLoader, findCatalogMatches } from './catalog';
import type { GuestbookCategory, GuestbookEntry, GuestbookFilters, GuestbookSubmissionInput, ItemAutocomplete } from './types';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

const categoryLabels: Record<GuestbookCategory, string> = { buy: '收购', sell: '出售', suggestion: '网站建议' };

function entryMarkup(entry: GuestbookEntry): string {
  const item = entry.isZeny ? 'Zeny' : entry.itemId === null ? '' : `道具 #${entry.itemId}`;
  const expiry = entry.expiresAt === null ? '永久' : `截止 ${new Date(entry.expiresAt).toLocaleString('zh-CN')}`;
  return `<article class="guestbook-entry${entry.isExpired ? ' is-expired' : ''}" data-entry-id="${entry.id}">
    <header class="guestbook-entry-head"><div class="guestbook-entry-tags"><span class="guestbook-kind guestbook-kind--${entry.category}">${categoryLabels[entry.category]}</span>${item ? `<span class="guestbook-item">${escapeHtml(item)}</span>` : ''}<time datetime="${new Date(entry.createdAt).toISOString()}">${new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div>${entry.isExpired ? '<span class="guestbook-expired-stamp" aria-label="此留言已过期">已过期</span>' : ''}</header>
    ${entry.contact ? `<p class="guestbook-contact"><i class="ph ph-identification-card" aria-hidden="true"></i>${escapeHtml(entry.contact)}</p>` : ''}
    <p class="guestbook-content">${escapeHtml(entry.content)}</p><footer class="guestbook-entry-foot"><span>${entry.category === 'suggestion' ? '匿名建议' : expiry}</span></footer>
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
            <fieldset class="guestbook-item-choice"><legend>交易物品</legend><label class="guestbook-zeny-choice"><input id="guestbook-zeny" type="checkbox"><span>交易 Zeny 游戏币</span></label><div id="guestbook-item-picker" class="autocomplete"><input id="guestbook-item-query" role="combobox" aria-autocomplete="list" aria-controls="guestbook-item-suggestions" aria-expanded="false" autocomplete="off" placeholder="输入道具名称搜索" aria-label="搜索并选择道具" /><ul id="guestbook-item-suggestions" class="suggestions" role="listbox" hidden></ul></div><p id="guestbook-item-selected" class="field-help">请选择目录中的道具，或勾选 Zeny。</p></fieldset>
            <label for="guestbook-contact">联系方式<input id="guestbook-contact" maxlength="120" placeholder="微信、QQ 号或游戏角色名" required></label>
            <label for="guestbook-duration">有效期限<select id="guestbook-duration" required><option value="1d">1 天</option><option value="3d">3 天</option><option value="7d">7 天</option><option value="permanent">永久</option></select></label>
          </div>
          <label for="guestbook-content">详细内容<textarea id="guestbook-content" maxlength="2000" rows="4" required placeholder="写下物品数量、价格范围或你的建议"></textarea><span class="guestbook-count"><span id="guestbook-content-count">0</span> / 2000</span></label>
          <div class="guestbook-form-actions"><p id="guestbook-form-status" role="status" aria-live="polite"></p><button type="submit" id="guestbook-submit"><i class="ph ph-paper-plane-tilt" aria-hidden="true"></i> 发布登记</button></div>
        </form>
      </section>
      <section class="guestbook-list-section" aria-labelledby="guestbook-list-title"><div class="section-heading"><div><p class="eyebrow">公开登记</p><h2 id="guestbook-list-title">玩家留言</h2></div><p>收购与出售记录到期后仍会保留，并标注过期状态。</p></div>
        <form id="guestbook-search" class="guestbook-search"><label for="guestbook-search-q">关键词<input id="guestbook-search-q" placeholder="搜索正文或联系方式"></label><label for="guestbook-search-category">类别<select id="guestbook-search-category"><option value="">全部类别</option><option value="buy">收购</option><option value="sell">出售</option><option value="suggestion">网站建议</option></select></label><div class="autocomplete"><label for="guestbook-filter-item">道具筛选<input id="guestbook-filter-item" role="combobox" aria-autocomplete="list" aria-controls="guestbook-filter-suggestions" aria-expanded="false" autocomplete="off" placeholder="全部道具"></label><ul id="guestbook-filter-suggestions" class="suggestions" role="listbox" hidden></ul></div><button type="submit"><i class="ph ph-magnifying-glass" aria-hidden="true"></i> 搜索</button><button id="guestbook-clear-filter" class="secondary-button" type="button" aria-label="清除筛选"><i class="ph ph-x" aria-hidden="true"></i></button></form>
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
  const zeny = root.querySelector<HTMLInputElement>('#guestbook-zeny')!;
  const selectedHelp = root.querySelector<HTMLElement>('#guestbook-item-selected')!;
  const searchForm = root.querySelector<HTMLFormElement>('#guestbook-search')!;
  const results = root.querySelector<HTMLElement>('#guestbook-results')!;
  const prev = root.querySelector<HTMLButtonElement>('#guestbook-prev')!;
  const next = root.querySelector<HTMLButtonElement>('#guestbook-next')!;
  const pageStatus = root.querySelector<HTMLElement>('#guestbook-page-status')!;
  const loadCatalog = createCatalogLoader();
  let catalog: ItemAutocomplete[] = [];
  let selectedItem: ItemAutocomplete | null = null;
  let activeIndex = -1;
  let pageIndex = 0;
  let pageCursors: Array<string | null> = [null];
  let nextCursor: string | null = null;
  let currentFilters: GuestbookFilters = { limit: 20 };

  const categoryInput = (): GuestbookCategory => form.querySelector<HTMLInputElement>('input[name="category"]:checked')!.value as GuestbookCategory;
  const setKind = (): void => { const suggestion = categoryInput() === 'suggestion'; tradeFields.hidden = suggestion; tradeFields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach((field) => { field.disabled = suggestion; field.required = !suggestion && field.id !== 'guestbook-zeny' && field.id !== 'guestbook-item-query'; }); if (suggestion) { selectedItem = null; zeny.checked = false; itemQuery.value = ''; } };
  const hideSuggestions = (): void => { itemSuggestions.hidden = true; itemQuery.setAttribute('aria-expanded', 'false'); activeIndex = -1; };
  const renderSuggestions = (items: ItemAutocomplete[]): void => { itemSuggestions.innerHTML = items.map((item, index) => `<li><button type="button" role="option" aria-selected="${index === activeIndex}" data-index="${index}">${escapeHtml(item.name)} <small>#${item.itemId}</small></button></li>`).join(''); itemSuggestions.hidden = items.length === 0; itemQuery.setAttribute('aria-expanded', String(items.length > 0)); };
  const chooseItem = (item: ItemAutocomplete): void => { selectedItem = item; itemQuery.value = item.name; selectedHelp.textContent = `已选择：${item.name}（ItemID ${item.itemId}）`; hideSuggestions(); };

  form.querySelectorAll<HTMLInputElement>('input[name="category"]').forEach((input) => input.addEventListener('change', setKind));
  setKind();
  content.addEventListener('input', () => { contentCount.textContent = String([...content.value].length); });
  zeny.addEventListener('change', () => { if (zeny.checked) { selectedItem = null; itemQuery.value = ''; selectedHelp.textContent = '已选择 Zeny 游戏币'; hideSuggestions(); } else selectedHelp.textContent = '请选择目录中的道具，或勾选 Zeny。'; });
  itemQuery.addEventListener('input', async () => {
    selectedItem = null;
    zeny.checked = false;
    selectedHelp.textContent = '请从搜索结果中选择道具。';
    try { catalog = (await loadCatalog()).items; renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); } catch { hideSuggestions(); }
  });
  itemQuery.addEventListener('keydown', (event) => {
    const options = [...itemSuggestions.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    if (event.key === 'Escape') hideSuggestions();
    else if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); activeIndex = (activeIndex + 1) % options.length; renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); activeIndex = (activeIndex - 1 + options.length) % options.length; renderSuggestions(findCatalogMatches(catalog, itemQuery.value)); }
    else if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); const item = findCatalogMatches(catalog, itemQuery.value)[activeIndex]; if (item) chooseItem(item); }
  });
  itemSuggestions.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-index]'); if (!button) return; const item = findCatalogMatches(catalog, itemQuery.value)[Number(button.dataset.index)]; if (item) chooseItem(item); });

  async function loadPage(cursor?: string): Promise<void> {
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<div class="guestbook-state"><span class="guestbook-skeleton"></span><span class="guestbook-skeleton"></span></div>';
    try {
      const page = await api.searchGuestbook({ ...currentFilters, ...(cursor ? { cursor } : {}) });
      results.innerHTML = page.items.length ? page.items.map(entryMarkup).join('') : '<div class="guestbook-state"><i class="ph ph-notebook" aria-hidden="true"></i><strong>暂时没有符合条件的登记</strong><span>调整筛选条件，或发布第一条登记。</span></div>';
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
    if (category !== 'suggestion' && !zeny.checked && !selectedItem) { status.textContent = '请选择目录中的道具，或勾选 Zeny。'; itemQuery.focus(); return; }
    const input: GuestbookSubmissionInput = category === 'suggestion'
      ? { category, content: content.value }
      : {
          category,
          content: content.value,
          isZeny: zeny.checked,
          ...(selectedItem ? { itemId: selectedItem.itemId } : {}),
          contact: root.querySelector<HTMLInputElement>('#guestbook-contact')!.value,
          duration: root.querySelector<HTMLSelectElement>('#guestbook-duration')!.value as NonNullable<GuestbookSubmissionInput['duration']>,
        };
    submit.disabled = true; status.textContent = '正在提交…';
    try { await api.createGuestbookEntry(input); form.reset(); selectedItem = null; contentCount.textContent = '0'; selectedHelp.textContent = '请选择目录中的道具，或勾选 Zeny。'; setKind(); status.textContent = '登记已发布。'; currentFilters = { limit: 20 }; pageIndex = 0; pageCursors = [null]; await loadPage(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : '提交失败，请稍后重试。'; }
    finally { submit.disabled = false; }
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const category = root.querySelector<HTMLSelectElement>('#guestbook-search-category')!.value as GuestbookCategory | '';
    const q = root.querySelector<HTMLInputElement>('#guestbook-search-q')!.value.trim();
    const selectedId = Number(searchForm.dataset.itemId);
    currentFilters = { limit: 20, ...(category ? { category } : {}), ...(q ? { q } : {}), ...(Number.isSafeInteger(selectedId) && selectedId > 0 ? { itemId: selectedId } : {}) };
    pageIndex = 0; pageCursors = [null]; void loadPage();
  });
  root.querySelector<HTMLButtonElement>('#guestbook-clear-filter')!.addEventListener('click', () => { searchForm.reset(); delete searchForm.dataset.itemId; currentFilters = { limit: 20 }; pageIndex = 0; pageCursors = [null]; void loadPage(); });
  next.addEventListener('click', () => { if (!nextCursor) return; pageCursors[pageIndex + 1] = nextCursor; pageIndex += 1; void loadPage(nextCursor); });
  prev.addEventListener('click', () => { if (pageIndex === 0) return; pageIndex -= 1; void loadPage(pageCursors[pageIndex] ?? undefined); });

  const filterQuery = root.querySelector<HTMLInputElement>('#guestbook-filter-item')!;
  const filterSuggestions = root.querySelector<HTMLUListElement>('#guestbook-filter-suggestions')!;
  filterQuery.addEventListener('input', async () => { try { catalog = (await loadCatalog()).items; const matches = findCatalogMatches(catalog, filterQuery.value); filterSuggestions.innerHTML = matches.map((item) => `<li><button type="button" role="option" data-id="${item.itemId}">${escapeHtml(item.name)} <small>#${item.itemId}</small></button></li>`).join(''); filterSuggestions.hidden = matches.length === 0; filterQuery.setAttribute('aria-expanded', String(matches.length > 0)); } catch { filterSuggestions.hidden = true; } });
  filterSuggestions.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-id]'); if (!button) return; searchForm.dataset.itemId = button.dataset.id ?? ''; filterQuery.value = button.textContent?.replace(/\s+#\d+$/u, '').trim() ?? ''; filterSuggestions.hidden = true; filterQuery.setAttribute('aria-expanded', 'false'); });
  void loadPage();
}
