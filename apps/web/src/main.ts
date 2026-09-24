import "./styles.css";
import "@phosphor-icons/web/regular";
import { AnalyticsEvent, initAnalytics, track } from "./analytics";
import { MarketApi } from "./api";
import { OptionDictionaryStore } from "./option-state";
import { appendOptionRow, serializeSearchForm } from "./query-form";
import {
  cleanItemDescription,
  drawerFrame,
  friendlyError,
  renderHistory,
  renderHistoryError,
  renderSearchResultsWithCatalog,
  rmsAssetUrl,
} from "./render";
import { mapFilterOptions } from "./maps";
import { SearchController } from "./search-controller";
import { initialState } from "./state";
import type {
  ItemAutocomplete,
  ItemDescription,
  ListingSearchResult,
  SearchFilters,
  SearchScopeKey,
  SearchScopes,
} from "./types";
import {
  createCatalogLoader,
  createDescriptionLoader,
  findCatalogMatches,
} from "./catalog";
import { mountReleasePage } from "./release-page";
import { mountGuestbookPage } from "./guestbook-page";

initAnalytics();

const root = document.querySelector<HTMLElement>("#app")!;
if (!root) throw new Error("Missing app root");

const isReleasePage = /^\/updates\/?$/u.test(window.location.pathname);
const isGuestbookPage = /^\/guestbook\/?$/u.test(window.location.pathname);
const mapFilterMarkup = mapFilterOptions()
  .map((map) => `<option value="${map.value}">${map.label}</option>`)
  .join("");

function mountSearchPage(): void {
  const api = new MarketApi();
  const dictionary = new OptionDictionaryStore(api);
  const searchController = new SearchController(api);

  root.innerHTML = `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="#top" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      <nav class="site-nav" aria-label="主导航"><a class="active" href="#search">搜索市场</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://github.com/parkerjj/LastROLTSD" target="_blank" rel="noreferrer">代码仓库</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></nav>
    </div>
  </header>
  <main id="top" class="page-width">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy"><p class="eyebrow">露天市场 / 交易索引</p><h1 id="page-title">露天商店<span>.Ro</span></h1><p class="hero-subtitle">在城市之间，快速找到你要的装备与词条。</p><div class="hero-meta"><span aria-live="polite"><i id="market-status-dot" class="status-dot"></i><span id="market-status-label">市场数据调查员在线</span></span><span id="market-updated-at" aria-live="polite">正在获取更新时间</span><span>支持地图定位</span></div></div>
    </section>
    <section id="site-notice" class="site-notice" aria-label="站点公告">
      <span class="notice-badge">公告</span>
      <div class="notice-body"><p>本站刚刚新建，正在持续优化与扩充功能。如有建议或反馈，欢迎加入 QQ 交流群：<button type="button" id="copy-qq-group" class="notice-copy" data-copy="725955796" aria-label="复制QQ群号 725955796"><span class="qq-number">725955796</span><span class="copy-hint" aria-hidden="true">复制</span></button></p></div>
    </section>
    <form id="search-form" class="market-form" aria-describedby="form-error">
      <section id="search" class="search-panel" aria-labelledby="search-title">
        <div class="section-heading"><div><p class="eyebrow">市场搜索</p><h2 id="search-title">搜索市场</h2></div><p>名称、描述、商店与玩家会按命中位置自动分组。</p></div>
        <div class="search-command">
          <div class="global-search"><div class="autocomplete"><input id="global-query" name="q" role="combobox" aria-autocomplete="list" aria-controls="item-suggestions" aria-expanded="false" aria-describedby="search-help" autocomplete="off" placeholder="例如：波利卡片、深红之弓、蓝宝石、赏金" /><ul id="item-suggestions" class="suggestions" role="listbox" hidden></ul></div><p id="search-help" class="field-help">名称、描述、商店标题和玩家名称都可以搜索。</p></div>
          <div class="search-command-actions">
            <button type="submit" class="submit-button" aria-label="搜索市场">搜索市场 <i class="ph ph-magnifying-glass" aria-hidden="true"></i></button>
          </div>
        </div>
      </section>
      <div class="market-workspace">
        <aside class="filter-sidebar" aria-label="扩展搜索">
          <div id="advanced-filters" class="search-reveal advanced-filters"><div class="reveal-heading"><div><strong>高级搜索</strong><span>范围、价格、地图和商店类型筛选</span></div><span class="reveal-caption">可选</span></div><div class="scope-filters"><div class="scope-filters-head"><strong>命中范围</strong><span>关键词在哪些位置参与匹配</span></div><div class="scope-toggle-row" role="group" aria-label="关键词命中范围"><button type="button" class="scope-toggle is-active" data-scope="name" aria-pressed="true"><i class="ph ph-package" aria-hidden="true"></i><span class="scope-toggle-label">物品</span><span class="scope-toggle-state"><i class="ph ph-check-circle" aria-hidden="true"></i><b>已开启</b></span></button><button type="button" class="scope-toggle is-active" data-scope="shop" aria-pressed="true"><i class="ph ph-storefront" aria-hidden="true"></i><span class="scope-toggle-label">店名</span><span class="scope-toggle-state"><i class="ph ph-check-circle" aria-hidden="true"></i><b>已开启</b></span></button><button type="button" class="scope-toggle is-active" data-scope="vendor" aria-pressed="true"><i class="ph ph-user" aria-hidden="true"></i><span class="scope-toggle-label">商人</span><span class="scope-toggle-state"><i class="ph ph-check-circle" aria-hidden="true"></i><b>已开启</b></span></button></div></div><div class="filters"><label for="price-min">最低价格<input id="price-min" name="price_min" inputmode="numeric" type="number" min="0" placeholder="不限" /></label><label for="price-max">最高价格<input id="price-max" name="price_max" inputmode="numeric" type="number" min="0" placeholder="不限" /></label><label for="map-name">地图<select id="map-name" name="map"><option value="">全部</option>${mapFilterMarkup}</select></label><label for="shop-type">商店类型<select id="shop-type" name="shop_type"><option value="">全部类型</option><option value="sell">出售</option><option value="buy">收购</option></select></label></div></div>
          <div id="option-search-panel" class="search-reveal option-search-panel"><div id="option-dictionary-status" class="option-dictionary-status" role="status" aria-live="polite"></div><fieldset id="option-fieldset" class="option-filters"><legend>词条搜索与过滤</legend><div class="option-heading"><p>添加词条条件，筛选精炼、卡片与装备属性。</p><div class="option-mode" role="group" aria-label="词条匹配方式"><label><input type="radio" name="option_mode" value="all" checked />全部满足</label><label><input type="radio" name="option_mode" value="any" />满足任一</label></div></div><div id="option-rows"></div><button type="button" id="add-option" class="secondary-button" disabled aria-label="添加词条条件"><i class="ph ph-plus" aria-hidden="true"></i> 添加词条条件</button></fieldset></div>
          <p id="form-error" class="form-error" role="alert" hidden></p>
        </aside>
        <section id="results" class="results" aria-live="polite" aria-atomic="true"></section>
      </div>
    </form>
  </main>
  <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="#top"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="#search">搜索市场</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  <aside id="history-drawer" class="drawer" role="dialog" aria-modal="true" aria-label="价格历史" hidden></aside>
  <aside id="map-drawer" class="drawer map-drawer" role="dialog" aria-modal="true" aria-label="地图定位" hidden></aside>
  <div id="drawer-overlay" class="drawer-overlay" aria-hidden="true" hidden></div>
`;

  const form = root.querySelector<HTMLFormElement>("#search-form")!;
  const results = root.querySelector<HTMLElement>("#results")!;
  const optionRows = root.querySelector<HTMLElement>("#option-rows")!;
  const optionFieldset =
    root.querySelector<HTMLFieldSetElement>("#option-fieldset")!;
  const optionStatus = root.querySelector<HTMLElement>(
    "#option-dictionary-status",
  )!;
  const addOptionButton = root.querySelector<HTMLButtonElement>("#add-option")!;
  const formError = root.querySelector<HTMLElement>("#form-error")!;
  const historyDrawer = root.querySelector<HTMLElement>("#history-drawer")!;
  const mapDrawer = root.querySelector<HTMLElement>("#map-drawer")!;
  const drawerOverlay = root.querySelector<HTMLElement>("#drawer-overlay")!;
  const queryInput = root.querySelector<HTMLInputElement>("#global-query")!;
  const suggestions =
    root.querySelector<HTMLUListElement>("#item-suggestions")!;
  const copyQqGroupButton =
    root.querySelector<HTMLButtonElement>("#copy-qq-group")!;
  const marketStatusDot =
    root.querySelector<HTMLElement>("#market-status-dot")!;
  const marketStatusLabel = root.querySelector<HTMLElement>(
    "#market-status-label",
  )!;
  const marketUpdatedAt =
    root.querySelector<HTMLElement>("#market-updated-at")!;

  type MarketInvestigatorState = "online" | "resting" | "offline";

  function marketInvestigatorState(
    latestUpdatedAt: number | null,
  ): MarketInvestigatorState {
    if (latestUpdatedAt === null || !Number.isFinite(latestUpdatedAt))
      return "offline";
    const elapsedMinutes = Math.max(
      0,
      Math.floor((Date.now() - latestUpdatedAt) / 60_000),
    );
    if (elapsedMinutes > 120) return "offline";
    if (elapsedMinutes > 30) return "resting";
    return "online";
  }

  function renderMarketStatus(latestUpdatedAt: number | null): void {
    const state = marketInvestigatorState(latestUpdatedAt);
    const labels: Record<MarketInvestigatorState, string> = {
      online: "市场数据调查员在线",
      resting: "市场数据调查员正在小憩",
      offline: "市场数据调查员离线",
    };
    marketStatusDot.className = `status-dot status-dot--${state}`;
    marketStatusLabel.textContent = labels[state];
    marketUpdatedAt.textContent =
      latestUpdatedAt === null || !Number.isFinite(latestUpdatedAt)
        ? "暂无更新记录"
        : `更新于 ${Math.max(0, Math.floor((Date.now() - latestUpdatedAt) / 60_000))} 分钟前`;
  }

  async function loadMarketStatus(): Promise<void> {
    try {
      renderMarketStatus((await api.getStatus()).latestUpdatedAt);
    } catch {
      renderMarketStatus(null);
      marketUpdatedAt.textContent = "更新时间暂不可用";
    }
  }

  let copyHintTimer: number | undefined;
  copyQqGroupButton.addEventListener("click", async () => {
    const qqGroup = copyQqGroupButton.dataset.copy ?? "";
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
        const fallback = document.createElement("input");
        fallback.value = qqGroup;
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        fallback.remove();
        copied = true;
      } catch {
        copied = false;
      }
    }
    const hint = copyQqGroupButton.querySelector(".copy-hint");
    if (copied && hint) {
      track(AnalyticsEvent.QqGroupCopy);
      hint.textContent = "已复制";
      window.clearTimeout(copyHintTimer);
      copyHintTimer = window.setTimeout(() => {
        if (hint) hint.textContent = "复制";
      }, 1800);
    } else if (!copied) {
      copyQqGroupButton.setAttribute(
        "aria-label",
        `QQ群号 ${qqGroup}，请手动复制`,
      );
    }
  });

  let autocompleteRequestId = 0;
  let autocompleteItems: ItemAutocomplete[] = [];
  let catalogItems: ItemAutocomplete[] = [];
  let itemDescriptions: ItemDescription[] = [];
  let itemDescriptionError: string | null = null;
  let initialBrowse = true;
  const loadCatalog = createCatalogLoader();
  const loadItemDescriptions = createDescriptionLoader();
  let activeSuggestion = -1;

  function renderSearchState(): void {
    const current = searchController.getState();
    renderSearchResultsWithCatalog(
      results,
      current.page ?? { items: [], nextCursor: null },
      {
        ...current,
        descriptionError: itemDescriptionError,
        initialBrowse,
        scopes: readSearchScopes(),
      },
      catalogItems,
      itemDescriptions,
    );
  }

  const SCOPE_KEYS: readonly SearchScopeKey[] = ["name", "shop", "vendor"];

  // 命中范围开关的唯一状态载体是侧边栏按钮（aria-pressed），渲染时实时读取。
  function readSearchScopes(): SearchScopes {
    const scopes: SearchScopes = { name: true, shop: true, vendor: true };
    form
      .querySelectorAll<HTMLButtonElement>(".scope-toggle")
      .forEach((button) => {
        const key = button.dataset.scope;
        if (key === "name" || key === "shop" || key === "vendor")
          scopes[key] = button.getAttribute("aria-pressed") === "true";
      });
    return scopes;
  }

  form.addEventListener("click", (event) => {
    const toggle = (event.target as Element | null)?.closest<HTMLButtonElement>(
      ".scope-toggle",
    );
    if (!toggle) return;
    const key = toggle.dataset.scope as SearchScopeKey | undefined;
    if (!key || !SCOPE_KEYS.includes(key)) return;
    // 成对更新：视觉 class、aria 状态、图标与文案必须同时切换，避免状态残留。
    const active = !toggle.classList.contains("is-active");
    toggle.classList.toggle("is-active", active);
    toggle.setAttribute("aria-pressed", String(active));
    const stateIcon = toggle.querySelector<HTMLElement>(
      ".scope-toggle-state i",
    );
    if (stateIcon)
      stateIcon.className = `ph ${active ? "ph-check-circle" : "ph-x-circle"}`;
    const stateText = toggle.querySelector<HTMLElement>(
      ".scope-toggle-state b",
    );
    if (stateText) stateText.textContent = active ? "已开启" : "已关闭";
    renderSearchState();
  });

  async function performSearch(
    filters: SearchFilters,
    shouldScroll = false,
  ): Promise<void> {
    const pending = searchController.search(filters);
    renderSearchState();
    await pending;
    const state = searchController.getState();
    renderSearchState();
    if (state.page) {
      track(AnalyticsEvent.SearchResult, {
        q: filters.q ?? "",
        result_count: state.page.items.length,
        has_results: state.page.items.length > 0,
        is_empty: state.empty,
      });
    }
    if (shouldScroll) scrollToResults();
  }

  async function loadNextPage(): Promise<void> {
    const pending = searchController.nextPage();
    renderSearchState();
    await pending;
    renderSearchState();
    scrollToResults();
  }

  async function loadPrevPage(): Promise<void> {
    const pending = searchController.prevPage();
    renderSearchState();
    await pending;
    renderSearchState();
    scrollToResults();
  }

  function scrollToResults(): void {
    if (
      typeof window === "undefined" ||
      !window.matchMedia?.("(max-width: 760px)").matches
    )
      return;
    const target = results.querySelector<HTMLElement>(".result-group");
    if (!target) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // 预留顶部粘性导航（74px）与视觉间距。
    const top = Math.max(
      0,
      target.getBoundingClientRect().top + window.scrollY - 84,
    );
    window.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
  }

  function setFormError(message: string | null): void {
    formError.textContent = message ?? "";
    formError.hidden = !message;
  }

  function renderOptionDictionary(): void {
    const state = dictionary.getState();
    const ready = state.status === "ready";
    optionFieldset.disabled = !ready;
    addOptionButton.disabled = !ready;
    optionStatus.replaceChildren();
    optionStatus.hidden = false;
    optionStatus.setAttribute(
      "role",
      state.status === "error" ? "alert" : "status",
    );
    if (state.status === "loading" || state.status === "idle") {
      optionStatus.textContent = "正在加载词条字典...";
      return;
    }
    if (state.status === "empty") {
      optionStatus.textContent = "暂无可用词条条件。";
      return;
    }
    if (state.status === "error") {
      const message = document.createElement("span");
      message.textContent = friendlyError(
        state.error,
        "词条字典接口暂不可用，请确认本地服务已启动。",
      );
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "inline-action";
      retry.textContent = "重试词条字典";
      retry.setAttribute("aria-label", "重试词条字典");
      retry.addEventListener("click", () => void retryOptionDictionary());
      optionStatus.append(message, retry);
      return;
    }
    optionStatus.hidden = true;
    if (optionRows.querySelectorAll("[data-option-row]").length === 0)
      appendOptionRow(optionRows, state.definitions);
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
    queryInput.setAttribute("aria-expanded", "false");
    queryInput.removeAttribute("aria-activedescendant");
  }

  function updateSuggestionSelection(): void {
    const options = Array.from(
      suggestions.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    options.forEach((option, index) => {
      const selected = index === activeSuggestion;
      option.setAttribute("aria-selected", String(selected));
      if (selected) queryInput.setAttribute("aria-activedescendant", option.id);
    });
    if (activeSuggestion < 0)
      queryInput.removeAttribute("aria-activedescendant");
  }

  function chooseSuggestion(index: number): void {
    const item = autocompleteItems[index];
    if (!item) return;
    track(AnalyticsEvent.AutocompleteSelect, {
      item_id: item.itemId,
      item_name: item.name,
    });
    queryInput.value = item.name;
    hideSuggestions();
    queryInput.focus();
  }

  function renderSuggestions(items: ItemAutocomplete[]): void {
    autocompleteItems = items;
    activeSuggestion = -1;
    suggestions.replaceChildren();
    items.forEach((item, index) => {
      const option = document.createElement("li");
      option.id = `item-suggestion-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.tabIndex = -1;
      const name = document.createElement("strong");
      name.textContent = item.name;
      const itemId = document.createElement("small");
      itemId.textContent = `物品 ID：${item.itemId}`;
      option.append(name, itemId);
      option.addEventListener("click", () => chooseSuggestion(index));
      suggestions.append(option);
    });
    suggestions.hidden = items.length === 0;
    queryInput.setAttribute("aria-expanded", String(items.length > 0));
  }

  async function loadSuggestions(query: string): Promise<void> {
    const requestId = ++autocompleteRequestId;
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    if (!normalized) {
      hideSuggestions();
      return;
    }
    try {
      const page = await loadCatalog();
      catalogItems = page.items;
      if (requestId !== autocompleteRequestId) return;
      renderSuggestions(findCatalogMatches(page.items, normalized));
    } catch {
      if (requestId === autocompleteRequestId) renderSuggestions([]);
    }
  }

  let drawerCloseTimer: number | undefined;
  let historyRequestId = 0;

  /** 打开一个右侧抽屉：与其它抽屉互斥，并同步黑色蒙版与背景滚动锁定。 */
  function openDrawer(drawer: HTMLElement): void {
    window.clearTimeout(drawerCloseTimer);
    for (const other of [historyDrawer, mapDrawer]) {
      if (other !== drawer) {
        other.hidden = true;
        other.classList.remove("drawer--closing");
      }
    }
    drawer.classList.remove("drawer--closing");
    drawer.hidden = false;
    drawerOverlay.classList.remove("drawer-overlay--closing");
    drawerOverlay.hidden = false;
    document.body.classList.add("drawer-open");
  }

  function closeDrawer(drawer: HTMLElement): void {
    if (drawer.hidden) return;
    drawer.classList.add("drawer--closing");
    drawerOverlay.classList.add("drawer-overlay--closing");
    document.body.classList.remove("drawer-open");
    window.clearTimeout(drawerCloseTimer);
    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    drawerCloseTimer = window.setTimeout(
      () => {
        drawer.hidden = true;
        drawer.classList.remove("drawer--closing");
        if (historyDrawer.hidden && mapDrawer.hidden) {
          drawerOverlay.hidden = true;
          drawerOverlay.classList.remove("drawer-overlay--closing");
        }
      },
      reducedMotion ? 0 : 200,
    );
  }

  async function openHistory(
    item: Pick<ListingSearchResult, "itemId" | "itemName" | "itemIcon">,
  ): Promise<void> {
    const requestId = ++historyRequestId;
    track(AnalyticsEvent.ItemHistory, {
      item_id: item.itemId,
      item_name: item.itemName ?? "",
    });
    openDrawer(historyDrawer);
    historyDrawer.innerHTML = drawerFrame(
      "close-history",
      "关闭价格历史",
      '<p class="drawer-loading" role="status"><i class="ph ph-circle-notch ph-spin" aria-hidden="true"></i>正在加载价格历史...</p>',
    );
    try {
      const history = await api.getItemHistory(item.itemId);
      // 请求返回前用户可能已关闭历史抽屉或切换到地图抽屉，丢弃过期结果。
      if (requestId !== historyRequestId || historyDrawer.hidden) return;
      renderHistory(historyDrawer, history, item);
    } catch (error) {
      if (requestId !== historyRequestId || historyDrawer.hidden) return;
      renderHistoryError(
        historyDrawer,
        friendlyError(error, "价格历史接口暂不可用，请确认本地服务已启动。"),
      );
    }
  }

  function closeHistory(): void {
    closeDrawer(historyDrawer);
  }

  function escapeHtml(value: string): string {
    return value
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  function openMap(button: HTMLButtonElement): void {
    const name = button.dataset.mapName || "未知地图";
    const image =
      button.dataset.mapImage || rmsAssetUrl("maps_xl/morocc_re.gif");
    const code = button.dataset.mapCode || "morocc";
    const rawX = Number(button.dataset.mapX);
    const rawY = Number(button.dataset.mapY);
    const rawLeft = Number(button.dataset.mapMarkerLeft);
    const rawTop = Number(button.dataset.mapMarkerTop);
    const x = Number.isFinite(rawX) ? rawX : 50;
    const y = Number.isFinite(rawY) ? rawY : 50;
    const left = Number.isFinite(rawLeft) ? rawLeft : 50;
    const top = Number.isFinite(rawTop) ? rawTop : 50;
    track(AnalyticsEvent.MapOpen, { map_code: code, map_name: name, x, y });
    const command = `请带我去 ${code} ${x} ${y} 这个坐标`;
    const safeName = escapeHtml(name);
    const body = `<p class="drawer-kicker">地图定位 / ${escapeHtml(code)}</p><h2>${safeName}</h2><p class="map-coordinates">商人坐标：${x}，${y}</p><div class="map-frame"><img src="${image}" alt="${safeName}地图" /><span class="map-star" style="left:${left}%;top:${top}%" aria-label="商人位置">★</span></div><p class="map-note">星标为当前商人位置，坐标来自市场记录。</p>
  <section class="quick-go" aria-labelledby="quick-go-title">
    <div class="quick-go-heading"><span class="quick-go-icon" aria-hidden="true"><i class="ph ph-navigation-arrow"></i></span><div><p class="quick-go-kicker">GPT 带路</p><h3 id="quick-go-title">快捷前往</h3></div></div>
    <ol class="quick-go-steps">
      <li><span class="quick-go-step-num" aria-hidden="true">1</span><p>点击聊天框右下角的<strong>蓝色小点按钮</strong>，在弹出的菜单中选择 <strong>GPT</strong> 频道。</p></li>
      <li><span class="quick-go-step-num" aria-hidden="true">2</span><p>点击下方指令框<strong>一键复制</strong>，粘贴到 GPT 频道发送，即可自动前往商人位置。</p></li>
    </ol>
    <figure class="quick-go-figure"><img src="/tutorial/gpt-guide.png" alt="图示：先点击右下角蓝色小点按钮，再选择GPT频道" loading="lazy" width="1800" height="588" /></figure>
    <button type="button" class="copy-command" data-command="${escapeHtml(command)}" data-map-code="${escapeHtml(code)}" data-map-x="${x}" data-map-y="${y}" aria-label="点击复制前往指令">
      <span class="copy-command-text">请带我去 <em>${escapeHtml(code)}</em> <em>${x}</em> <em>${y}</em> 这个坐标</span>
      <span class="copy-command-action" aria-hidden="true"><i class="ph ph-copy-simple"></i><span class="copy-command-label">点击复制</span></span>
    </button>
    <p class="quick-go-hint"><i class="ph ph-info" aria-hidden="true"></i> 地图名为英文代码（如 prontera），坐标与上方星标一致。</p>
  </section>`;
    mapDrawer.innerHTML = drawerFrame(
      "close-map",
      "关闭地图定位",
      body,
      "map-inner",
    );
    openDrawer(mapDrawer);
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Clipboard API 不可用（权限或非安全上下文）时使用降级方案。
    }
    try {
      const fallback = document.createElement("input");
      fallback.value = text;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand("copy");
      fallback.remove();
      return true;
    } catch {
      return false;
    }
  }

  let mapCopyTimer: number | undefined;

  function closeMap(): void {
    closeDrawer(mapDrawer);
  }

  queryInput.addEventListener("input", () => {
    void loadSuggestions(queryInput.value);
  });
  function submitSearchForm(): void {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
  }
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && autocompleteItems.length > 0) {
      event.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % autocompleteItems.length;
      updateSuggestionSelection();
    } else if (event.key === "ArrowUp" && autocompleteItems.length > 0) {
      event.preventDefault();
      activeSuggestion =
        (activeSuggestion - 1 + autocompleteItems.length) %
        autocompleteItems.length;
      updateSuggestionSelection();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeSuggestion >= 0) chooseSuggestion(activeSuggestion);
      else submitSearchForm();
    } else if (event.key === "Escape") hideSuggestions();
  });
  addOptionButton.addEventListener("click", () => {
    const state = dictionary.getState();
    if (state.status === "ready")
      appendOptionRow(optionRows, state.definitions);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    autocompleteRequestId += 1;
    void (async () => {
      try {
        const catalog = await loadCatalog();
        catalogItems = catalog.items;
        const filters = serializeSearchForm(
          form,
          dictionary.getState().definitions,
          catalog.items,
        );
        track(AnalyticsEvent.Search, {
          q: filters.q ?? "",
          map: filters.map,
          shop_type: filters.shop_type,
          price_min: filters.price_min,
          price_max: filters.price_max,
          option_count: filters.options?.length ?? 0,
          option_mode: filters.option_mode,
          sort: filters.sort,
          has_advanced: !!(
            filters.map ||
            filters.shop_type ||
            filters.price_min !== undefined ||
            filters.price_max !== undefined ||
            (filters.options && filters.options.length > 0)
          ),
        });
        initialBrowse = false;
        setFormError(null);
        hideSuggestions();
        void performSearch(filters, true);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : "请检查搜索条件");
      }
    })();
  });

  results.addEventListener("click", (event) => {
    const target = event.target as Element;
    const retryButton = target.closest<HTMLButtonElement>(".retry-button");
    if (retryButton) {
      const { cursor: _cursor, ...filters } =
        searchController.getState().filters;
      initialBrowse = false;
      void performSearch({ ...filters }, true);
      return;
    }
    const historyButton = target.closest<HTMLButtonElement>(".history-button");
    if (historyButton) {
      const itemId = Number(historyButton.dataset.itemId);
      const itemName = historyButton.dataset.itemName;
      const itemIcon = historyButton.dataset.itemIcon;
      if (Number.isSafeInteger(itemId))
        void openHistory({
          itemId,
          ...(itemName === undefined ? {} : { itemName }),
          ...(itemIcon === undefined ? {} : { itemIcon }),
        });
      return;
    }
    const mapButton = target.closest<HTMLButtonElement>(".map-button");
    if (mapButton) {
      openMap(mapButton);
      return;
    }
    const groupToggle = target.closest<HTMLButtonElement>(".group-toggle");
    if (groupToggle) {
      const body = document.getElementById(
        groupToggle.getAttribute("aria-controls") ?? "",
      );
      const expanded = groupToggle.getAttribute("aria-expanded") === "true";
      const nextExpanded = !expanded;
      const groupLabel = groupToggle.dataset.groupLabel ?? "";
      groupToggle.setAttribute("aria-expanded", String(nextExpanded));
      groupToggle.setAttribute(
        "aria-label",
        `${nextExpanded ? "收起" : "展开"}${groupLabel}`,
      );
      groupToggle.title = `${nextExpanded ? "收起" : "展开"}${groupLabel}`;
      body?.toggleAttribute("hidden", expanded);
      return;
    }
    if (target.closest<HTMLButtonElement>(".js-next-page")) {
      void loadNextPage();
      return;
    }
    if (target.closest<HTMLButtonElement>(".js-prev-page")) {
      void loadPrevPage();
      return;
    }
    const shopChevron = target.closest<HTMLButtonElement>(".vshop-chevron");
    if (shopChevron) {
      const body = shopChevron
        .closest(".vshop")
        ?.querySelector<HTMLElement>(".vshop-body");
      const nextExpanded = shopChevron.getAttribute("aria-expanded") !== "true";
      shopChevron.setAttribute("aria-expanded", String(nextExpanded));
      shopChevron.setAttribute(
        "aria-label",
        `${nextExpanded ? "收起" : "展开"}摊位`,
      );
      body?.toggleAttribute("hidden", !nextExpanded);
    }
  });
  results.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.id !== "result-sort")
      return;
    if (
      target.value !== "price_asc" &&
      target.value !== "price_desc" &&
      target.value !== "changed_desc"
    )
      return;
    initialBrowse = false;
    const { cursor: _cursor, ...filters } = searchController.getState().filters;
    void performSearch({ ...filters, sort: target.value }, true);
  });
  results.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (
        !(image instanceof HTMLImageElement) ||
        !image.hasAttribute("data-image-fallback")
      )
        return;
      image.hidden = true;
      image.parentElement
        ?.querySelector<HTMLElement>(
          ".item-icon-fallback, .detail-art-fallback",
        )
        ?.removeAttribute("hidden");
    },
    true,
  );

  /* ---- 物品详情浮层（PC 悬停 / 手机点击条目空白处）---- */

  const hoverCapable =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let popoverEntry: HTMLElement | null = null;

  function getPopover(): HTMLElement | null {
    return results.querySelector<HTMLElement>("#item-popover");
  }

  function entryItemId(entry: Element): number | null {
    const itemId = Number(
      entry.querySelector<HTMLButtonElement>(".history-button")?.dataset.itemId,
    );
    return Number.isSafeInteger(itemId) ? itemId : null;
  }

  function showItemPopover(entry: HTMLElement): void {
    const popover = getPopover();
    const itemId = entryItemId(entry);
    if (!popover || itemId === null) return;
    const name =
      catalogItems.find((item) => item.itemId === itemId)?.name ??
      entry
        .querySelector<HTMLElement>(".mc-main h3, .line-name strong")
        ?.textContent?.trim() ??
      `未知物品 #${itemId}`;
    const rawDescription = itemDescriptions.find(
      (item) => item.itemId === itemId,
    )?.description;
    const description = rawDescription
      ? cleanItemDescription(rawDescription)
      : "";
    const icon =
      entry
        .querySelector<HTMLElement>(".mc-icon img, .line-icon img")
        ?.getAttribute("src") ?? "";
    const iconMarkup = icon
      ? `<img src="${escapeHtml(icon)}" alt="" data-image-fallback /><span class="item-icon-fallback" aria-hidden="true" hidden>${itemId}</span>`
      : `<span class="item-icon-fallback" aria-hidden="true">${itemId}</span>`;
    const options = Array.from(
      entry.querySelectorAll<HTMLElement>(
        ".mc-options .opt-chip, .line-options .opt-chip",
      ),
    )
      .map((chip) => chip.textContent?.trim() ?? "")
      .filter(Boolean);
    const optionsSection = options.length
      ? `<div class="pop-options"><p class="pop-options-title"><i class="ph ph-sparkle" aria-hidden="true"></i>词条属性</p>${options
          .map((text) => `<span class="pop-option">${escapeHtml(text)}</span>`)
          .join("")}</div>`
      : "";
    popover.innerHTML = `<div class="pop-card"><div class="pop-head"><span class="pop-icon">${iconMarkup}</span><span class="pop-head-copy"><strong>${escapeHtml(name)}</strong><small>物品 ID ${itemId}</small></span><button type="button" class="pop-close" aria-label="关闭物品详情"><i class="ph ph-x" aria-hidden="true"></i></button></div><div class="pop-body">${description ? escapeHtml(description) : "暂无详细描述"}</div>${optionsSection}</div>`;
    popover.hidden = false;
    popoverEntry = entry;
    positionItemPopover(entry, popover);
  }

  function hideItemPopover(): void {
    const popover = getPopover();
    if (popover) popover.hidden = true;
    popoverEntry = null;
  }

  function positionItemPopover(entry: HTMLElement, popover: HTMLElement): void {
    const rect = entry.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 10;
    const popWidth = popover.offsetWidth;
    // 先用视口高度约束，避免长描述超出屏幕。
    popover.style.maxHeight = `${vh - 16}px`;
    const constrainedHeight = popover.offsetHeight;
    const hasRoomRight = rect.right + gap + popWidth <= vw;
    const hasRoomLeft = rect.left - gap - popWidth >= 0;
    const hasRoomBelow = rect.bottom + gap + constrainedHeight <= vh;
    const hasRoomAbove = rect.top - gap - constrainedHeight >= 0;
    let placement: "right" | "left" | "below" | "above";
    if (hoverCapable) {
      if (hasRoomRight) placement = "right";
      else if (hasRoomLeft) placement = "left";
      else if (hasRoomBelow) placement = "below";
      else placement = "above";
    } else {
      placement =
        hasRoomAbove || (!hasRoomBelow && rect.top > vh - rect.bottom)
          ? "above"
          : "below";
    }
    popover.classList.remove(
      "pop--right",
      "pop--left",
      "pop--below",
      "pop--above",
    );
    popover.classList.add(`pop--${placement}`);
    if (placement === "below" || placement === "above") {
      // 手机浮层不遮挡条目，紧贴可用空间。
      const available =
        placement === "above" ? rect.top - gap - 8 : vh - rect.bottom - gap - 8;
      if (available > 120)
        popover.style.maxHeight = `${Math.floor(available)}px`;
    }
    const popHeight = popover.offsetHeight;
    let top: number;
    let left: number;
    if (placement === "right" || placement === "left") {
      left =
        placement === "right" ? rect.right + gap : rect.left - gap - popWidth;
      top = rect.top + rect.height / 2 - popHeight / 2;
    } else {
      left = rect.left + rect.width / 2 - popWidth / 2;
      top =
        placement === "above" ? rect.top - gap - popHeight : rect.bottom + gap;
    }
    popover.style.left = `${Math.round(Math.max(8, Math.min(left, vw - popWidth - 8)))}px`;
    popover.style.top = `${Math.round(Math.max(8, Math.min(top, vh - popHeight - 8)))}px`;
  }

  results.addEventListener("pointerover", (event) => {
    if (!hoverCapable) return;
    const entry = (event.target as Element | null)?.closest<HTMLElement>(
      ".market-card, .line",
    );
    if (entry && entry !== popoverEntry) showItemPopover(entry);
  });
  results.addEventListener("pointerout", (event) => {
    if (!hoverCapable || popoverEntry === null) return;
    const next = event.relatedTarget as Node | null;
    if (popoverEntry.contains(next) || getPopover()?.contains(next)) return;
    hideItemPopover();
  });
  results.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest("#item-popover .pop-close")) {
      hideItemPopover();
      return;
    }
    if (hoverCapable) return;
    const entry = target.closest<HTMLElement>(".market-card, .line");
    if (!entry) return;
    if (target.closest("button, a, input, select, textarea, label")) {
      hideItemPopover();
      return;
    }
    if (popoverEntry === entry) hideItemPopover();
    else showItemPopover(entry);
  });
  document.addEventListener("click", (event) => {
    const popover = getPopover();
    if (!popover || popover.hidden) return;
    const target = event.target as Element;
    if (
      !target.closest("#item-popover") &&
      !target.closest(".market-card, .line")
    )
      hideItemPopover();
  });
  window.addEventListener("resize", () => hideItemPopover());
  window.addEventListener("scroll", () => hideItemPopover(), true);

  historyDrawer.addEventListener("click", (event) => {
    if ((event.target as Element).closest("[data-close-drawer]"))
      closeHistory();
  });
  drawerOverlay.addEventListener("click", () => {
    closeHistory();
    closeMap();
  });
  mapDrawer.addEventListener("click", (event) => {
    if ((event.target as Element).closest("[data-close-drawer]")) {
      closeMap();
      return;
    }
    const copyButton = (event.target as Element).closest<HTMLButtonElement>(
      ".copy-command",
    );
    if (!copyButton) return;
    void (async () => {
      const command = copyButton.dataset.command ?? "";
      const ok = await copyText(command);
      const label = copyButton.querySelector(".copy-command-label");
      const icon = copyButton.querySelector(".copy-command-action i");
      if (ok) {
        track(AnalyticsEvent.CopyCommand, {
          map_code: copyButton.dataset.mapCode ?? "",
          x: Number(copyButton.dataset.mapX),
          y: Number(copyButton.dataset.mapY),
        });
        copyButton.classList.add("is-copied");
        if (label) label.textContent = "已复制";
        if (icon) icon.className = "ph ph-check";
        window.clearTimeout(mapCopyTimer);
        mapCopyTimer = window.setTimeout(() => {
          copyButton.classList.remove("is-copied");
          if (label) label.textContent = "点击复制";
          if (icon) icon.className = "ph ph-copy-simple";
        }, 1800);
      } else {
        copyButton.setAttribute("aria-label", "复制失败，请手动选择文本复制");
      }
    })();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!suggestions.hidden) hideSuggestions();
    else if (!results.querySelector<HTMLElement>("#item-popover")?.hidden)
      hideItemPopover();
    else if (!historyDrawer.hidden) closeHistory();
    else if (!mapDrawer.hidden) closeMap();
  });

  renderOptionDictionary();
  renderSearchState();
  void loadMarketStatus();
  window.setInterval(() => void loadMarketStatus(), 60_000);
  void loadOptionDictionary();
  void loadCatalog()
    .then((catalog) => {
      catalogItems = catalog.items;
      renderSearchState();
    })
    .catch(() => undefined);
  void Promise.resolve()
    .then(() => loadItemDescriptions())
    .then((payload) => {
      itemDescriptions = payload.descriptions;
      itemDescriptionError = null;
      renderSearchState();
    })
    .catch((error: unknown) => {
      itemDescriptionError =
        error instanceof Error ? error.message : "unknown error";
      console.warn("[catalog] item descriptions failed to load", error);
      renderSearchState();
    });
  void performSearch(initialState.filters);
}

if (isReleasePage) mountReleasePage(root);
else if (isGuestbookPage) mountGuestbookPage(root);
else mountSearchPage();
