/**
 * Legal page shared components: unified header, updated date, body layout, operator entity footer.
 * Reference: depthsignal.io /legal/privacy and Estonian SaaS privacy policy conventions.
 */

import { siteNavMarkup, mountSiteNav } from "./nav";
import {
  LEGAL_ADDRESS_LINE1,
  LEGAL_ADDRESS_LINE2,
  LEGAL_EMAIL,
  LEGAL_ENTITY_NAME,
  LEGAL_LEGAL_FORM,
  LEGAL_REGISTRY_CODE,
  LEGAL_REGISTRY_URL,
} from "./legal-constants";
import { injectLegalLinksIntoFooters, renderSiteFooter } from "./footer-links";

const LEGAL_UPDATED_DATE = "2026-10-23";

interface LegalPageConfig {
  readonly pageTitle: string;
  readonly pageSlug: string;
  readonly subtitle: string;
  readonly sections: readonly LegalSection[];
}

interface LegalSection {
  readonly heading: string;
  readonly body: string;
}

export function renderLegalPageMarkup(config: LegalPageConfig): string {
  return `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro 首页"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup(null)}
    </div>
  </header>
  <main class="page-width legal-page">
    <nav class="legal-breadcrumb" aria-label="法律文档导航">
      <a href="/">← 返回首页</a>
      <span aria-hidden="true">·</span>
      <span>${config.pageTitle}</span>
    </nav>
    <header class="legal-hero">
      <p class="eyebrow">LEGAL DOCUMENTS</p>
      <h1>${config.pageTitle}</h1>
      <p class="legal-subtitle">${config.subtitle}</p>
      <p class="legal-updated">Last updated: ${LEGAL_UPDATED_DATE}</p>
    </header>
    <article class="legal-body">
      ${config.sections.map((s) => `
      <section class="legal-section" aria-labelledby="${slug(s.heading)}">
        <h2 id="${slug(s.heading)}">${s.heading}</h2>
        ${s.body}
      </section>
      `).join("")}
      <section class="legal-section legal-section--entity" aria-labelledby="legal-entity">
        <h2 id="legal-entity">Operator / 运营方</h2>
        <dl class="legal-entity-dl">
          <dt>Entity name</dt><dd>${LEGAL_ENTITY_NAME}</dd>
          <dt>Legal form</dt><dd>${LEGAL_LEGAL_FORM}</dd>
          <dt>Registry code</dt><dd><a href="${LEGAL_REGISTRY_URL}" target="_blank" rel="noopener noreferrer">${LEGAL_REGISTRY_CODE}</a></dd>
          <dt>Address</dt><dd>${LEGAL_ADDRESS_LINE1}<br />${LEGAL_ADDRESS_LINE2}</dd>
          <dt>Contact email</dt><dd><a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a></dd>
          <dt>Governing law</dt><dd>Republic of Estonia (EU)</dd>
        </dl>
      </section>
    </article>
  </main>
  ${renderSiteFooter()}
  `;
}

function slug(heading: string): string {
  return heading
    .replace(/^\d+(?:\.\d+)*\.\s+/u, "")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/gu, "-")
    .toLowerCase()
    .replace(/^-|-$/gu, "");
}

export function mountLegalPage(
  root: HTMLElement,
  config: LegalPageConfig,
  documentTitle: string,
): void {
  document.title = documentTitle;
  root.innerHTML = renderLegalPageMarkup(config);
  mountSiteNav(root);
  injectLegalLinksIntoFooters(root);
}

export type { LegalPageConfig, LegalSection };
