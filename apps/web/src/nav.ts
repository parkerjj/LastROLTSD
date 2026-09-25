export type SitePage = "search" | "accounts" | "guestbook" | "updates";

interface NavEntry {
  readonly page: SitePage;
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly isNew?: boolean;
}

const NAV_ENTRIES: readonly NavEntry[] = [
  { page: "search", href: "/#search", label: "搜索市场", icon: "ph-magnifying-glass" },
  { page: "accounts", href: "/accounts", label: "账号监控台", icon: "ph-monitor", isNew: true },
  { page: "guestbook", href: "/guestbook", label: "玩家登记簿", icon: "ph-address-book" },
  { page: "updates", href: "/updates", label: "更新说明", icon: "ph-scroll" },
];

const EXTERNAL_ENTRIES: ReadonlyArray<{ readonly href: string; readonly label: string; readonly icon: string }> = [
  { href: "https://github.com/parkerjj/LastROLTSD", label: "代码仓库", icon: "ph-github-logo" },
  { href: "https://game.lastro.cn/?r=pc/news&nid=5", label: "LastRO 官网", icon: "ph-arrow-square-out" },
];

/**
 * 渲染站点主导航：站内页面（分段架）+ 外链（次级样式）。
 * 搜索页自身的「搜索市场」链接使用页内锚点 #search。
 */
export function siteNavMarkup(active: SitePage): string {
  const items = NAV_ENTRIES.map((entry) => {
    const href = entry.page === "search" && active === "search" ? "#search" : entry.href;
    const isActive = entry.page === active;
    const current = isActive && active !== "search" ? ' aria-current="page"' : "";
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
    </nav>`;
}

/**
 * 绑定窄屏下的汉堡菜单开合。桌面端菜单钮被 CSS 隐藏，无需处理。
 */
export function mountSiteNav(root: ParentNode = document): void {
  const nav = root.querySelector<HTMLElement>(".site-nav");
  const toggle = root.querySelector<HTMLButtonElement>(".nav-toggle");
  if (!nav || !toggle) return;

  const setOpen = (open: boolean): void => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    const icon = toggle.querySelector(".ph");
    if (icon) {
      icon.classList.toggle("ph-list", !open);
      icon.classList.toggle("ph-x", open);
    }
  };

  toggle.addEventListener("click", () => {
    setOpen(!nav.classList.contains("is-open"));
  });
  nav.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
  });

  const matchMedia =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : undefined;
  if (matchMedia) {
    const desktopQuery = matchMedia("(min-width: 761px)");
    const closeOnDesktop = (event: MediaQueryListEvent): void => {
      if (event.matches) setOpen(false);
    };
    desktopQuery.addEventListener("change", closeOnDesktop);
  }
}
