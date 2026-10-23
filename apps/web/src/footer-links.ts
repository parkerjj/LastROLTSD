/**
 * Shared footer legal-link injection.
 *
 * Existing pages (main / release / accounts / guestbook / client / sponsor / vip)
 * each inline their own `.footer-links` div with internal navigation entries.
 * Instead of hardcoding the three legal links into every one of those inlined
 * HTML strings, we call `injectLegalLinksIntoFooters(root)` once after each page
 * has mounted — a single source of truth that stays in sync across the whole site.
 *
 * Note: this function looks for `.footer-links` containers. auth/pages.ts uses a
 * simplified footer without that class — that is acceptable under GDPR as long
 * as the legal links are discoverable from any main-site page.
 */

import { LEGAL_ENTITY_NAME, LEGAL_REGISTRY_CODE, LEGAL_EMAIL, SITE_URL } from "./legal-constants";

export const LEGAL_LINKS: readonly { readonly label: string; readonly href: string }[] =
  [
    { label: "Terms", href: "/terms" },
    { label: "Privacy", href: "/privacy" },
    { label: "Refunds", href: "/refunds" },
  ];

export function legalLinksMarkup(): string {
  return LEGAL_LINKS.map(
    (link) => `<a href="${link.href}">${link.label}</a>`,
  ).join("");
}

/**
 * Finds every `.footer-links` container within the given root and appends the
 * three legal links to each. Duplicate-safe: if an `<a href="/terms">` already
 * exists in a container it won't be appended again.
 */
export function injectLegalLinksIntoFooters(root: ParentNode = document): void {
  const containers = root.querySelectorAll<HTMLElement>(".footer-links");
  if (containers.length === 0) return;
  for (const container of containers) {
    const existing = new Set(
      Array.from(container.querySelectorAll<HTMLAnchorElement>("a"))
        .map((a) => a.getAttribute("href")),
    );
    for (const link of LEGAL_LINKS) {
      if (existing.has(link.href)) continue;
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.label;
      container.append(a);
    }
  }
}

/** Complete site footer markup (used by legal pages, matching the Chinese brand pattern of all other pages). */
export function renderSiteFooter(): string {
  return `
<footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">留言板</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>Operator: ${LEGAL_ENTITY_NAME} (reg. ${LEGAL_REGISTRY_CODE}) · Contact: ${LEGAL_EMAIL} · ${SITE_URL}</small></div></footer>`;
}
