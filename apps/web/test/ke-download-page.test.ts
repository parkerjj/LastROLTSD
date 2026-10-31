import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountKeDownloadPage } from '../src/ke-download-page';

const ANDROID_ENTRY = {
  version: '1.296.261028',
  versionCode: 100000296,
  url: 'https://client.ltsd.ro/ke/standalone/releases/1.296.261028/kore-android.apk',
  fileName: 'kore-android.apk',
  sha256: '2ba42bbc54d2dc00ee39b5a6a4fbe4e4dec39ca03556ff652a7ed7e9c0d90f12',
  size: 14066137,
  minOs: '8.0',
  abi: 'arm64-v8a',
};

const WINDOWS_ENTRY = {
  version: '1.296.261028',
  url: 'https://client.ltsd.ro/ke/standalone/releases/1.296.261028/KoreEngine-Setup-1.296.261028-x64.exe',
  fileName: 'KoreEngine-Setup-1.296.261028-x64.exe',
  sha256: '9c41e2a0d5f16cc8b0e9a1f4d2a7c3e58b6f0d4179a2c5e8d3b14f6a8c6b7a90',
  size: 40000000,
  minOs: '10',
  abi: 'x64',
};

async function renderPage(
  search = '',
  payload: unknown = { schemaVersion: 1, channel: 'stable', platforms: { android: ANDROID_ENTRY } },
): Promise<{ root: HTMLElement; restore: () => void }> {
  const dom = new JSDOM('<main id="app"></main>', { url: `https://ltsd.ro/ke/download${search}` });
  const previousDocument = globalThis.document;
  const previousWindow = (globalThis as Record<string, unknown>).window;
  const previousNavigator = globalThis.navigator;
  const previousFetch = globalThis.fetch;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/ke/downloads')) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // 账号导航的 bootstrap 请求不参与本页断言。
    return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  const root = dom.window.document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing test app root');
  await mountKeDownloadPage(root);
  return {
    root,
    restore: () => {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KoreEngine standalone download page', () => {
  it('renders the release board, platform cards and FAQ structure', async () => {
    const { root, restore } = await renderPage();
    try {
      expect(root.querySelector('h1')?.textContent).toContain('脱机版');
      expect(root.querySelectorAll('.board-row')).toHaveLength(4);
      expect(root.querySelectorAll('.dl-card')).toHaveLength(2);
      expect(root.querySelectorAll('.kd-faq-list details')).toHaveLength(7);

      const navLink = root.querySelector('.site-nav a[href="/ke/download"]');
      expect(navLink).not.toBeNull();
      expect(navLink?.getAttribute('aria-current')).toBe('page');
      expect(navLink?.querySelector('.new-badge')).not.toBeNull();

      expect(root.querySelector('.footer-links a[href="/ke/download"]')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('fills the Android card from the manifest and leaves Windows unpublished', async () => {
    const { root, restore } = await renderPage();
    try {
      const androidCard = root.querySelector('.dl-card--android');
      expect(androidCard?.textContent).toContain('1.296.261028');
      expect(androidCard?.textContent).toContain('13.4 MB');
      expect(androidCard?.textContent).toContain('kore-android.apk');
      expect(androidCard?.textContent).toContain('Android 8.0 及以上');
      expect(androidCard?.querySelector('code')).toBeNull();

      const androidButton = androidCard?.querySelector<HTMLAnchorElement>('a.dl-button');
      expect(androidButton?.getAttribute('href')).toBe('/ke/download?platform=android');

      const windowsCard = root.querySelector('.dl-card--windows');
      expect(windowsCard?.querySelector('.status')?.textContent).toContain('暂未发布');
      expect(windowsCard?.querySelector('a.dl-button')).toBeNull();

      const readyRows = [...root.querySelectorAll('.board-row.is-ready')];
      expect(readyRows).toHaveLength(1);
      expect(readyRows[0]?.getAttribute('href')).toBe('/ke/download?platform=android');
    } finally {
      restore();
    }
  });

  it('links both platforms when both entries exist', async () => {
    const { root, restore } = await renderPage('', {
      schemaVersion: 1,
      channel: 'stable',
      platforms: { windows: WINDOWS_ENTRY, android: ANDROID_ENTRY },
    });
    try {
      expect(root.querySelectorAll('.board-row.is-ready')).toHaveLength(2);
      expect(root.querySelectorAll('a.dl-button')).toHaveLength(2);
      const windowsCard = root.querySelector('.dl-card--windows');
      expect(windowsCard?.textContent).toContain('38.1 MB');
      expect(windowsCard?.textContent).toContain('KoreEngine-Setup-1.296.261028-x64.exe');
      expect(root.querySelectorAll('.kd-hero-actions a.kd-btn')).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('shows a status alert for invalid platform parameters', async () => {
    const { root, restore } = await renderPage('?status=invalid&platform=linux');
    try {
      const alert = root.querySelector<HTMLElement>('[data-alert]');
      expect(alert?.hidden).toBe(false);
      expect(alert?.textContent).toContain('不支持的平台参数');
    } finally {
      restore();
    }
  });

  it('disables download actions when the manifest cannot be loaded', async () => {
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn(async () => new Response('boom', { status: 500 })),
    });
    try {
      const dom = new JSDOM('<main id="app"></main>', { url: 'https://ltsd.ro/ke/download' });
      const previousDocument = globalThis.document;
      const previousWindow = (globalThis as Record<string, unknown>).window;
      Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
      const root = dom.window.document.querySelector<HTMLElement>('#app');
      if (!root) throw new Error('Missing test app root');
      await mountKeDownloadPage(root);

      expect(root.querySelector('.kd-manifest-state.is-error')).not.toBeNull();
      expect(root.querySelectorAll('.dl-button.is-disabled')).toHaveLength(2);
      expect(root.querySelectorAll('.kd-hero-actions .kd-btn.is-disabled')).toHaveLength(2);

      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch });
    }
  });
});
