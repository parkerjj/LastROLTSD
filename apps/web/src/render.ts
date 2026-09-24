import type {
  HistoryPage,
  ItemMarketHistory,
  ListingSearchResult,
  SearchFilters,
  SearchPage,
  SearchScopes,
} from "./types";
import type { SearchControllerState } from "./search-controller";
import {
  findCatalogMatches,
  hydrateSearchPage,
  SEARCH_ITEM_ID_LIMIT,
} from "./catalog";
import type { ItemAutocomplete, ItemDescription } from "./types";
import { mapDetails, mapMarkerPosition } from "./maps";

export const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );

type RenderState = Pick<
  SearchControllerState,
  "loading" | "error" | "empty" | "pageIndex"
> & {
  cursor?: string | null;
  filters?: SearchFilters;
  descriptionError?: string | null;
  initialBrowse?: boolean;
  catalogSuggestions?: readonly ItemAutocomplete[];
  catalogDescriptions?: ReadonlyMap<number, string>;
  scopes?: SearchScopes;
};

export function friendlyError(
  value: unknown,
  fallback = "本地接口暂不可用，请确认服务已启动。",
): string {
  const message = String(value ?? "").trim();
  return /[\u3400-\u9fff]/u.test(message) ? message : fallback;
}

export function cleanItemDescription(raw: string): string {
  const lines = String(raw ?? "")
    .replace(/\^[0-9A-Fa-f]{6}_?/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "_");
  return lines.join("\n");
}

function statePanelMarkup(
  kind: "empty" | "error",
  title: string,
  description: string,
  actionLabel?: string,
): string {
  const action = actionLabel
    ? `<button type="button" class="retry-button"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i>${escape(actionLabel)}</button>`
    : "";
  return `<div class="state-panel state-panel--${kind}" role="${kind === "error" ? "alert" : "status"}">
    <img class="state-panel-art" src="/ui/market-state.png" alt="" />
    <div class="state-panel-copy">
      <h2>${escape(title)}</h2>
      <p>${escape(description)}</p>
      ${action}
    </div>
  </div>`;
}

type RichListing = ListingSearchResult & {
  x?: number;
  y?: number;
  mapX?: number;
  mapY?: number;
  itemIcon?: string;
};

export function rmsAssetUrl(path: string): string {
  return `/api/v1/assets/${path.replace(/^\/+|\/+$/gu, "")}?lastroweb=v3`;
}

function proxyRmsAsset(value: string): string {
  try {
    const url = new URL(value, "https://lastroweb.invalid");
    if (
      url.hostname === "file5s.ratemyserver.net" ||
      url.hostname === "ratemyserver.net" ||
      url.hostname.endsWith(".ratemyserver.net")
    )
      return rmsAssetUrl(url.pathname);
  } catch {
    /* Keep malformed or non-RMS values for the normal escaping path. */
  }
  return value;
}

const GROUPS = [
  { key: "name", label: "物品名称命中", hint: "名称中包含搜索词" },
  {
    key: "shop",
    label: "商店名称命中",
    hint: "商店标题中包含搜索词 · 按商店聚合",
  },
  {
    key: "vendor",
    label: "商人名称命中",
    hint: "摆摊玩家名称中包含搜索词 · 按玩家聚合",
  },
] as const;

const DEFAULT_SCOPES: SearchScopes = { name: true, shop: true, vendor: true };

const SORT_OPTIONS: Array<{
  value: SearchFilters["sort"];
  label: string;
  note: string;
}> = [
  { value: "price_asc", label: "价格从低到高", note: "按价格由低到高" },
  { value: "price_desc", label: "价格从高到低", note: "按价格由高到低" },
  { value: "changed_desc", label: "最近变动", note: "按最近变动排序" },
];

export function renderSearchResults(
  container: HTMLElement,
  page: SearchPage<ListingSearchResult>,
  state: RenderState,
): void {
  const safeItems = page.items ?? [];
  if (state.loading && safeItems.length === 0) {
    container.innerHTML =
      '<p role="status" class="state-message">正在加载市场数据...</p>';
    return;
  }
  if (state.error) {
    container.innerHTML = statePanelMarkup(
      "error",
      "市场查询失败，请稍后再试",
      friendlyError(
        state.error,
        "市场查询接口暂不可用，请确认本地服务已启动。",
      ),
      "重新加载",
    );
    return;
  }
  if (state.empty || safeItems.length === 0) {
    container.innerHTML = `${statePanelMarkup("empty", "没有找到匹配的在售商品", "换一个关键词，或放宽价格、地图与商店类型等筛选条件后再试试。")}${catalogHistoryMarkup(state)}`;
    return;
  }

  const query = state.filters?.q;
  const scopes = state.scopes ?? DEFAULT_SCOPES;
  const groups = groupListings(safeItems, query, scopes);
  const visibleCount = groups.reduce((total, group) => total + group.length, 0);
  // 服务器有返回，但商品都落在用户已关闭的命中范围：给出引导提示，不走空结果兜底。
  if (query && visibleCount === 0) {
    container.innerHTML = scopeNoticeMarkup();
    return;
  }
  const sections = GROUPS.map((group, index) => {
    const items = groups[index] ?? [];
    if (items.length === 0) return "";
    const countLabel = groupCountLabel(group.key, items);
    const body = groupBody(group.key, items, query);
    return `<section class="result-group" data-group="${group.key}">
        <header class="group-heading">
          <span class="group-heading-copy"><strong>${group.label}</strong><small>${group.hint}</small></span>
          <span class="group-count">${countLabel}</span>
          <button type="button" class="group-toggle" aria-expanded="true" aria-controls="group-body-${group.key}" aria-label="收起${group.label}" title="收起${group.label}" data-group-label="${group.label}"><i class="ph ph-caret-down" aria-hidden="true"></i></button>
        </header>
        <div id="group-body-${group.key}" class="group-body">${body}</div>
      </section>`;
  }).join("");
  const pageIndex = state.pageIndex ?? 0;
  const pageSize = state.filters?.limit || safeItems.length;
  const rangeStart = pageIndex * pageSize + 1;
  const rangeEnd = rangeStart + safeItems.length - 1;
  const rangeLabel = `${rangeStart} – ${rangeEnd}`;
  const resultCountLabel = state.initialBrowse
    ? `最新收录 ${rangeLabel} 个商品`
    : `查看 ${rangeLabel} 个商品`;
  const activeSort =
    SORT_OPTIONS.find((option) => option.value === state.filters?.sort) ??
    SORT_OPTIONS[0]!;
  const sortOptions = SORT_OPTIONS.map(
    (option) =>
      `<option value="${option.value}"${option.value === activeSort.value ? " selected" : ""}>${option.label}</option>`,
  ).join("");
  const descriptionNotice = state.descriptionError
    ? `<p role="status" class="description-notice">物品详细描述加载失败，当前显示词条信息。${escape(state.descriptionError)}</p>`
    : "";
  const topPager = pagerBarMarkup(page, state, pageIndex, rangeLabel, "");
  const bottomPager = pagerBarMarkup(
    page,
    state,
    pageIndex,
    rangeLabel,
    "is-bottom",
  );
  container.innerHTML = `${descriptionNotice}<div class="results-toolbar"><div class="results-overview"><div><strong>${resultCountLabel}</strong></div><span class="results-note">按命中位置分组 · ${activeSort.note}</span></div><label class="sort-control" for="result-sort"><span>排序</span><select id="result-sort" name="sort" aria-label="结果排序">${sortOptions}</select></label></div>${topPager}${sections}${bottomPager}<div id="item-popover" class="item-pop" role="dialog" aria-label="物品详情" hidden></div>`;
  refreshRelativeTimes(container);
  startRelativeTimer();
}

function pagerBarMarkup(
  page: SearchPage<ListingSearchResult>,
  state: RenderState,
  pageIndex: number,
  rangeLabel: string,
  extraClass: string,
): string {
  const loading = !!state.loading;
  const prevDisabled = pageIndex === 0 || loading;
  const nextDisabled = !page.nextCursor || loading;
  const nextContent = loading
    ? '<i class="ph ph-circle-notch ph-spin" aria-hidden="true"></i>加载中'
    : '下一页<i class="ph ph-caret-right" aria-hidden="true"></i>';
  return `<div class="pager-bar ${extraClass}">
    <button type="button" class="pager-btn pager-btn--prev js-prev-page" ${prevDisabled ? "disabled" : ""} aria-label="加载上一页"><i class="ph ph-caret-left" aria-hidden="true"></i>上一页</button>
    <div class="pager-position"><small>第 ${pageIndex + 1} 页</small><strong>${rangeLabel}</strong></div>
    <button type="button" class="pager-btn pager-btn--next js-next-page" ${nextDisabled ? "disabled" : ""} aria-label="加载下一页">${nextContent}</button>
  </div>`;
}

export function renderSearchResultsWithCatalog(
  container: HTMLElement,
  page: SearchPage<ListingSearchResult>,
  state: RenderState,
  catalog: readonly ItemAutocomplete[],
  descriptions: readonly ItemDescription[] = [],
): void {
  const query = String(state.filters?.q ?? "").trim();
  const safeItems = page.items ?? [];
  // 市场无在售结果时，用静态物品图鉴兜底，给出可查历史价格的相关道具。
  const fallbackActive =
    !state.loading &&
    !state.error &&
    (state.empty || safeItems.length === 0) &&
    query.length > 0;
  const catalogSuggestions = fallbackActive
    ? findCatalogMatches(catalog, query, SEARCH_ITEM_ID_LIMIT)
    : [];
  const matchedIds = new Set(catalogSuggestions.map((item) => item.itemId));
  const catalogDescriptions = catalogSuggestions.length
    ? new Map(
        descriptions
          .filter((description) => matchedIds.has(description.itemId))
          .map(
            (description) =>
              [description.itemId, description.description] as const,
          ),
      )
    : null;
  renderSearchResults(
    container,
    hydrateSearchPage(page, catalog, descriptions),
    catalogDescriptions
      ? { ...state, catalogSuggestions, catalogDescriptions }
      : { ...state, catalogSuggestions },
  );
}

type HistoryItemBrief = Pick<
  ListingSearchResult,
  "itemId" | "itemName" | "itemIcon"
>;

export type DrawerCloseTarget = "close-history" | "close-map";

/** 统一的右侧抽屉骨架：吸顶圆形关闭钮 + 正文 + 底部长条圆角关闭钮。 */
export function drawerFrame(
  closeId: DrawerCloseTarget,
  closeLabel: string,
  body: string,
  innerClass = "",
): string {
  return `<div class="drawer-head"><button type="button" class="drawer-close" id="${closeId}" data-close-drawer aria-label="${escape(closeLabel)}"><i class="ph ph-x" aria-hidden="true"></i></button></div><div class="drawer-inner${innerClass ? ` ${innerClass}` : ""}"><div class="drawer-body">${body}</div><button type="button" class="drawer-close-footer" data-close-drawer><i class="ph ph-x" aria-hidden="true"></i>关闭</button></div>`;
}

export function renderHistory(
  drawer: HTMLElement,
  history: HistoryPage | ItemMarketHistory,
  item?: number | HistoryItemBrief,
): void {
  if ("currentListings" in history) {
    renderItemMarketHistory(
      drawer,
      history,
      typeof item === "number" ? undefined : item,
    );
    return;
  }
  const listingId = typeof item === "number" ? item : undefined;
  const sales = history.inferredSales ?? [];
  const body = `<p class="drawer-kicker">成交观察</p><h2>价格历史</h2>${history.items.length ? `<ol>${history.items.map((item) => `<li><time>${new Date(item.observedAt).toLocaleString("zh-CN")}</time><strong>${item.price.toLocaleString("zh-CN")} <small>z / ${item.quantity} 件</small></strong><span>${translateHistoryEvent(item.eventType)}</span></li>`).join("")}</ol>` : "<p>暂无历史记录</p>"}${sales.length ? `<h3>售出</h3><ul>${sales.map((sale) => `<li><strong>售出</strong>：${sale.soldQuantity}（${sale.fromQuantity} → ${sale.toQuantity}）· ${escape(translateHistoryEvent(sale.reason))} <time>${new Date(sale.observedAt).toLocaleString("zh-CN")}</time></li>`).join("")}</ul>` : ""}${history.nextCursor && listingId ? `<button type="button" id="next-history" data-listing-id="${listingId}" data-cursor="${escape(history.nextCursor)}" aria-label="加载更多历史">加载更多</button>` : ""}`;
  drawer.innerHTML = drawerFrame("close-history", "关闭价格历史", body);
  drawer.hidden = false;
}

function renderItemMarketHistory(
  drawer: HTMLElement,
  history: ItemMarketHistory,
  item?: HistoryItemBrief,
): void {
  const itemName = item?.itemName || `未知物品 #${history.itemId}`;
  const itemIcon = proxyRmsAsset(
    item?.itemIcon ||
      rmsAssetUrl(
        `items/large/${encodeURIComponent(String(history.itemId))}.gif`,
      ),
  );
  const activeUnits = history.currentListings.reduce(
    (sum, listing) => sum + listing.quantity,
    0,
  );
  const earliestEvent = history.events.reduce(
    (min, event) => Math.min(min, event.observedAt),
    history.windowEnd,
  );
  const eventRange = formatDateRange(earliestEvent, history.windowEnd);
  const trendKicker =
    history.events.length === 0
      ? "市场走势"
      : `${describeTimeSpan(history.windowEnd - earliestEvent)}市场走势`;
  const currentListings = history.currentListings.length
    ? `<ul class="history-list current-listings">${history.currentListings.map((listing) => `<li><div><strong>${listing.price.toLocaleString("zh-CN")} <small>z</small></strong><span>${escape(listing.title || "未命名商店")} · ${escape(listing.vendorName || "未知玩家")}</span></div><div class="history-row-meta"><span>${listing.quantity} 件 · ${escape(listing.mapName || "未知地图")}</span><time>${new Date(listing.lastChangedAt).toLocaleString("zh-CN")}</time></div></li>`).join("")}</ul>`
    : '<p class="history-empty">当前没有正在出售的记录</p>';
  const sales = history.sales.length
    ? `<ul class="history-list history-sales">${history.sales.map((sale) => `<li><div><span>此道具在 <time>${new Date(sale.observedAt).toLocaleString("zh-CN")}</time> 以 ${sale.price.toLocaleString("zh-CN")} Zeny 售出 ${sale.soldQuantity} 个 · ${escape(sale.title || "未命名商店")} / ${escape(sale.vendorName || "未知玩家")}</span></div></li>`).join("")}</ul>`
    : '<p class="history-empty">暂时没有可确认的售出变动</p>';
  const body = `
    <section class="history-item-summary" aria-label="查询物品">
      <div class="history-item-art"><img src="${escape(itemIcon)}" alt="${escape(itemName)}" data-image-fallback /><span class="detail-art-fallback" aria-hidden="true" hidden>RO</span></div>
      <div><p class="drawer-kicker">物品市场</p><h2>${escape(itemName)}</h2><p>物品 ID ${history.itemId}</p></div>
    </section>
    <div class="history-stat-strip" aria-label="市场概览"><span><strong>${history.currentListings.length}</strong> 间在售商店</span><span><strong>${activeUnits}</strong> 件当前库存</span><span><strong>${history.sales.length}</strong> 次售出记录</span></div>
    <section class="history-section">
      <div class="history-section-heading"><div><p class="drawer-kicker">${trendKicker}</p><h3>价格与库存</h3></div><time>${eventRange}</time></div>
      <p class="history-chart-explanation">红色色带为各商店的报价区间（最低 — 最高），红色中线是中位价；绿色阶梯线为市场总库存。图形按固定时间粒度汇总全部观察记录，悬停或聚焦后用方向键可查看每个时段的明细。</p>
      ${renderHistoryTrend(history)}
    </section>
    <section class="history-section"><div class="history-section-heading"><div><p class="drawer-kicker">当前在售</p><h3>所有出售商店</h3></div><span>${history.currentListings.length} 条</span></div>${currentListings}</section>
    <section class="history-section"><div class="history-section-heading"><div><p class="drawer-kicker">历史成交</p><h3>售出记录</h3></div><span>${history.sales.length} 条</span></div>${sales}</section>`;
  drawer.innerHTML = drawerFrame(
    "close-history",
    "关闭价格历史",
    body,
    "history-drawer-inner",
  );
  attachHistoryChart(drawer);
  drawer.hidden = false;
}

const TREND_SAMPLE_COUNT = 60;
const TREND_VIEW = { width: 420, height: 210 };
const TREND_FRAME = { left: 46, top: 16, width: 314, height: 156 };

type TrendSample = {
  time: number;
  min: number | null;
  median: number | null;
  max: number | null;
  stock: number;
  shops: number;
  known: boolean;
};

type TrendPointView = {
  x: number;
  ym: number | null;
  ys: number;
  med: number | null;
  lo: number | null;
  hi: number | null;
  stock: number;
  shops: number;
  t: number;
};

const INACTIVE_EVENT_TYPES = new Set(["missing", "expired"]);

function renderHistoryTrend(history: ItemMarketHistory): string {
  const events = history.events;
  if (events.length === 0)
    return '<p class="history-empty">暂时没有足够的价格或库存变动，无法绘制走势。</p>';

  // X 轴严格跟随实际数据：从最早一条观察开始，到当前时刻结束，不预设窗口长度。
  const chartStart = events[0]!.observedAt;
  const chartEnd = history.windowEnd;
  const samples = buildTrendSamples(events, chartStart, chartEnd);
  const priced = samples.filter(
    (
      sample,
    ): sample is TrendSample & { min: number; median: number; max: number } =>
      sample.median !== null,
  );
  const frame = TREND_FRAME;
  const span = Math.max(1, chartEnd - chartStart);
  const xOf = (value: number) =>
    frame.left + ((value - chartStart) / span) * frame.width;

  let priceLo = 0;
  let priceHi = 1;
  if (priced.length > 0) {
    const lo = Math.min(...priced.map((sample) => sample.min));
    const hi = Math.max(...priced.map((sample) => sample.max));
    const padding = Math.max(1, (hi - lo) * 0.06);
    priceLo = Math.max(0, lo - padding);
    priceHi = hi + padding;
  }
  const stockHi = Math.max(1, ...samples.map((sample) => sample.stock)) * 1.18;
  const yPrice = (value: number) =>
    frame.top + (1 - (value - priceLo) / (priceHi - priceLo)) * frame.height;
  const yStock = (value: number) =>
    frame.top + (1 - value / stockHi) * frame.height;
  const rounded = (value: number) => Math.round(value * 100) / 100;

  // Horizontal grid rows with both-axis labels.
  const gridRows = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const y = frame.top + (1 - fraction) * frame.height;
      const line =
        fraction > 0 && fraction < 1
          ? `<line x1="${frame.left}" y1="${y}" x2="${frame.left + frame.width}" y2="${y}" class="history-chart-grid"/>`
          : "";
      const priceValue = priceLo + (priceHi - priceLo) * fraction;
      const stockValue = stockHi * fraction;
      return `${line}<text x="${frame.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" class="history-chart-tick">${formatAxisNumber(priceValue)} z</text><text x="${frame.left + frame.width + 6}" y="${y}" text-anchor="start" dominant-baseline="middle" class="history-chart-tick">${formatAxisNumber(stockValue)} 件</text>`;
    })
    .join("");

  // Price band (min-max) and median line, split into contiguous runs.
  let bands = "";
  let medians = "";
  for (let start = 0; start < samples.length; ) {
    if (samples[start]!.median === null) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < samples.length && samples[end]!.median !== null) end += 1;
    const run = samples.slice(start, end);
    const upper = run
      .map(
        (sample) =>
          `L${rounded(xOf(sample.time))} ${rounded(yPrice(sample.max!))}`,
      )
      .join("");
    const lower = run
      .slice()
      .reverse()
      .map(
        (sample) =>
          `L${rounded(xOf(sample.time))} ${rounded(yPrice(sample.min!))}`,
      )
      .join("");
    bands += `<path d="M${rounded(xOf(run[0]!.time))} ${rounded(yPrice(run[0]!.max!))}${upper}${lower}Z" class="history-chart-band"/>`;
    medians += `<path d="M${run.map((sample) => `${rounded(xOf(sample.time))} ${rounded(yPrice(sample.median!))}`).join(" L")}" class="history-chart-median"/>`;
    start = end;
  }

  // Total stock: step-after line with faint area, starting when any listing is known.
  const firstKnown = samples.findIndex((sample) => sample.known);
  let stockArea = "";
  let stockLine = "";
  if (firstKnown !== -1) {
    const run = samples.slice(firstKnown);
    const x = (index: number) => rounded(xOf(run[index]!.time));
    const y = (index: number) => rounded(yStock(run[index]!.stock));
    let top = `M${x(0)} ${y(0)}`;
    for (let index = 1; index < run.length; index += 1)
      top += `H${x(index)}L${x(index)} ${y(index)}`;
    stockLine = `<path d="${top}" class="history-chart-stock-line"/>`;
    stockArea = `<path d="${top}L${x(run.length - 1)} ${frame.top + frame.height}H${x(0)}Z" class="history-chart-stock-area"/>`;
  }

  // Individual observations stay visible only for small datasets.
  const rawDots =
    events.length <= 20
      ? events
          .filter((event) => event.quantity > 0)
          .map(
            (event) =>
              `<circle cx="${rounded(xOf(event.observedAt))}" cy="${rounded(yPrice(event.price))}" r="2.2" class="history-chart-rawpoint"><title>${formatTipDate(event.observedAt)} · ${event.price.toLocaleString("zh-CN")} z</title></circle>`,
          )
          .join("")
      : "";

  // X 轴刻度按跨度动态选择（整点小时 / 自然日），跨日 0 点显示月日。
  const dateTicks = buildTimeTicks(chartStart, chartEnd)
    .map((tick, index, ticks) => {
      const anchor =
        index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle";
      return `<text x="${xOf(tick.time)}" y="${frame.top + frame.height + 18}" text-anchor="${anchor}" class="history-chart-date">${tick.label}</text>`;
    })
    .join("");

  const points: TrendPointView[] = samples.map((sample) => ({
    x: rounded(xOf(sample.time)),
    ym: sample.median === null ? null : rounded(yPrice(sample.median)),
    ys: rounded(yStock(sample.stock)),
    med: sample.median,
    lo: sample.min,
    hi: sample.max,
    stock: sample.stock,
    shops: sample.shops,
    t: sample.time,
  }));

  const latest = priced.at(-1);
  const summary = latest
    ? `最新中位价 ${latest.median.toLocaleString("zh-CN")} z，报价区间 ${latest.min.toLocaleString("zh-CN")} 至 ${latest.max.toLocaleString("zh-CN")} z，市场总库存 ${latest.stock.toLocaleString("zh-CN")} 件，${latest.shops} 间商店在售`
    : "窗口内暂无可报价的在售记录";

  return `<div class="history-chart" data-history-chart>
    <div class="history-chart-legend"><span><i class="chart-key chart-key-median"></i>中位价</span><span><i class="chart-key chart-key-band"></i>价格区间</span><span><i class="chart-key chart-key-stock"></i>总库存</span></div>
    <svg viewBox="0 0 ${TREND_VIEW.width} ${TREND_VIEW.height}" tabindex="0" role="img" aria-label="价格与库存走势（${describeTimeSpan(span)}）：${summary}" data-trend-svg data-trend="${encodeURIComponent(JSON.stringify(points))}">
      <defs><linearGradient id="history-stock-fade" x1="0" y1="${frame.top}" x2="0" y2="${frame.top + frame.height}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1d332b" stop-opacity=".12"/><stop offset="1" stop-color="#1d332b" stop-opacity="0"/></linearGradient></defs>
      <rect x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" class="history-chart-frame"/>
      ${gridRows}${stockArea}${stockLine}${bands}${medians}${rawDots}${dateTicks}
      <g class="history-chart-hover" data-hover visibility="hidden">
        <line data-hover-line x1="${frame.left}" y1="${frame.top}" x2="${frame.left}" y2="${frame.top + frame.height}" class="history-chart-cross"/>
        <circle data-hover-stock cx="${frame.left}" cy="${frame.top + frame.height}" r="3.6" class="history-chart-hover-stock"/>
        <circle data-hover-price cx="${frame.left}" cy="${frame.top}" r="3.6" class="history-chart-hover-price"/>
      </g>
      <rect data-hover-overlay x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" class="history-chart-overlay"/>
    </svg>
    <div class="history-chart-tip" data-tip role="status"></div>
  </div>`;
}

function buildTrendSamples(
  events: ItemMarketHistory["events"],
  chartStart: number,
  chartEnd: number,
): TrendSample[] {
  const span = Math.max(1, chartEnd - chartStart);
  const states = new Map<
    number,
    { price: number; quantity: number; active: boolean }
  >();
  let cursor = 0;
  const samples: TrendSample[] = [];
  for (let index = 0; index < TREND_SAMPLE_COUNT; index += 1) {
    const time = chartStart + (span * index) / (TREND_SAMPLE_COUNT - 1);
    while (cursor < events.length && events[cursor]!.observedAt <= time) {
      const event = events[cursor]!;
      const previous = states.get(event.listingId);
      states.set(event.listingId, {
        price: event.price || previous?.price || 0,
        quantity:
          typeof event.quantity === "number"
            ? event.quantity
            : previous?.quantity || 0,
        active: !INACTIVE_EVENT_TYPES.has(event.eventType),
      });
      cursor += 1;
    }
    if (states.size === 0) {
      samples.push({
        time,
        min: null,
        median: null,
        max: null,
        stock: 0,
        shops: 0,
        known: false,
      });
      continue;
    }
    const prices: number[] = [];
    let stock = 0;
    let shops = 0;
    states.forEach((state) => {
      if (!state.active) return;
      stock += Math.max(0, state.quantity);
      if (state.quantity > 0) {
        prices.push(state.price);
        shops += 1;
      }
    });
    if (prices.length === 0) {
      samples.push({
        time,
        min: null,
        median: null,
        max: null,
        stock,
        shops,
        known: true,
      });
      continue;
    }
    prices.sort((a, b) => a - b);
    const middle = prices.length / 2;
    samples.push({
      time,
      min: prices[0]!,
      median:
        prices.length % 2 === 0
          ? (prices[middle - 1]! + prices[middle]!) / 2
          : prices[Math.floor(middle)]!,
      max: prices.at(-1)!,
      stock,
      shops,
      known: true,
    });
  }
  return samples;
}

function attachHistoryChart(drawer: HTMLElement): void {
  const root = drawer.querySelector<HTMLElement>("[data-history-chart]");
  const svg = drawer.querySelector<SVGSVGElement>("[data-trend-svg]");
  if (!root || !svg) return;
  let points: TrendPointView[];
  try {
    points = JSON.parse(
      decodeURIComponent(svg.dataset.trend ?? ""),
    ) as TrendPointView[];
  } catch {
    return;
  }
  const hover = svg.querySelector<SVGGElement>("[data-hover]");
  const line = svg.querySelector<SVGLineElement>("[data-hover-line]");
  const priceDot = svg.querySelector<SVGCircleElement>("[data-hover-price]");
  const stockDot = svg.querySelector<SVGCircleElement>("[data-hover-stock]");
  const overlay = svg.querySelector<SVGRectElement>("[data-hover-overlay]");
  const tip = root.querySelector<HTMLElement>("[data-tip]");
  if (!hover || !line || !priceDot || !stockDot || !overlay || !tip) return;

  let activeIndex = -1;
  const hide = (): void => {
    activeIndex = -1;
    hover.setAttribute("visibility", "hidden");
    tip.classList.remove("is-visible");
  };
  const show = (index: number): void => {
    activeIndex = index;
    const point = points[index]!;
    line.setAttribute("x1", String(point.x));
    line.setAttribute("x2", String(point.x));
    stockDot.setAttribute("cx", String(point.x));
    stockDot.setAttribute("cy", String(point.ys));
    priceDot.setAttribute("cx", String(point.x));
    if (point.ym === null) priceDot.setAttribute("visibility", "hidden");
    else {
      priceDot.setAttribute("visibility", "visible");
      priceDot.setAttribute("cy", String(point.ym));
    }
    hover.setAttribute("visibility", "visible");

    tip.innerHTML = `<p class="history-chart-tip-date">${formatTipDate(point.t)}</p>${
      point.med === null
        ? '<p class="history-chart-tip-row"><span>报价</span><b>该时段无在售</b></p>'
        : `<p class="history-chart-tip-row"><span>中位价</span><b>${point.med.toLocaleString("zh-CN")} z</b></p><p class="history-chart-tip-row"><span>区间</span><b>${point.lo!.toLocaleString("zh-CN")} – ${point.hi!.toLocaleString("zh-CN")} z</b></p>`
    }<p class="history-chart-tip-row"><span>库存</span><b>${point.stock.toLocaleString("zh-CN")} 件 · ${point.shops} 间</b></p>`;

    const svgRect = svg.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    tip.style.left = `${(point.x / TREND_VIEW.width) * svgRect.width + (svgRect.left - rootRect.left)}px`;
    tip.style.top = `${((point.ym === null ? point.ys : point.ym) / TREND_VIEW.height) * svgRect.height + (svgRect.top - rootRect.top)}px`;
    tip.classList.toggle("is-left", point.x > TREND_VIEW.width * 0.55);
    tip.classList.add("is-visible");
  };
  const nearest = (clientX: number): number => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return activeIndex === -1 ? 0 : activeIndex;
    const location = svg.createSVGPoint();
    location.x = clientX;
    const transformed = location.matrixTransform(ctm.inverse());
    let best = 0;
    let bestDistance = Infinity;
    points.forEach((point, index) => {
      const distance = Math.abs(point.x - transformed.x);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  };

  overlay.addEventListener("pointermove", (event) => {
    show(nearest(event.clientX));
  });
  overlay.addEventListener("pointerleave", hide);
  svg.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const fallback = event.key === "ArrowLeft" ? points.length - 1 : 0;
      const next =
        activeIndex === -1
          ? fallback
          : Math.max(
              0,
              Math.min(
                points.length - 1,
                activeIndex + (event.key === "ArrowLeft" ? -1 : 1),
              ),
            );
      show(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      show(0);
    } else if (event.key === "End") {
      event.preventDefault();
      show(points.length - 1);
    } else if (event.key === "Escape") hide();
  });
}

function formatAxisNumber(value: number): string {
  if (value >= 1e8) return `${Number((value / 1e8).toFixed(1))}亿`;
  if (value >= 1e4) return `${Number((value / 1e4).toFixed(1))}万`;
  return String(Math.round(value));
}
function formatTipDate(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function formatShortDate(value: number): string {
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function describeTimeSpan(span: number): string {
  if (span < DAY_MS) return `${Math.max(1, Math.round(span / HOUR_MS))} 小时`;
  return `${Math.max(1, Math.ceil(span / DAY_MS))} 天`;
}

function formatDateRange(start: number, end: number): string {
  const startDay = startOfLocalDay(start);
  const endDay = startOfLocalDay(end);
  if (startDay === endDay) return formatShortDate(end);
  return `${formatShortDate(start)} - ${formatShortDate(end)}`;
}

function startOfLocalDay(value: number): number {
  const date = new Date(value);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

type TimeTickSpec = { step: number; byHour: boolean };

const TICK_STEPS: TimeTickSpec[] = [
  { step: HOUR_MS, byHour: true },
  { step: 3 * HOUR_MS, byHour: true },
  { step: 6 * HOUR_MS, byHour: true },
  { step: 12 * HOUR_MS, byHour: true },
  { step: DAY_MS, byHour: false },
  { step: 2 * DAY_MS, byHour: false },
  { step: 5 * DAY_MS, byHour: false },
  { step: 10 * DAY_MS, byHour: false },
];

function buildTimeTicks(
  start: number,
  end: number,
): Array<{ time: number; label: string }> {
  const span = Math.max(1, end - start);
  // 目标 4–6 个刻度：取第一个让 span/step <= 6 的自然步长。
  const spec =
    TICK_STEPS.find((candidate) => span / candidate.step <= 6) ??
    TICK_STEPS.at(-1)!;
  const ticks: Array<{ time: number; label: string }> = [];
  let time = floorTickBoundary(start, spec);
  if (time < start) time += spec.step;
  while (time <= end) {
    ticks.push({ time, label: formatTickLabel(time, spec) });
    time += spec.step;
  }
  // 自然刻度离端点过远时补精确端点，保证范围边界可辨。
  if (ticks.length === 0 || ticks[0]!.time - start > span * 0.18) {
    ticks.unshift({ time: start, label: formatEdgeTickLabel(start, spec) });
  }
  if (end - ticks[ticks.length - 1]!.time > span * 0.18) {
    ticks.push({ time: end, label: formatEdgeTickLabel(end, spec) });
  }
  return ticks;
}

function floorTickBoundary(value: number, spec: TimeTickSpec): number {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  if (spec.byHour) {
    const stepHours = spec.step / HOUR_MS;
    date.setHours(date.getHours() - (date.getHours() % stepHours));
    return date.getTime();
  }
  date.setHours(0, 0, 0, 0);
  const dayStep = spec.step / DAY_MS;
  if (dayStep === 1) return date.getTime();
  const localDay = Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  );
  const alignedDay = localDay - (localDay % dayStep);
  const aligned = new Date(alignedDay * DAY_MS);
  return new Date(
    aligned.getUTCFullYear(),
    aligned.getUTCMonth(),
    aligned.getUTCDate(),
  ).getTime();
}

function formatTickLabel(value: number, spec: TimeTickSpec): string {
  const date = new Date(value);
  if (spec.byHour) {
    // 小时刻度下仅跨日 0 点替换为月日，其余显示整点。
    if (date.getHours() === 0)
      return `${date.getMonth() + 1}/${date.getDate()}`;
    return `${String(date.getHours()).padStart(2, "0")}:00`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatEdgeTickLabel(value: number, spec: TimeTickSpec): string {
  const date = new Date(value);
  if (!spec.byHour) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function renderHistoryError(
  drawer: HTMLElement,
  message: unknown,
  item?: HistoryItemBrief,
): void {
  // 服务端返回的中文错误作为补充明细展示；非中文（网络层错误等）则只展示通用说明。
  const detail = friendlyError(message, "");
  const hasCustomDetail = detail !== "" && detail !== "暂无可供查询的价格历史。";
  const itemName = item?.itemName?.trim() || "未知物品";
  const icon = proxyRmsAsset(
    item?.itemIcon ||
      rmsAssetUrl(
        `items/large/${encodeURIComponent(String(item?.itemId ?? 0))}.gif`,
      ),
  );
  const body = `<p class="drawer-kicker">价格历史 / PRICE HISTORY</p>
  <div class="history-state-item">
    <span class="history-state-item-icon"><img src="${escape(icon)}" alt="" loading="lazy" /></span>
    <div class="history-state-item-copy">
      <strong>${escape(itemName)}</strong>
      <small>物品 #${escape(String(item?.itemId ?? ""))}</small>
    </div>
  </div>
  <div class="history-state" role="alert">
    <span class="history-state-medal" aria-hidden="true"><i class="ph ph-chart-line-down"></i></span>
    <h2>暂无可供查询的价格历史</h2>
    <p>「${escape(itemName)}」近期还没有采集到摆摊或成交记录。价格历史来自全服商人摆摊采集，新上架或冷门物品可能暂未收录；网络波动或服务重启时也会出现此提示。</p>
    <button type="button" class="history-state-retry" data-retry-history><i class="ph ph-arrows-clockwise" aria-hidden="true"></i>重新查询</button>
    <p class="history-state-hint"><i class="ph ph-info" aria-hidden="true"></i>点击重试不会关闭当前抽屉</p>
    ${hasCustomDetail ? `<p class="history-state-detail">${escape(detail)}</p>` : ""}
  </div>`;
  drawer.innerHTML = drawerFrame("close-history", "关闭价格历史", body);
  drawer.hidden = false;
}

function groupListings(
  items: ListingSearchResult[],
  query?: string,
  scopes: SearchScopes = DEFAULT_SCOPES,
): ListingSearchResult[][] {
  const groups: ListingSearchResult[][] = GROUPS.map(() => []);
  const normalized = normalizeGroupValue(query);
  items.forEach((item) => {
    if (!normalized) {
      groups[0]!.push(item);
      return;
    }
    // 只在用户开启的命中范围内归组；名称未命中时可继续落到商店/商人组。
    const fields = [
      normalizeGroupValue(item.itemName),
      normalizeGroupValue(item.title),
      normalizeGroupValue(item.vendorName),
    ];
    for (let index = 0; index < GROUPS.length; index += 1) {
      if (scopes[GROUPS[index]!.key] && fields[index]!.includes(normalized)) {
        groups[index]!.push(item);
        return;
      }
    }
  });
  return groups;
}

function scopeNoticeMarkup(): string {
  return `<div class="scope-empty" role="status">
    <span class="scope-empty-icon" aria-hidden="true"><i class="ph ph-funnel"></i></span>
    <div class="scope-empty-copy">
      <h2>当前命中范围下没有可展示的结果</h2>
      <p>本页商品都没有落在已开启的命中范围中。可在左侧「高级搜索 · 命中范围」里开启更多范围（道具名称 / 商店名称 / 商人名称）。</p>
    </div>
  </div>`;
}

function normalizeGroupValue(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

/* ------------------------------------------------------------------ */
/* 分组主体：物品卡片 / 商店卡片 / 商人卡片                              */
/* ------------------------------------------------------------------ */

type Aggregate = { key: string; items: ListingSearchResult[] };

function aggregateItems(
  items: ListingSearchResult[],
  keyOf: (item: ListingSearchResult) => string,
): Aggregate[] {
  const buckets = new Map<string, ListingSearchResult[]>();
  items.forEach((item) => {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  });
  return Array.from(buckets, ([key, group]) => ({ key, items: group }));
}

function groupCountLabel(key: string, items: ListingSearchResult[]): string {
  if (key === "name") return `${items.length} 条`;
  if (key === "shop")
    return `${aggregateItems(items, storeKey).length} 间商店 · ${items.length} 件商品`;
  return `${aggregateItems(items, (item) => String(item.vendorName ?? "")).length} 位商人 · ${items.length} 件商品`;
}

function groupBody(
  key: string,
  items: ListingSearchResult[],
  query?: string,
): string {
  if (key === "name")
    return `<div class="name-stack">${items.map((item) => renderMarketCard(item, query)).join("")}</div>`;
  if (key === "shop") return renderShopGroup(items, query);
  return renderVendorGroup(items, query);
}

function storeKey(item: ListingSearchResult): string {
  const coordinates = getCoordinates(item as RichListing, item.mapName);
  return `${item.mapName}|${coordinates.x}|${coordinates.y}|${item.title ?? ""}|${item.vendorName ?? ""}`;
}

function optionTexts(item: ListingSearchResult): string[] {
  return item.options.map(
    (option) =>
      option.display ||
      `未知词条 type=${option.type} value=${option.value} param=${option.param}`,
  );
}

function optionsChipsMarkup(item: ListingSearchResult): string {
  const options = optionTexts(item);
  return options
    .map((text) => `<span class="opt-chip">${escape(text)}</span>`)
    .join("");
}

function catalogItemIconUrl(itemId: number, name?: string): string {
  // 数据库不区分道具类型，采用硬规则：名称以「卡片」结尾时统一使用 card.gif。
  const file = String(name ?? "").endsWith("卡片") ? "card" : String(itemId);
  return rmsAssetUrl(`items/small/${encodeURIComponent(file)}.gif`);
}

function itemIconUrl(
  item: Pick<ListingSearchResult, "itemId" | "itemName">,
): string {
  return catalogItemIconUrl(item.itemId, item.itemName);
}

function itemIconMarkup(item: ListingSearchResult): string {
  const rich = item as RichListing;
  const rawName = String(item.itemName ?? "");
  if (/[<>]/u.test(rawName))
    return `<span class="item-icon-fallback" aria-hidden="true">${escape(item.itemId)}</span>`;
  const icon = proxyRmsAsset(rich.itemIcon || itemIconUrl(item));
  return `<img src="${escape(icon)}" alt="" loading="lazy" data-image-fallback /><span class="item-icon-fallback" aria-hidden="true" hidden>${escape(item.itemId)}</span>`;
}

function historyButtonMarkup(
  item: ListingSearchResult,
  itemName: string,
  icon: string,
): string {
  return `<button class="history-button" data-listing-id="${escape(item.id)}" data-item-id="${escape(item.itemId)}" data-item-name="${escape(itemName)}" data-item-icon="${escape(icon)}" type="button" aria-label="查看${escape(itemName)}价格历史"><i class="ph ph-chart-bar" aria-hidden="true"></i><span class="hb-label">价格历史</span></button>`;
}

/* ---- 无在售结果：物品图鉴兜底 · 历史价格查询 ---- */

const CATALOG_HISTORY_DISPLAY = 8;

function catalogHistoryMarkup(state: RenderState): string {
  const matches = state.catalogSuggestions;
  if (!matches || matches.length === 0) return "";
  const term = String(state.filters?.q ?? "").trim();
  const visible = matches.slice(0, CATALOG_HISTORY_DISPLAY);
  const totalLabel =
    matches.length >= SEARCH_ITEM_ID_LIMIT
      ? `${SEARCH_ITEM_ID_LIMIT}+`
      : String(matches.length);
  const cards = visible
    .map((item) =>
      renderCatalogHistoryCard(
        item,
        term,
        state.catalogDescriptions?.get(item.itemId),
      ),
    )
    .join("");
  const foot =
    matches.length > visible.length
      ? `<p class="catalog-history-foot"><i class="ph ph-info" aria-hidden="true"></i>仅展示前 ${visible.length} 个相关道具（共 ${totalLabel} 个匹配），输入更完整的道具名可以缩小范围。</p>`
      : "";
  return `<section class="catalog-history" aria-labelledby="catalog-history-title">
    <header class="catalog-history-head">
      <div class="catalog-history-copy">
        <p class="catalog-history-kicker">物品图鉴 · 兜底查询</p>
        <h2 id="catalog-history-title">历史价格查询</h2>
        <p>市场上暂时没有在售记录，物品图鉴中找到了与「<strong>${escape(term)}</strong>」相关的道具，可直接查看它们的历史成交与价格走势。</p>
      </div>
      <span class="catalog-history-count"><i class="ph ph-archive" aria-hidden="true"></i>${totalLabel} 个相关道具</span>
    </header>
    <div class="catalog-history-stack">${cards}</div>
    ${foot}
  </section>`;
}

function renderCatalogHistoryCard(
  item: ItemAutocomplete,
  query: string,
  rawDescription?: string,
): string {
  const name = item.name || `未知物品 #${item.itemId}`;
  const icon = catalogItemIconUrl(item.itemId, name);
  const excerpt = rawDescription
    ? catalogDescriptionExcerpt(rawDescription)
    : "";
  const meta = excerpt
    ? `<span class="chc-id">物品 ID ${item.itemId}</span><span class="chc-dot" aria-hidden="true">·</span><span class="chc-desc">${escape(excerpt)}</span>`
    : `<span class="chc-id">物品 ID ${item.itemId}</span>`;
  return `<article class="catalog-history-card">
    <span class="chc-icon"><img src="${escape(icon)}" alt="" loading="lazy" data-image-fallback /><span class="item-icon-fallback" aria-hidden="true" hidden>${item.itemId}</span></span>
    <span class="chc-main"><strong>${highlight(name, query)}</strong><small>${meta}</small></span>
    <button class="history-button chc-history" type="button" data-item-id="${item.itemId}" data-item-name="${escape(name)}" data-item-icon="${escape(icon)}" aria-label="查看${escape(name)}历史价格"><i class="ph ph-chart-bar" aria-hidden="true"></i><span class="hb-label">历史价格</span></button>
  </article>`;
}

function catalogDescriptionExcerpt(raw: string): string {
  const firstLine = cleanItemDescription(raw).split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
}

/* ---- 物品名称命中：独立卡片 ---- */

function renderMarketCard(item: ListingSearchResult, query?: string): string {
  const rich = item as RichListing;
  const itemName = item.itemName || `未知物品 #${item.itemId}`;
  const rawIcon = proxyRmsAsset(rich.itemIcon || itemIconUrl(item));
  const map = mapInfo(item.mapName);
  const coordinates = getCoordinates(rich, item.mapName);
  const marker = mapMarkerPosition(item.mapName, coordinates.x, coordinates.y);
  const optionsMarkup = optionsChipsMarkup(item);
  return `<article class="market-card">
    <div class="mc-icon">${itemIconMarkup(item)}</div>
    <div class="mc-main">
      <span class="mc-id">物品 ID ${escape(item.itemId)}</span>
      <h3>${highlight(itemName, query)}</h3>
      ${optionsMarkup ? `<p class="mc-options">${optionsMarkup}</p>` : ""}
    </div>
    <div class="mc-price">
      <strong>${item.price.toLocaleString("zh-CN")}<small>z</small></strong>
      <span class="mc-qty">×${item.quantity} 件</span>
    </div>
    <div class="mc-loc">
      <span class="loc-pin"><i class="ph ph-map-pin" aria-hidden="true"></i>${escape(map.name)} <span>${coordinates.x}，${coordinates.y}</span></span>
      <button type="button" class="map-button" data-map-name="${escape(map.name)}" data-map-image="${escape(map.image)}" data-map-code="${escape(map.code)}" data-map-x="${coordinates.x}" data-map-y="${coordinates.y}" data-map-marker-left="${marker.left}" data-map-marker-top="${marker.top}" aria-label="查看${escape(map.name)}地图">地图定位</button>
    </div>
    <div class="mc-shop">
      <span>商店 / 玩家</span>
      <strong>${escape(item.title || "未命名商店")}</strong>
      <small>${escape(item.vendorName || "未知玩家")}</small>
    </div>
    <div class="mc-actions">
      <span class="mc-time">收录于 ${relativeTimeMarkup(item.lastChangedAt)}</span>
      ${historyButtonMarkup(item, itemName, rawIcon)}
    </div>
  </article>`;
}

/* ---- 紧凑商品行 ---- */

function renderCompactLine(item: ListingSearchResult): string {
  const rich = item as RichListing;
  const itemName = item.itemName || `未知物品 #${item.itemId}`;
  const rawIcon = proxyRmsAsset(rich.itemIcon || itemIconUrl(item));
  const optionsMarkup = optionsChipsMarkup(item);
  return `<li class="line">
    <span class="line-icon">${itemIconMarkup(item)}</span>
    <span class="line-name"><strong>${escape(itemName)}</strong>${optionsMarkup ? `<small class="line-options">${optionsMarkup}</small>` : ""}</span>
    <span class="line-price">${item.price.toLocaleString("zh-CN")}<small>z</small><span class="line-qty-inline"> · ${item.quantity} 件</span></span>
    <span class="line-qty">${item.quantity} 件</span>
    ${historyButtonMarkup(item, itemName, rawIcon)}
  </li>`;
}

/* ---- 商店名称命中：商店卡片 ---- */

function renderShopGroup(items: ListingSearchResult[], query?: string): string {
  const shops = aggregateItems(items, storeKey);
  return `<div class="shop-stack">${shops.map((shop) => renderShopCard(shop, query)).join("")}</div>`;
}

function renderShopCard(shop: Aggregate, query?: string): string {
  const first = shop.items[0]!;
  const rich = first as RichListing;
  const map = mapInfo(first.mapName);
  const coordinates = getCoordinates(rich, first.mapName);
  const marker = mapMarkerPosition(first.mapName, coordinates.x, coordinates.y);
  const latest = Math.max(
    ...shop.items.map((item) => Number(item.lastChangedAt)),
  );
  return `<article class="shop-card">
    <header class="shop-card-head">
      <span class="shop-avatar"><img src="/ui/shop.svg" alt="露天商店" width="48" height="48" /></span>
      <div class="shop-title-block">
        <h3>${highlight(first.title || "未命名商店", query)}</h3>
        <small>店主 <b>${escape(first.vendorName || "未知玩家")}</b></small>
      </div>
      <div class="shop-meta">
        <div class="shop-meta-row">
          <span class="loc-chip"><i class="ph ph-map-pin" aria-hidden="true"></i>${escape(map.name)} ${coordinates.x}，${coordinates.y}</span>
          <button type="button" class="map-button map-button--tiny" data-map-name="${escape(map.name)}" data-map-image="${escape(map.image)}" data-map-code="${escape(map.code)}" data-map-x="${coordinates.x}" data-map-y="${coordinates.y}" data-map-marker-left="${marker.left}" data-map-marker-top="${marker.top}" aria-label="查看${escape(map.name)}地图">地图定位</button>
        </div>
        <div class="shop-stat-line">
          <i class="ph ph-clock" aria-hidden="true"></i>本页 ${shop.items.length} 件在售商品<span class="dot">·</span>最近变动 ${relativeTimeMarkup(latest)}
        </div>
      </div>
    </header>
    <ul class="line-list">${shop.items.map(renderCompactLine).join("")}</ul>
  </article>`;
}

/* ---- 商人名称命中：商人卡片 + 摊位分组 ---- */

function renderVendorGroup(
  items: ListingSearchResult[],
  query?: string,
): string {
  const vendors = aggregateItems(items, (item) =>
    String(item.vendorName ?? ""),
  );
  return `<div class="vendor-stack">${vendors.map((vendor) => renderVendorCard(vendor, query)).join("")}</div>`;
}

function renderVendorCard(vendor: Aggregate, query?: string): string {
  const first = vendor.items[0]!;
  const stores = aggregateItems(vendor.items, storeKey);
  const latest = Math.max(
    ...vendor.items.map((item) => Number(item.lastChangedAt)),
  );
  return `<article class="vendor-card">
    <header class="vendor-card-head">
      <span class="vendor-avatar"><img src="/ui/vendor.svg" alt="摆摊商人" width="48" height="48" /></span>
      <div class="vendor-title-block">
        <h3>${highlight(first.vendorName || "未知玩家", query)}</h3>
        <small>玩家摊位</small>
      </div>
      <span class="vendor-stats">${stores.length} 间商店<span class="dot">·</span>${vendor.items.length} 件商品<span class="dot">·</span>最近 ${relativeTimeMarkup(latest)}</span>
    </header>
    <div class="vendor-shops">${stores.map(renderVendorShop).join("")}</div>
  </article>`;
}

function renderVendorShop(store: Aggregate): string {
  const first = store.items[0]!;
  const rich = first as RichListing;
  const map = mapInfo(first.mapName);
  const coordinates = getCoordinates(rich, first.mapName);
  const marker = mapMarkerPosition(first.mapName, coordinates.x, coordinates.y);
  return `<div class="vshop">
    <div class="vshop-head">
      <button type="button" class="vshop-chevron" aria-expanded="true" aria-label="收起摊位"><i class="ph ph-caret-down" aria-hidden="true"></i></button>
      <span class="vshop-name"><i class="ph ph-storefront" aria-hidden="true"></i>${escape(first.title || "未命名商店")}</span>
      <span class="vshop-loc">${escape(map.name)} ${coordinates.x}，${coordinates.y}</span>
      <button type="button" class="map-button map-button--tiny" data-map-name="${escape(map.name)}" data-map-image="${escape(map.image)}" data-map-code="${escape(map.code)}" data-map-x="${coordinates.x}" data-map-y="${coordinates.y}" data-map-marker-left="${marker.left}" data-map-marker-top="${marker.top}" aria-label="查看${escape(map.name)}地图">地图定位</button>
    </div>
    <ul class="line-list vshop-body">${store.items.map(renderCompactLine).join("")}</ul>
  </div>`;
}

/* ---- 命中词高亮 ---- */

function highlight(value: unknown, query?: string): string {
  const text = String(value ?? "");
  const term = String(query ?? "").trim();
  if (!term) return escape(text);
  const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${pattern})`, "giu"));
  return parts
    .map((part, index) =>
      index % 2 === 1 ? `<mark>${escape(part)}</mark>` : escape(part),
    )
    .join("");
}

/* ---- 相对时间：刚刚 / X 分钟前 / X 小时前 / X 天前 ---- */

function relativeTimeMarkup(timestamp: number, className = ""): string {
  const valid = Number.isFinite(timestamp) ? timestamp : Date.now();
  const iso = new Date(valid).toISOString();
  return `<time class="rel-time ${className.trim()}" datetime="${iso}" data-relative="${valid}"></time>`;
}

export function formatRelativeTime(
  timestamp: number,
  now = Date.now(),
): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN");
}

function refreshRelativeTimes(root: ParentNode): void {
  const now = Date.now();
  root.querySelectorAll<HTMLElement>("[data-relative]").forEach((element) => {
    const timestamp = Number(element.dataset.relative);
    if (!Number.isFinite(timestamp)) return;
    if (!element.title) element.title = formatDateTime(timestamp);
    element.textContent = formatRelativeTime(timestamp, now);
  });
}

let relativeTimer: number | undefined;

function startRelativeTimer(): void {
  if (
    relativeTimer !== undefined ||
    typeof document === "undefined" ||
    typeof window === "undefined"
  )
    return;
  relativeTimer = window.setInterval(
    () => refreshRelativeTimes(document),
    30_000,
  );
}

function mapInfo(mapName: string): {
  image: string;
  code: string;
  name: string;
} {
  const map = mapDetails(mapName);
  return map
    ? { code: map.code, name: map.name, image: rmsAssetUrl(map.image) }
    : {
        code: "morocc",
        name: mapName || "未知地图",
        image: rmsAssetUrl("maps_xl/morocc_re.gif"),
      };
}

function getCoordinates(
  item: RichListing,
  mapName: string,
): { x: number; y: number } {
  const source = `${mapName} ${String((item as unknown as Record<string, unknown>).coordinates ?? "")}`;
  const match = source.match(
    /(?:坐标|位置)?\s*[（(]?\s*(\d{1,3})\s*[,，]\s*(\d{1,3})/u,
  );
  const rawX = item.x ?? item.mapX ?? Number(match?.[1]);
  const rawY = item.y ?? item.mapY ?? Number(match?.[2]);
  const map = mapDetails(mapName);
  const maxX = map?.maxX ?? 100;
  const maxY = map?.maxY ?? 100;
  return {
    x: Number.isFinite(rawX)
      ? Math.max(0, Math.min(maxX, Math.round(rawX)))
      : Math.round(maxX / 2),
    y: Number.isFinite(rawY)
      ? Math.max(0, Math.min(maxY, Math.round(rawY)))
      : Math.round(maxY / 2),
  };
}

function translateHistoryEvent(value: string): string {
  const labels: Record<string, string> = {
    observed: "观察到上架",
    quantity_decrease: "库存减少",
    price_change: "价格调整",
    quantity_increase: "库存增加",
  };
  return labels[value] ?? value.replace(/_/g, " ");
}
