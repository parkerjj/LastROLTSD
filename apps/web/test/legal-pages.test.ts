import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mountSiteNav: vi.fn(),
  siteNavMarkup: () => '<nav></nav>',
  injectLegalLinksIntoFooters: vi.fn(),
  renderSiteFooter: () => '',
}));

vi.mock('../src/nav', () => ({
  mountSiteNav: mocks.mountSiteNav,
  siteNavMarkup: mocks.siteNavMarkup,
}));
vi.mock('../src/footer-links', () => ({
  injectLegalLinksIntoFooters: mocks.injectLegalLinksIntoFooters,
  renderSiteFooter: mocks.renderSiteFooter,
}));

import { mountPrivacyPage } from '../src/privacy-page';
import { mountTermsPage } from '../src/terms-page';

afterEach(() => vi.unstubAllGlobals());

it('describes the implemented password storage and login-gated configuration sharing', () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/privacy' });
  vi.stubGlobal('document', dom.window.document);
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;

  mountPrivacyPage(root);

  const content = root.textContent ?? '';
  expect(content).toContain('keyed HMAC-SHA-256');
  expect(content).toContain('visible only to logged-in users');
  expect(content).not.toContain('bcrypt');
  expect(content).not.toContain('displayed publicly');

  mountTermsPage(root);
  const terms = root.textContent ?? '';
  expect(terms).toContain('at least 18 years old');
  expect(content).toContain('The Terms require you to be at least 18');
  expect(content).toContain('not directed at individuals under 18.');
  expect(content).not.toContain('individuals under 16 years of age');
  dom.window.close();
});
