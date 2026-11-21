import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { mountClientPage } from '../src/client-page';

function mountInJsdom(fetchImpl?: typeof fetch) {
  const dom = new JSDOM('<main id="app"></main>');
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousWindow = (globalThis as Record<string, unknown>).window;
  const previousFetch = globalThis.fetch;
  const written: string[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: fetchImpl ?? vi.fn().mockRejectedValue(new Error('offline')),
  });
  const root = dom.window.document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing test app root');
  mountClientPage(root);
  const restore = () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch });
  };
  return { root, written, restore };
}

describe('client page', () => {
  it('renders the Native client download page without legacy installation content', () => {
    const { root, restore } = mountInJsdom();

    try {
      expect(root.querySelector('h1')?.textContent).toBe('进阶客户端');
      expect(root.querySelectorAll('.native-platform-card')).toHaveLength(3);
      expect(root.querySelectorAll('.native-capability')).toHaveLength(4);
      expect(root.querySelectorAll('.compare-table tbody tr')).toHaveLength(15);
      expect(root.querySelector('#issues-title')).toBeNull();
      expect(root.querySelector('.issue-list')).toBeNull();
      expect(root.textContent).not.toContain('已知问题');
      const navLink = root.querySelector('.site-nav a[href="/client"]');
      expect(navLink).not.toBeNull();
      expect(navLink?.getAttribute('aria-current')).toBe('page');
      expect(navLink?.textContent).toContain('进阶客户端');
      // 导航中仅脱机版入口带 NEW 徽章。
      const newBadges = [...root.querySelectorAll('.site-nav .new-badge')];
      expect(newBadges).toHaveLength(1);
      expect(newBadges[0]?.closest('a')?.getAttribute('href')).toBe('/ke/download');
      const accountsNav = root.querySelector('.site-nav a[href="/accounts"]');
      expect(accountsNav).not.toBeNull();

      const windowsLinks = [...root.querySelectorAll('a[data-native-asset="windows-x86_64"]')];
      expect(windowsLinks).toHaveLength(2);
      expect(windowsLinks.every((link) => link.getAttribute('href')?.endsWith('-windows-x64-setup.exe'))).toBe(true);
      expect(root.querySelector('a[data-native-asset="darwin-universal"]')?.getAttribute('href')).toContain('-macos-universal.dmg');
      expect(root.querySelectorAll('a[data-native-asset^="linux-"]')).toHaveLength(4);
      expect(root.querySelector('.client-app-identity img')?.getAttribute('src')).toBe('/brand/LRO-Native.png');
      expect(root.querySelector('.qq-copy')?.getAttribute('data-copy')).toBe('725955796');

      for (const legacyContent of ['chrome://', 'IWA', 'Isolated Web App', 'Update Manifest', '.swbn', 'enable-isolated-web-apps']) {
        expect(root.textContent).not.toContain(legacyContent);
      }
      expect(root.querySelector('.install-steps')).toBeNull();
      expect(root.querySelector('.step-thumb')).toBeNull();
      expect(root.querySelector('.copy-chip')).toBeNull();
    } finally {
      restore();
    }
  });

  it('copies the QQ group number to the clipboard', async () => {
    const { root, written, restore } = mountInJsdom();

    try {
      const button = root.querySelector<HTMLButtonElement>('.qq-copy');
      if (!button) throw new Error('Missing QQ copy button');

      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(written).toEqual(['725955796']);
      expect(button.querySelector('.copy-hint')?.textContent).toBe('已复制');
    } finally {
      restore();
    }
  });

  it('updates Native versions, download URLs and file sizes from official manifests', async () => {
    const version = '1.2000.000000';
    const windowsUrl = `https://client.ltsd.ro/native/${version}/windows.exe`;
    const linuxUrl = `https://client.ltsd.ro/native/${version}/linux.deb`;
    const latest = {
      version,
      installers: {
        'windows-x86_64': { url: windowsUrl, size: 30_000_000 },
        'darwin-universal': { url: `https://client.ltsd.ro/native/${version}/macos.dmg`, size: 50_000_000 },
      },
    };
    const linux = {
      version,
      platforms: {
        'linux-x86_64-deb': { url: linuxUrl, size: 40_000_000 },
      },
    };
    const fetchMock = vi.fn().mockImplementation((input) => {
      const payload = String(input).endsWith('/linux') ? linux : latest;
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    const { root, restore } = mountInJsdom(fetchMock);

    try {
      await vi.waitFor(() => expect(root.querySelector('[data-native-version]')?.textContent).toBe(`v${version}`), { timeout: 1000 });
      expect(root.querySelector('a[data-native-asset="windows-x86_64"]')?.getAttribute('href')).toBe(windowsUrl);
      expect(root.querySelector('[data-native-size="windows-x86_64"]')?.textContent).toBe('30.0 MB');
      expect(root.querySelector('a[data-native-asset="linux-x86_64-deb"]')?.getAttribute('href')).toBe(linuxUrl);
      expect(root.querySelector('[data-native-size="linux-x86_64-deb"]')?.textContent).toBe('40.0 MB');
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/native/latest', expect.objectContaining({ headers: expect.any(Object) }));
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/native/linux', expect.objectContaining({ headers: expect.any(Object) }));
    } finally {
      restore();
    }
  });
});
