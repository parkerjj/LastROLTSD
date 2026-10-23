import { mountAuthNav } from './auth/nav';
import type { AuthApiClient } from './auth/api';
import type { AuthStore } from './auth/store';

export type SitePage = "search" | "accounts" | "guestbook" | "updates" | "client" | "sponsors" | "hall";

interface NavEntry {
  readonly page: SitePage;
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly isNew?: boolean;
}

const NAV_ENTRIES: readonly NavEntry[] = [
  {
    page: "search",
    href: "/#search",
    label: "搜索市场",
    icon: "ph-magnifying-glass",
  },
  {
    page: "accounts",
    href: "/accounts",
    label: "菜农监控台",
    icon: "ph-monitor",
  },
  {
    page: "client",
    href: "/client",
    label: "进阶客户端",
    icon: "ph-rocket-launch",
    isNew: true,
  },
  { page: "hall", href: "/ke/hall", label: "配置大厅", icon: "ph-squares-four" },
  {
    page: "guestbook",
    href: "/guestbook",
    label: "玩家登记簿",
    icon: "ph-address-book",
  },
  { page: "updates", href: "/updates", label: "更新说明", icon: "ph-scroll" },
  {
    page: "sponsors",
    href: "/sponsor",
    label: "赛博化缘",
    icon: "ph-coffee",
  },
];

const EXTERNAL_ENTRIES: ReadonlyArray<{
  readonly href: string;
  readonly label: string;
  readonly icon: string;
}> = [
  {
    href: "https://github.com/parkerjj/LastROLTSD",
    label: "代码仓库",
    icon: "ph-github-logo",
  },
];

const mountedNavs = new WeakSet<HTMLElement>();

/**
 * 渲染站点主导航：站内页面（分段架）+ 外链（次级样式）。
 * 搜索页自身的「搜索市场」链接使用页内锚点 #search。
 * active 传 null 表示当前页面不属于任何导航项（如账号系统页面），无高亮项。
 */
export function siteNavMarkup(active: SitePage | null): string {
  const items = NAV_ENTRIES.map((entry) => {
    const href =
      entry.page === "search" && active === "search" ? "#search" : entry.href;
    const isActive = entry.page === active;
    const current =
      isActive && active !== "search" ? ' aria-current="page"' : "";
    const badge = entry.isNew ? '<span class="new-badge">NEW</span>' : "";
    return `<a class="nav-item${isActive ? " active" : ""}"${current} href="${href}"><i class="ph ${entry.icon}" aria-hidden="true"></i><span>${entry.label}</span>${badge}</a>`;
  }).join("");
  const externals = EXTERNAL_ENTRIES.map(
    (entry) =>
      `<a class="nav-external" href="${entry.href}" target="_blank" rel="noreferrer"><i class="ph ${entry.icon}" aria-hidden="true"></i><span>${entry.label}</span></a>`,
  ).join("");
  return `
    <nav class="site-nav" aria-label="主导航">
      <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav-menu">
        <i class="ph ph-list" aria-hidden="true"></i><span>菜单</span>
      </button>
      <div id="site-nav-menu" class="nav-menu">
        ${items}
        <span class="nav-sep" aria-hidden="true"></span>
        ${externals}
      </div>
      <div class="auth-nav-slot" data-auth-nav aria-label="账号入口"></div>
    </nav>`;
}

/**
 * 绑定窄屏下的汉堡菜单开合。桌面端菜单钮被 CSS 隐藏，无需处理。
 * 可选透传 store/api，供账号系统页面使用其已构造的 store 实例。
 */
export function mountSiteNav(
  root: ParentNode = document,
  store?: AuthStore,
  api?: AuthApiClient,
): void {
  const nav = root.querySelector<HTMLElement>(".site-nav");
  const toggle = root.querySelector<HTMLButtonElement>(".nav-toggle");
  if (!nav || !toggle) return;
  if (mountedNavs.has(nav)) {
    mountAuthNav(root, store, api);
    return;
  }
  mountedNavs.add(nav);

  const setOpen = (open: boolean): void => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    const icon = toggle.querySelector(".ph");
    if (icon) {
      icon.classList.toggle("ph-list", !open);
      icon.classList.toggle("ph-x", open);
    }
  };

  const ElementConstructor = nav.ownerDocument.defaultView?.Element;

  toggle.addEventListener("click", () => {
    setOpen(!nav.classList.contains("is-open"));
  });
  nav.addEventListener("click", (event) => {
    if (ElementConstructor && event.target instanceof ElementConstructor && event.target.closest("a"))
      setOpen(false);
  });

  const matchMedia =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : undefined;
  if (matchMedia) {
    const desktopQuery = matchMedia("(min-width: 901px)");
    const closeOnDesktop = (event: MediaQueryListEvent): void => {
      if (event.matches) setOpen(false);
    };
    desktopQuery.addEventListener("change", closeOnDesktop);
  }

  mountAuthNav(root, store, api);
}
