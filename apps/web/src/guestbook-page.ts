import { MarketApi, type MarketApiClient } from "./api";
import {
  createCatalogLoader,
  createDescriptionLoader,
  findCatalogMatches,
} from "./catalog";
import { cleanItemDescription, rmsAssetUrl } from "./render";
import { tierBadge } from "./tier";
import { siteNavMarkup, mountSiteNav } from "./nav";
import { authApi, AuthApiError, type AuthApiClient } from "./auth/api";
import { authStore, type AuthStore } from "./auth/store";
import type {
  GuestbookAuthor,
  GuestbookCategory,
  GuestbookEntry,
  GuestbookFilters,
  GuestbookReply,
  GuestbookSubmissionInput,
  ItemAutocomplete,
  ItemDescription,
} from "./types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

interface KindStyle {
  readonly label: string;
  readonly icon: string;
}

const kindStyles: Record<GuestbookCategory, KindStyle> = {
  buy: { label: "我要收购", icon: "ph-hand-coins" },
  sell: { label: "我要出售", icon: "ph-storefront" },
  suggestion: { label: "网站建议", icon: "ph-chat-centered-text" },
};

type EntryCatalog = ReadonlyMap<number, ItemAutocomplete>;
type EntryDescriptions = ReadonlyMap<number, ItemDescription>;
type GuestbookTab = "" | GuestbookCategory;

function itemIconUrl(itemId: number, itemName: string): string {
  const file = itemName.endsWith("卡片") ? "card" : String(itemId);
  return rmsAssetUrl(`items/large/${encodeURIComponent(file)}.gif`);
}

function authorLine(author: GuestbookAuthor): string {
  const badge = tierBadge(author.permission_level);
  const avatar = author.hasAvatar
    ? `<img class="gb-avatar" src="${escapeHtml(author.avatarUrl)}" alt="" loading="lazy">`
    : `<span class="gb-avatar gb-avatar--fallback" aria-hidden="true"><i class="ph ph-user-circle"></i></span>`;
  return `<span class="guestbook-author">${avatar}<strong class="guestbook-author-name">${escapeHtml(author.displayName)}</strong><span class="gb-badge ${badge.cls}">${badge.label}</span></span>`;
}

const guestBadge = '<span class="gb-badge gb-badge--guest">游客</span>';

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN");
}

/** 管理员删除按钮（仅当前用户 permission_level >= 100 时渲染；真正的权限校验在服务端）。 */
function adminDeleteButton(kind: "entry" | "reply", id: number): string {
  return `<button type="button" class="gb-edit-btn gb-delete-btn" data-gb-admin-delete-${kind}="${id}"><i class="ph ph-trash" aria-hidden="true"></i> 删除</button>`;
}

function replyMarkup(reply: GuestbookReply, currentUserId: string | null, isAdmin = false): string {
  const own = currentUserId !== null && reply.author.userId === currentUserId;
  return `<div class="guestbook-reply" data-reply-id="${reply.id}">
    <div class="guestbook-reply-head">${authorLine(reply.author)}<span class="guestbook-reply-meta"><time datetime="${new Date(reply.createdAt).toISOString()}">${formatTime(reply.createdAt)}</time>${reply.editedAt ? '<span class="gb-edited">已编辑</span>' : ""}${own ? `<button type="button" class="gb-edit-btn" data-gb-reply-edit="${reply.id}"><i class="ph ph-pencil-simple" aria-hidden="true"></i> 编辑</button>` : ""}${isAdmin ? adminDeleteButton("reply", reply.id) : ""}</span></div>
    <p class="guestbook-reply-content">${escapeHtml(reply.content)}</p>
  </div>`;
}

function replyAreaMarkup(entry: GuestbookEntry, currentUserId: string | null, isAdmin = false): string {
  const replies = (entry.replies ?? []).map((reply) => replyMarkup(reply, currentUserId, isAdmin)).join("");
  const replied = entry.hasReplied !== null
    ? entry.hasReplied
    : !!currentUserId && entry.replies?.some((reply) => reply.author.userId === currentUserId);
  const countBadge = entry.replyCount > 0
    ? `<span class="gb-reply-count" aria-label="共 ${entry.replyCount} 条回复"><i class="ph ph-chat-teardrop" aria-hidden="true"></i> ${entry.replyCount}</span>`
    : "";
  const truncated = entry.hasMoreReplies
    ? `<button type="button" class="gb-reply-truncated" data-gb-load-replies="${entry.id}"><i class="ph ph-caret-down" aria-hidden="true"></i> 展开全部 ${entry.replyCount} 条回复</button>`
    : "";
  let compose: string;
  if (currentUserId === null) {
    compose = `<div class="guestbook-reply-gate"><span>登录后即可回复</span><button type="button" class="gb-reply-login" data-open-login><i class="ph ph-user" aria-hidden="true"></i> 登录</button></div>`;
  } else if (replied) {
    compose = '<div class="guestbook-reply-gate is-done"><i class="ph ph-check-circle" aria-hidden="true"></i> 你已回复过这条留言，可编辑自己的回复</div>';
  } else {
    compose = `<div class="guestbook-reply-compose" data-reply-compose="${entry.id}">
      <textarea maxlength="1000" rows="2" placeholder="写下你的回复（每条留言限回复一次）" aria-label="回复内容"></textarea>
      <div class="guestbook-reply-compose-actions"><span class="gb-editor-status" role="status" aria-live="polite"></span><button type="button" data-gb-reply-submit="${entry.id}"><i class="ph ph-paper-plane-tilt" aria-hidden="true"></i> 回复</button></div>
    </div>`;
  }
  return `<div class="guestbook-replies" data-replies="${entry.id}">${countBadge}${truncated}${replies}</div>${compose}`;
}

function entryMarkup(
  entry: GuestbookEntry,
  catalog: EntryCatalog,
  descriptions: EntryDescriptions,
  currentUserId: string | null,
  isAdmin = false,
): string {
  const catalogItem =
    entry.itemId === null ? undefined : catalog.get(entry.itemId);
  const itemName = entry.isZeny
    ? "Zeny 游戏币"
    : (catalogItem?.name ?? "目录道具");
  const itemDescription =
    entry.itemId === null
      ? ""
      : cleanItemDescription(descriptions.get(entry.itemId)?.description ?? "");
  const expiry =
    entry.expiresAt === null
      ? "长期有效"
      : `截止 ${formatTime(entry.expiresAt)}`;
  const kind = kindStyles[entry.category];
  const itemCells =
    entry.category === "suggestion"
      ? ""
      : `
      <span class="guestbook-item-thumb">${entry.isZeny ? '<span class="guestbook-zeny-glyph" aria-hidden="true">Z</span>' : `<img src="${escapeHtml(itemIconUrl(entry.itemId ?? 0, itemName))}" alt="" loading="lazy" data-item-image>`}</span>
      <span class="guestbook-item-meta"><span class="guestbook-item-idline"><strong class="guestbook-item-name">${escapeHtml(itemName)}</strong></span><span class="guestbook-item-id">${entry.isZeny ? "游戏货币" : `ItemID ${entry.itemId}`}</span>${itemDescription ? `<span class="guestbook-item-description">${escapeHtml(itemDescription)}</span>` : '<span class="guestbook-item-description is-muted">目录暂无详细描述</span>'}</span>`;
  const own = currentUserId !== null && entry.author?.userId === currentUserId;
  const identity = entry.author
    ? authorLine(entry.author)
    : `${entry.contact ? `<span class="guestbook-contact"><i class="ph ph-identification-card" aria-hidden="true"></i>${escapeHtml(entry.contact)}</span>` : ""}${guestBadge}`;
  const footerMeta = `<span class="guestbook-entry-expiry"><i class="ph ph-clock" aria-hidden="true"></i>${escapeHtml(expiry)}</span>${entry.editedAt ? '<span class="gb-edited">已编辑</span>' : ""}${own ? `<button type="button" class="gb-edit-btn" data-gb-edit="${entry.id}"><i class="ph ph-pencil-simple" aria-hidden="true"></i> 编辑</button>` : ""}${isAdmin ? adminDeleteButton("entry", entry.id) : ""}`;
  return `<article class="guestbook-entry guestbook-entry--${entry.category}${entry.isExpired ? " is-expired" : ""}" data-entry-id="${entry.id}">
    <div class="guestbook-entry-bar"><span class="guestbook-entry-kind"><i class="ph ${kind.icon}" aria-hidden="true"></i>${kind.label}</span><span class="guestbook-entry-bar-meta"><time datetime="${new Date(entry.createdAt).toISOString()}">${formatTime(entry.createdAt)}</time>${entry.isExpired ? '<span class="guestbook-expired-stamp" aria-label="此留言已过期">已过期</span>' : ""}</span></div>
    <div class="guestbook-entry-row${entry.category === "suggestion" ? " guestbook-entry-row--suggestion" : ""}">${itemCells}
      <p class="guestbook-content">${escapeHtml(entry.content)}</p>
    </div>
    <footer class="guestbook-entry-footer"><span class="guestbook-entry-identity">${identity}</span><span class="guestbook-entry-footer-meta">${footerMeta}</span></footer>
    ${replyAreaMarkup(entry, currentUserId, isAdmin)}
  </article>`;
}

interface GuestbookPageDeps {
  store?: AuthStore;
  auth?: AuthApiClient;
}

export function mountGuestbookPage(
  root: HTMLElement,
  api: MarketApiClient = new MarketApi(),
  deps: GuestbookPageDeps = {},
): void {
  const store = deps.store ?? authStore;
  const auth = deps.auth ?? authApi;
  document.title = "玩家登记簿 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header"><div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup("guestbook")}
    </div></header>
    <main class="guestbook-main page-width">
      <section class="guestbook-intro"><div><p class="eyebrow">露天市场 / 玩家交流</p><h1>玩家登记簿</h1><p>发布收购、出售或给网站的建议，让市场里的每一份需求都能被看见。</p></div><span class="guestbook-ledger-mark" aria-hidden="true">No. 01<br><strong>公开登记</strong></span></section>
      <section class="guestbook-compose" aria-labelledby="guestbook-compose-title">
        <div class="section-heading"><div><p class="eyebrow">发布一则登记</p><h2 id="guestbook-compose-title">写下你的需求</h2></div><p>登录后发布，留言会展示你的头像、昵称与账号徽章。</p></div>
        <div id="guestbook-login-gate" class="guestbook-login-gate" hidden></div>
        <form id="guestbook-form" class="guestbook-form" aria-describedby="guestbook-form-status">
          <fieldset class="guestbook-kind-select"><legend>登记类别</legend><label><input type="radio" name="category" value="buy" checked><span><i class="ph ph-hand-coins" aria-hidden="true"></i>收购</span></label><label><input type="radio" name="category" value="sell"><span><i class="ph ph-storefront" aria-hidden="true"></i>出售</span></label><label><input type="radio" name="category" value="suggestion"><span><i class="ph ph-chat-centered-text" aria-hidden="true"></i>网站建议</span></label></fieldset>
          <div id="guestbook-trade-fields" class="guestbook-trade-fields">
            <fieldset class="guestbook-item-choice"><legend>交易物品</legend><div id="guestbook-item-picker" class="autocomplete"><input id="guestbook-item-query" role="combobox" aria-autocomplete="list" aria-controls="guestbook-item-suggestions" aria-expanded="false" autocomplete="off" placeholder="输入道具名称搜索" aria-label="搜索并选择道具" /><ul id="guestbook-item-suggestions" class="suggestions" role="listbox" hidden></ul></div><p id="guestbook-item-selected" class="field-help">请选择道具或 Zeny。</p></fieldset>
            <div class="guestbook-preview-cell"><span class="guestbook-preview-label">已选道具</span><div id="guestbook-item-preview" class="guestbook-item-preview is-empty"><span>尚未选择道具</span></div></div>
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
    <div id="guestbook-item-popover" class="item-pop" hidden></div>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>`;

  mountSiteNav(root);

  const form = root.querySelector<HTMLFormElement>("#guestbook-form")!;
  const loginGate = root.querySelector<HTMLElement>("#guestbook-login-gate")!;
  const tradeFields = root.querySelector<HTMLElement>(
    "#guestbook-trade-fields",
  )!;
  const content =
    root.querySelector<HTMLTextAreaElement>("#guestbook-content")!;
  const contentCount = root.querySelector<HTMLElement>(
    "#guestbook-content-count",
  )!;
  const status = root.querySelector<HTMLElement>("#guestbook-form-status")!;
  const submit = root.querySelector<HTMLButtonElement>("#guestbook-submit")!;
  const itemQuery = root.querySelector<HTMLInputElement>(
    "#guestbook-item-query",
  )!;
  const itemSuggestions = root.querySelector<HTMLUListElement>(
    "#guestbook-item-suggestions",
  )!;
  const selectedHelp = root.querySelector<HTMLElement>(
    "#guestbook-item-selected",
  )!;
  const preview = root.querySelector<HTMLElement>("#guestbook-item-preview")!;
  const popover = root.querySelector<HTMLElement>("#guestbook-item-popover")!;
  const searchForm = root.querySelector<HTMLFormElement>("#guestbook-search")!;
  const tabButtons = () => [
    ...root.querySelectorAll<HTMLButtonElement>(".guestbook-tab"),
  ];
  const results = root.querySelector<HTMLElement>("#guestbook-results")!;
  const prev = root.querySelector<HTMLButtonElement>("#guestbook-prev")!;
  const next = root.querySelector<HTMLButtonElement>("#guestbook-next")!;
  const pageStatus = root.querySelector<HTMLElement>("#guestbook-page-status")!;
  const loadCatalog = createCatalogLoader();
  const loadDescriptions = createDescriptionLoader();
  let catalog: ItemAutocomplete[] = [];
  let descriptions: ItemDescription[] = [];
  let catalogById: EntryCatalog = new Map();
  let descriptionsById: EntryDescriptions = new Map();
  let selectedItem: ItemAutocomplete | null = null;
  let selectedZeny = false;
  let activeIndex = -1;
  let pageIndex = 0;
  let pageCursors: Array<string | null> = [null];
  let nextCursor: string | null = null;
  let currentFilters: GuestbookFilters = { limit: 20 };
  const entriesById = new Map<number, GuestbookEntry>();

  const currentUserId = (): string | null => {
    const state = store.getState();
    return state.status === "pending" || state.status === "active"
      ? state.user.id
      : null;
  };

  const currentIsAdmin = (): boolean => {
    const state = store.getState();
    return (state.status === "pending" || state.status === "active") && state.user.permission_level >= 100;
  };

  const syncAuthGate = (): void => {
    const state = store.getState();
    const authed = state.status === "pending" || state.status === "active";
    form.hidden = !authed;
    loginGate.hidden = authed;
    if (authed) return;
    if (state.status === "loading") {
      loginGate.innerHTML = '<i class="ph ph-circle-notch" aria-hidden="true"></i><p><strong>账号状态加载中…</strong></p>';
      return;
    }
    loginGate.innerHTML = `<i class="ph ph-lock-key" aria-hidden="true"></i><p><strong>登录后即可发布登记</strong><span>收购、出售或网站建议都需要先登录 LTSD 账号，留言会公开展示你的头像与昵称。</span></p><button type="button" data-open-login><i class="ph ph-user" aria-hidden="true"></i> 登录账号</button>`;
  };
  store.subscribe((_state, event) => {
    syncAuthGate();
    if (event?.type === "identity-changed") {
      form.reset();
      selectedItem = null;
      selectedZeny = false;
      contentCount.textContent = "0";
      resetPreview();
      setKind();
      void loadPage(pageCursors[pageIndex] ?? undefined);
    }
  });
  syncAuthGate();

  const syncTabs = (tab: GuestbookTab): void => {
    tabButtons().forEach((button) => {
      const active = (button.dataset.tab ?? "") === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
  };

  const categoryInput = (): GuestbookCategory =>
    form.querySelector<HTMLInputElement>('input[name="category"]:checked')!
      .value as GuestbookCategory;
  const setKind = (): void => {
    const suggestion = categoryInput() === "suggestion";
    tradeFields.hidden = suggestion;
    tradeFields
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")
      .forEach((field) => {
        field.disabled = suggestion;
        field.required = !suggestion && field.id !== "guestbook-item-query";
      });
    if (suggestion) {
      selectedItem = null;
      selectedZeny = false;
      itemQuery.value = "";
      resetPreview();
    }
  };
  const hideSuggestions = (): void => {
    itemSuggestions.hidden = true;
    itemQuery.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  };
  const renderSuggestions = (items: ItemAutocomplete[]): void => {
    const zenyMarkup = `<li><button type="button" role="option" aria-selected="${activeIndex === 0}" data-zeny="true"><i class="ph ph-coins" aria-hidden="true"></i> Zeny 游戏币 <small>特殊交易项</small></button></li>`;
    itemSuggestions.innerHTML = `${zenyMarkup}${items.map((item, index) => `<li><button type="button" role="option" aria-selected="${index + 1 === activeIndex}" data-index="${index}">${escapeHtml(item.name)}</button></li>`).join("")}`;
    itemSuggestions.hidden = false;
    itemQuery.setAttribute("aria-expanded", "true");
  };

  /* ---- 已选道具预览卡 + 详情悬停浮层（与搜索页悬停卡片同款 pop-card）---- */

  function resetPreview(): void {
    preview.className = "guestbook-item-preview is-empty";
    preview.innerHTML = "<span>尚未选择道具</span>";
    hideItemPopover();
  }

  function showItemPreview(item: ItemAutocomplete | null, zeny: boolean): void {
    if (zeny) {
      preview.className = "guestbook-item-preview";
      preview.innerHTML = `<span class="guestbook-item-preview-card"><span class="guestbook-item-thumb"><span class="guestbook-zeny-glyph" aria-hidden="true">Z</span></span><span class="guestbook-item-preview-meta"><strong>Zeny 游戏币</strong><small>游戏货币</small></span></span>`;
      return;
    }
    if (!item) {
      resetPreview();
      return;
    }
    preview.className = "guestbook-item-preview";
    preview.innerHTML = `<span class="guestbook-item-preview-card" data-preview-card tabindex="0"><span class="guestbook-item-thumb"><img src="${escapeHtml(itemIconUrl(item.itemId, item.name))}" alt="" loading="lazy" data-item-image></span><span class="guestbook-item-preview-meta"><strong>${escapeHtml(item.name)}</strong><small>悬停查看详情</small></span></span>`;
  }

  const view = document.defaultView;

  function hideItemPopover(): void {
    popover.hidden = true;
  }

  function showItemPopover(): void {
    if (!selectedItem || selectedZeny || !view) return;
    const card = preview.querySelector<HTMLElement>("[data-preview-card]");
    if (!card) return;
    const item = selectedItem;
    const description = cleanItemDescription(
      descriptionsById.get(item.itemId)?.description ?? "",
    );
    popover.innerHTML = `<div class="pop-card"><div class="pop-head"><span class="pop-icon"><img src="${escapeHtml(itemIconUrl(item.itemId, item.name))}" alt="" data-item-image></span><span class="pop-head-copy"><strong>${escapeHtml(item.name)}</strong><small>物品 ID ${item.itemId}</small></span><button type="button" class="pop-close" aria-label="关闭物品详情"><i class="ph ph-x" aria-hidden="true"></i></button></div><div class="pop-body">${description ? escapeHtml(description) : "暂无详细描述"}</div></div>`;
    popover.hidden = false;
    const rect = card.getBoundingClientRect();
    const gap = 10;
    popover.style.maxHeight = `${view.innerHeight - 16}px`;
    const popWidth = popover.offsetWidth;
    const popHeight = popover.offsetHeight;
    const below = rect.bottom + gap + popHeight <= view.innerHeight;
    const top = below ? rect.bottom + gap : Math.max(8, rect.top - gap - popHeight);
    const left = Math.round(
      Math.max(8, Math.min(rect.left, view.innerWidth - popWidth - 8)),
    );
    popover.classList.remove("pop--right", "pop--left", "pop--below", "pop--above");
    popover.classList.add(below ? "pop--below" : "pop--above");
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  const hoverCapable =
    typeof view?.matchMedia === "function" &&
    view.matchMedia("(hover: hover) and (pointer: fine)").matches;
  preview.addEventListener("pointerover", (event) => {
    if (!hoverCapable) return;
    if ((event.target as Element | null)?.closest("[data-preview-card]"))
      showItemPopover();
  });
  preview.addEventListener("pointerout", (event) => {
    if (!hoverCapable) return;
    const next = event.relatedTarget as Node | null;
    if (preview.contains(next) || popover.contains(next)) return;
    hideItemPopover();
  });
  popover.addEventListener("pointerout", (event) => {
    if (!hoverCapable) return;
    const next = event.relatedTarget as Node | null;
    if (preview.contains(next) || popover.contains(next)) return;
    hideItemPopover();
  });
  preview.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (!target.closest("[data-preview-card]")) return;
    if (hoverCapable) return;
    if (popover.hidden) showItemPopover();
    else hideItemPopover();
  });
  popover.addEventListener("click", (event) => {
    if ((event.target as Element).closest(".pop-close")) hideItemPopover();
  });
  view?.addEventListener("scroll", hideItemPopover, true);
  view?.addEventListener("resize", hideItemPopover);

  const chooseItem = (item: ItemAutocomplete): void => {
    selectedItem = item;
    selectedZeny = false;
    itemQuery.value = item.name;
    selectedHelp.textContent = `已选择：${item.name} · ItemID ${item.itemId}`;
    showItemPreview(item, false);
    hideSuggestions();
  };
  const chooseZeny = (): void => {
    selectedItem = null;
    selectedZeny = true;
    itemQuery.value = "Zeny 游戏币";
    selectedHelp.textContent = "已选择：Zeny 游戏币";
    showItemPreview(null, true);
    hideSuggestions();
  };

  form
    .querySelectorAll<HTMLInputElement>('input[name="category"]')
    .forEach((input) => input.addEventListener("change", setKind));
  setKind();
  content.addEventListener("input", () => {
    contentCount.textContent = String([...content.value].length);
  });
  itemQuery.addEventListener("input", async () => {
    selectedItem = null;
    selectedZeny = false;
    activeIndex = -1;
    selectedHelp.textContent = "请从搜索结果中选择道具或 Zeny。";
    resetPreview();
    try {
      catalog = (await loadCatalog()).items;
      catalogById = new Map(catalog.map((item) => [item.itemId, item]));
      renderSuggestions(findCatalogMatches(catalog, itemQuery.value));
    } catch {
      renderSuggestions([]);
    }
  });
  itemQuery.addEventListener("focus", () => {
    if (!itemSuggestions.hidden) return;
    /* 已完成选择（Zeny 或道具）时不因重新聚焦而再次弹出下拉；想改选直接输入即可（input 事件会重置选择并打开下拉） */
    if (selectedZeny || selectedItem) return;
    void loadCatalog()
      .then((page) => {
        catalog = page.items;
        catalogById = new Map(catalog.map((item) => [item.itemId, item]));
        renderSuggestions(findCatalogMatches(catalog, itemQuery.value));
      })
      .catch(() => renderSuggestions([]));
  });
  document.addEventListener("click", (event) => {
    if ((event.target as Element | null)?.closest("#guestbook-item-picker")) return;
    hideSuggestions();
  });
  itemQuery.addEventListener("keydown", (event) => {
    const options = [
      ...itemSuggestions.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ];
    if (event.key === "Escape") hideSuggestions();
    else if (event.key === "ArrowDown" && options.length) {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
      renderSuggestions(findCatalogMatches(catalog, itemQuery.value));
    } else if (event.key === "ArrowUp" && options.length) {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      renderSuggestions(findCatalogMatches(catalog, itemQuery.value));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      if (activeIndex === 0) {
        chooseZeny();
        return;
      }
      const item = findCatalogMatches(catalog, itemQuery.value)[
        activeIndex - 1
      ];
      if (item) chooseItem(item);
    }
  });
  itemSuggestions.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[role="option"]',
    );
    if (!button) return;
    if (button.dataset.zeny) {
      chooseZeny();
      return;
    }
    const item = findCatalogMatches(catalog, itemQuery.value)[
      Number(button.dataset.index)
    ];
    if (item) chooseItem(item);
  });

  async function loadPage(cursor?: string): Promise<void> {
    results.setAttribute("aria-busy", "true");
    results.innerHTML =
      '<div class="guestbook-state"><span class="guestbook-skeleton"></span><span class="guestbook-skeleton"></span></div>';
    try {
      const page = await api.searchGuestbook({
        ...currentFilters,
        ...(cursor ? { cursor } : {}),
      });
      try {
        catalog = (await loadCatalog()).items;
        catalogById = new Map(catalog.map((item) => [item.itemId, item]));
      } catch {
        catalog = [];
        catalogById = new Map();
      }
      try {
        descriptions = (await loadDescriptions()).descriptions;
        descriptionsById = new Map(
          descriptions.map((item) => [item.itemId, item]),
        );
      } catch {
        descriptions = [];
        descriptionsById = new Map();
      }
      entriesById.clear();
      const userId = currentUserId();
      for (const entry of page.items) entriesById.set(entry.id, entry);
      results.innerHTML = page.items.length
        ? page.items
            .map((entry) => entryMarkup(entry, catalogById, descriptionsById, userId, currentIsAdmin()))
            .join("")
        : '<div class="guestbook-state"><i class="ph ph-notebook" aria-hidden="true"></i><strong>暂时没有符合条件的登记</strong><span>调整筛选条件，或发布第一条登记。</span></div>';
      nextCursor = page.nextCursor;
      next.disabled = !nextCursor;
      prev.disabled = pageIndex === 0;
      pageStatus.textContent = `第 ${pageIndex + 1} 页 · ${page.items.length} 条`;
    } catch (error) {
      results.innerHTML = `<div class="guestbook-state guestbook-state--error"><i class="ph ph-warning-circle" aria-hidden="true"></i><strong>登记加载失败</strong><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span><button type="button" id="guestbook-retry">重新加载</button></div>`;
      results
        .querySelector("#guestbook-retry")
        ?.addEventListener(
          "click",
          () => void loadPage(pageCursors[pageIndex] ?? undefined),
        );
    } finally {
      results.setAttribute("aria-busy", "false");
    }
  }

  function replaceEntry(entry: GuestbookEntry): void {
    entriesById.set(entry.id, entry);
    const article = results.querySelector<HTMLElement>(
      `article[data-entry-id="${entry.id}"]`,
    );
    if (!article) return;
    const template = document.createElement("template");
    template.innerHTML = entryMarkup(
      entry,
      catalogById,
      descriptionsById,
      currentUserId(),
      currentIsAdmin(),
    ).trim();
    const next2 = template.content.firstElementChild;
    if (next2) article.replaceWith(next2);
  }

  function errorText(error: unknown): string {
    if (error instanceof AuthApiError) return error.message;
    return error instanceof Error ? error.message : "操作失败，请稍后重试。";
  }

  /* ---- 编辑 / 回复：事件委托 ---- */

  function openEditor(host: HTMLElement, value: string, maxLength: number): HTMLTextAreaElement {
    const editor = document.createElement("div");
    editor.className = "gb-editor";
    editor.innerHTML = `<textarea maxlength="${maxLength}" rows="3"></textarea><div class="gb-editor-actions"><span class="gb-editor-status" role="status" aria-live="polite"></span><button type="button" class="gb-editor-save"><i class="ph ph-check" aria-hidden="true"></i> 保存</button><button type="button" class="gb-editor-cancel secondary-button">取消</button></div>`;
    host.replaceChildren(editor);
    const textarea = editor.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = value;
    textarea.focus();
    return textarea;
  }

  async function handleEntryEdit(article: HTMLElement, entry: GuestbookEntry): Promise<void> {
    const contentEl = article.querySelector<HTMLElement>(":scope > .guestbook-entry-row > .guestbook-content")
      ?? article.querySelector<HTMLElement>(":scope .guestbook-content");
    if (!contentEl || article.querySelector(".gb-editor")) return;
    const textarea = openEditor(contentEl, entry.content, 2000);
    const editor = contentEl.querySelector<HTMLElement>(".gb-editor")!;
    const editorStatus = editor.querySelector<HTMLElement>(".gb-editor-status")!;
    editor.querySelector<HTMLButtonElement>(".gb-editor-cancel")!.addEventListener("click", () => {
      contentEl.replaceChildren();
      contentEl.className = "guestbook-content";
      contentEl.textContent = entry.content;
    });
    editor.querySelector<HTMLButtonElement>(".gb-editor-save")!.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      editorStatus.textContent = "保存中…";
      try {
        const result = await auth.sessionRequest<{ item: GuestbookEntry }>(
          `/api/v1/guestbook/${entry.id}`,
          "PATCH",
          { content: textarea.value },
        );
        replaceEntry(result.item);
      } catch (error) {
        editorStatus.textContent = errorText(error);
        button.disabled = false;
      }
    });
  }

  async function handleReplyEdit(replyEl: HTMLElement, reply: GuestbookReply): Promise<void> {
    const contentEl = replyEl.querySelector<HTMLElement>(":scope > .guestbook-reply-content");
    if (!contentEl || replyEl.querySelector(".gb-editor")) return;
    const textarea = openEditor(contentEl, reply.content, 1000);
    const editor = contentEl.querySelector<HTMLElement>(".gb-editor")!;
    const editorStatus = editor.querySelector<HTMLElement>(".gb-editor-status")!;
    editor.querySelector<HTMLButtonElement>(".gb-editor-cancel")!.addEventListener("click", () => {
      contentEl.replaceChildren();
      contentEl.className = "guestbook-reply-content";
      contentEl.textContent = reply.content;
    });
    editor.querySelector<HTMLButtonElement>(".gb-editor-save")!.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      editorStatus.textContent = "保存中…";
      try {
        const result = await auth.sessionRequest<{ item: { id: number; content: string; editedAt: number } }>(
          `/api/v1/guestbook/replies/${reply.id}`,
          "PATCH",
          { content: textarea.value },
        );
        const entry = entriesById.get(reply.entryId);
        if (entry) {
          const nextReply: GuestbookReply = { ...reply, content: result.item.content, editedAt: result.item.editedAt };
          entry.replies = entry.replies.map((item) => (item.id === reply.id ? nextReply : item));
          replaceEntry(entry);
        }
      } catch (error) {
        editorStatus.textContent = errorText(error);
        button.disabled = false;
      }
    });
  }

  async function handleReplySubmit(entry: GuestbookEntry, compose: HTMLElement): Promise<void> {
    const textarea = compose.querySelector<HTMLTextAreaElement>("textarea")!;
    const button = compose.querySelector<HTMLButtonElement>("[data-gb-reply-submit]")!;
    const composeStatus = compose.querySelector<HTMLElement>(".gb-editor-status")!;
    button.disabled = true;
    composeStatus.textContent = "正在提交…";
    try {
      const result = await auth.sessionRequest<{ item: GuestbookReply }>(
        `/api/v1/guestbook/${entry.id}/replies`,
        "POST",
        { content: textarea.value },
      );
      entry.replies = [...(entry.replies ?? []), result.item];
      replaceEntry(entry);
    } catch (error) {
      composeStatus.textContent = errorText(error);
      button.disabled = false;
    }
  }

  async function handleAdminDelete(kind: "entry" | "reply", id: number, button: HTMLButtonElement): Promise<void> {
    const entryEl = button.closest<HTMLElement>("article[data-entry-id]");
    const entry = entryEl ? entriesById.get(Number(entryEl.dataset.entryId)) : undefined;
    const view = root.ownerDocument.defaultView ?? window;
    const message = kind === "entry"
      ? `删除这条留言${entry && entry.replyCount > 0 ? `及其 ${entry.replyCount} 条回复` : ""}？此操作不可恢复。`
      : "删除这条回复？此操作不可恢复。";
    if (!view.confirm(message)) return;
    button.disabled = true;
    try {
      await auth.sessionRequest(`/api/v1/admin/guestbook/${kind === "entry" ? "entries" : "replies"}/${id}`, "DELETE");
      if (kind === "entry") {
        entriesById.delete(id);
        results.querySelector(`article[data-entry-id="${id}"]`)?.remove();
      } else if (entry) {
        entry.replies = (entry.replies ?? []).filter((reply) => reply.id !== id);
        entry.replyCount = Math.max(0, entry.replyCount - 1);
        replaceEntry(entry);
      }
    } catch (error) {
      button.disabled = false;
      view.alert(`删除失败：${errorText(error)}`);
    }
  }

  results.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const entryDelete = target.closest<HTMLButtonElement>("[data-gb-admin-delete-entry]");
    if (entryDelete) {
      void handleAdminDelete("entry", Number(entryDelete.dataset.gbAdminDeleteEntry), entryDelete);
      return;
    }
    const replyDelete = target.closest<HTMLButtonElement>("[data-gb-admin-delete-reply]");
    if (replyDelete) {
      void handleAdminDelete("reply", Number(replyDelete.dataset.gbAdminDeleteReply), replyDelete);
      return;
    }
    const editButton = target.closest<HTMLElement>("[data-gb-edit]");
    if (editButton) {
      const article = editButton.closest<HTMLElement>("article[data-entry-id]");
      const entry = article ? entriesById.get(Number(article.dataset.entryId)) : undefined;
      if (article && entry) void handleEntryEdit(article, entry);
      return;
    }
    const replyEditButton = target.closest<HTMLElement>("[data-gb-reply-edit]");
    if (replyEditButton) {
      const replyEl = replyEditButton.closest<HTMLElement>("[data-reply-id]");
      const article = replyEditButton.closest<HTMLElement>("article[data-entry-id]");
      const entry = article ? entriesById.get(Number(article.dataset.entryId)) : undefined;
      const reply = entry?.replies?.find((item) => item.id === Number(replyEl?.dataset.replyId));
      if (replyEl && reply) void handleReplyEdit(replyEl, reply);
      return;
    }
    const replySubmit = target.closest<HTMLElement>("[data-gb-reply-submit]");
    if (replySubmit) {
      const article = replySubmit.closest<HTMLElement>("article[data-entry-id]");
      const entry = article ? entriesById.get(Number(article.dataset.entryId)) : undefined;
      const compose = replySubmit.closest<HTMLElement>(".guestbook-reply-compose");
      if (entry && compose) void handleReplySubmit(entry, compose);
      return;
    }
    const loadRepliesBtn = target.closest<HTMLButtonElement>("[data-gb-load-replies]");
    if (loadRepliesBtn) {
      const entryId = Number(loadRepliesBtn.dataset.gbLoadReplies);
      const article = loadRepliesBtn.closest<HTMLElement>("article[data-entry-id]");
      if (!article || !Number.isSafeInteger(entryId)) return;
      loadRepliesBtn.disabled = true;
      const prevLabel = loadRepliesBtn.innerHTML;
      loadRepliesBtn.innerHTML = '<i class="ph ph-circle-notch" aria-hidden="true"></i> 加载中…';
      try {
        const detail = await api.getGuestbookEntry(entryId);
        replaceEntry(detail.item);
      } catch {
        loadRepliesBtn.disabled = false;
        loadRepliesBtn.innerHTML = '<i class="ph ph-warning-circle" aria-hidden="true"></i> 加载失败，点击重试';
      }
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (currentUserId() === null) {
      status.textContent = "请先登录后再发布登记。";
      syncAuthGate();
      return;
    }
    const category = categoryInput();
    if (
      category !== "suggestion" &&
      !selectedItem &&
      !selectedZeny
    ) {
      status.textContent = "请选择目录中的道具或 Zeny。";
      itemQuery.focus();
      return;
    }
    const input: GuestbookSubmissionInput =
      category === "suggestion"
        ? { category, content: content.value }
        : {
            category,
            content: content.value,
            isZeny: selectedZeny,
            ...(selectedItem ? { itemId: selectedItem.itemId } : {}),
            duration: root.querySelector<HTMLSelectElement>(
              "#guestbook-duration",
            )!.value as NonNullable<GuestbookSubmissionInput["duration"]>,
          };
    submit.disabled = true;
    status.textContent = "正在提交…";
    try {
      await auth.sessionRequest("/api/v1/guestbook", "POST", input);
      form.reset();
      selectedItem = null;
      selectedZeny = false;
      contentCount.textContent = "0";
      selectedHelp.textContent = "请选择道具或 Zeny。";
      resetPreview();
      setKind();
      status.textContent = "登记已发布。";
      currentFilters = { limit: 20 };
      syncTabs("");
      pageIndex = 0;
      pageCursors = [null];
      await loadPage();
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      submit.disabled = false;
    }
  });

  root
    .querySelector<HTMLElement>("#guestbook-tabs")!
    .addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        ".guestbook-tab",
      );
      if (!button || button.classList.contains("is-active")) return;
      const tab = (button.dataset.tab ?? "") as GuestbookTab;
      const q = root
        .querySelector<HTMLInputElement>("#guestbook-search-q")!
        .value.trim();
      const selectedId = Number(searchForm.dataset.itemId);
      currentFilters = {
        limit: 20,
        ...(tab ? { category: tab } : {}),
        ...(q ? { q } : {}),
        ...(Number.isSafeInteger(selectedId) && selectedId > 0
          ? { itemId: selectedId }
          : {}),
      };
      syncTabs(tab);
      pageIndex = 0;
      pageCursors = [null];
      void loadPage();
    });

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const category = currentFilters.category ?? "";
    const q = root
      .querySelector<HTMLInputElement>("#guestbook-search-q")!
      .value.trim();
    const selectedId = Number(searchForm.dataset.itemId);
    currentFilters = {
      limit: 20,
      ...(category ? { category } : {}),
      ...(q ? { q } : {}),
      ...(Number.isSafeInteger(selectedId) && selectedId > 0
        ? { itemId: selectedId }
        : {}),
    };
    syncTabs(category);
    pageIndex = 0;
    pageCursors = [null];
    void loadPage();
  });
  root
    .querySelector<HTMLButtonElement>("#guestbook-clear-filter")!
    .addEventListener("click", () => {
      searchForm.reset();
      delete searchForm.dataset.itemId;
      currentFilters = { limit: 20 };
      syncTabs("");
      pageIndex = 0;
      pageCursors = [null];
      void loadPage();
    });
  next.addEventListener("click", () => {
    if (!nextCursor) return;
    pageCursors[pageIndex + 1] = nextCursor;
    pageIndex += 1;
    void loadPage(nextCursor);
  });
  prev.addEventListener("click", () => {
    if (pageIndex === 0) return;
    pageIndex -= 1;
    void loadPage(pageCursors[pageIndex] ?? undefined);
  });

  const filterQuery = root.querySelector<HTMLInputElement>(
    "#guestbook-filter-item",
  )!;
  const filterSuggestions = root.querySelector<HTMLUListElement>(
    "#guestbook-filter-suggestions",
  )!;
  filterQuery.addEventListener("input", async () => {
    try {
      catalog = (await loadCatalog()).items;
      const matches = findCatalogMatches(catalog, filterQuery.value);
      filterSuggestions.innerHTML = matches
        .map(
          (item) =>
            `<li><button type="button" role="option" data-id="${item.itemId}">${escapeHtml(item.name)}</button></li>`,
        )
        .join("");
      filterSuggestions.hidden = matches.length === 0;
      filterQuery.setAttribute("aria-expanded", String(matches.length > 0));
    } catch {
      filterSuggestions.hidden = true;
    }
  });
  filterSuggestions.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-id]",
    );
    if (!button) return;
    searchForm.dataset.itemId = button.dataset.id ?? "";
    filterQuery.value = button.textContent?.trim() ?? "";
    filterSuggestions.hidden = true;
    filterQuery.setAttribute("aria-expanded", "false");
  });
  void loadPage();
}
