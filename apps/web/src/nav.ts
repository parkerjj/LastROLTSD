import { mountAuthNav } from "./auth/nav";
import type { AuthApiClient } from "./auth/api";
import type { AuthStore } from "./auth/store";

export type SitePage =
  | "search"
  | "accounts"
  | "guestbook"
  | "updates"
  | "client"
  | "sponsors"
  | "guide"
  | "download"
  | "ke";

interface NavEntry {
  readonly page: SitePage;
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly isNew?: boolean;
}

/**
 * KoreEngine 下拉菜单：把原本散在主导航里的两个入口合并成一个分组，
 * 同时补齐 /ke/* 的其它页面。购买增量单独标亮，避免用户找不到加购入口。
 */
interface KeMenuEntry {
  readonly href: string;
  readonly label: string;
  readonly note: string;
  readonly icon: string;
  readonly isNew?: boolean;
  readonly isHot?: boolean;
}

const KE_MENU_ENTRIES: readonly KeMenuEntry[] = [
  {
    href: "/ke/guide",
    label: "KE 指南",
    note: "第一次用先看这里",
    icon: "ph-compass",
  },
  {
    href: "/ke/my",
    label: "我的 KE 配置",
    note: "编辑角色的挂机方案",
    icon: "ph-sliders-horizontal",
  },
  {
    href: "/ke/download",
    label: "脱机版下载",
    note: "Windows / Android 客户端",
    icon: "ph-download-simple",
    isNew: true,
  },
  {
    href: "/ke/buy",
    label: "购买增量",
    note: "增加实例额度与时长",
    icon: "ph-plus-circle",
    isHot: true,
  },
];

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
  },
  {
    page: "guestbook",
    href: "/guestbook",
    label: "留言板",
    icon: "ph-address-book",
  },
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
  });
  // KoreEngine 分组紧跟在「搜索市场」之后，其余站内入口顺延。
  const siteItems = `${items[0] ?? ""}${keGroupMarkup(active)}${items.slice(1).join("")}`;
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
        ${siteItems}
        <span class="nav-sep" aria-hidden="true"></span>
        ${externals}
      </div>
      <div class="auth-nav-slot" data-auth-nav aria-label="账号入口"></div>
    </nav>`;
}

function keGroupMarkup(active: SitePage | null): string {
  const groupActive =
    active === "guide" || active === "download" || active === "ke";
  const links = KE_MENU_ENTRIES.map((entry) => {
    const isCurrent =
      (entry.href === "/ke/guide" && active === "guide") ||
      (entry.href === "/ke/download" && active === "download");
    const current = isCurrent ? ' aria-current="page"' : "";
    const hot = entry.isHot ? " is-hot" : "";
    const badge = entry.isNew ? '<span class="new-badge">NEW</span>' : "";
    const tag = entry.isHot ? '<span class="nav-subitem-tag">加购</span>' : "";
    return `<a class="nav-subitem${hot}" href="${entry.href}" role="menuitem"${current}><i class="ph ${entry.icon}" aria-hidden="true"></i><span class="nav-subitem-copy"><span>${entry.label}</span><small>${entry.note}</small></span>${badge}${tag}</a>`;
  }).join("");
  return `<div class="nav-group${groupActive ? " is-active" : ""}" data-nav-group>
        <button type="button" class="nav-item nav-group-trigger${groupActive ? " active" : ""}" aria-haspopup="true" aria-expanded="false" aria-controls="site-nav-ke">
          <i class="ph ph-game-controller" aria-hidden="true"></i><span>KoreEngine</span><i class="ph ph-caret-down nav-group-caret" aria-hidden="true"></i>
        </button>
        <div class="nav-group-menu" id="site-nav-ke" role="menu" aria-label="KoreEngine 相关页面">
          ${links}
        </div>
      </div>`;
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
    if (
      ElementConstructor &&
      event.target instanceof ElementConstructor &&
      event.target.closest("a")
    )
      setOpen(false);
  });

  mountNavGroups(nav);

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

/**
 * KoreEngine 下拉分组：桌面端鼠标移入即展开，触屏由点击触发；
 * 点击分组外部或按 Esc 收起。
 */
function mountNavGroups(nav: HTMLElement): void {
  const groups = Array.from(nav.querySelectorAll<HTMLElement>("[data-nav-group]"));
  if (groups.length === 0) return;
  const doc = nav.ownerDocument;
  const win = doc.defaultView;
  const canHover =
    typeof win?.matchMedia === "function" && win.matchMedia("(hover: hover)").matches;

  const setGroupOpen = (group: HTMLElement, open: boolean): void => {
    group.classList.toggle("is-open", open);
    group
      .querySelector(".nav-group-trigger")
      ?.setAttribute("aria-expanded", String(open));
  };

  for (const group of groups) {
    const trigger = group.querySelector<HTMLElement>(".nav-group-trigger");
    if (!trigger) continue;
    trigger.addEventListener("click", () => {
      setGroupOpen(group, !group.classList.contains("is-open"));
    });
    if (canHover) {
      group.addEventListener("mouseenter", () => setGroupOpen(group, true));
      group.addEventListener("mouseleave", () => setGroupOpen(group, false));
    }
  }

  const closeAll = (): void => {
    for (const group of groups) setGroupOpen(group, false);
  };
  doc.addEventListener("click", (event) => {
    const target = event.target;
    if (
      !target ||
      typeof target !== "object" ||
      !("nodeType" in target) ||
      target.nodeType !== 1
    )
      return;
    if ((target as Element).closest("[data-nav-group]")) return;
    closeAll();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });
}
