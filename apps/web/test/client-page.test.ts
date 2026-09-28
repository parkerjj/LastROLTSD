import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { mountClientPage } from '../src/client-page';

function mountInJsdom() {
  const dom = new JSDOM('<main id="app"></main>');
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousWindow = (globalThis as Record<string, unknown>).window;
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
  const root = dom.window.document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing test app root');
  mountClientPage(root);
  const restore = () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  };
  return { root, written, restore };
}

describe('client page', () => {
  it('renders the IWA client guide page', () => {
    const { root, restore } = mountInJsdom();

    try {
      expect(root.querySelector('h1')?.textContent).toBe('进阶客户端');
      expect(root.querySelectorAll('.install-step')).toHaveLength(3);
      expect(root.querySelectorAll('.compare-table tbody tr')).toHaveLength(15);
      expect(root.querySelectorAll('.issue-item')).toHaveLength(4);
      // 正式页面：主导航包含 /client 入口并带 NEW 徽章，当前页高亮。
      const navLink = root.querySelector('.site-nav a[href="/client"]');
      expect(navLink).not.toBeNull();
      expect(navLink?.getAttribute('aria-current')).toBe('page');
      expect(navLink?.textContent).toContain('进阶客户端');
      expect(navLink?.querySelector('.new-badge')).not.toBeNull();
      // 菜农监控台的 NEW 徽章已移除，全站只有进阶客户端携带 NEW。
      const accountsNav = root.querySelector('.site-nav a[href="/accounts"]');
      expect(accountsNav).not.toBeNull();
      expect(accountsNav?.querySelector('.new-badge')).toBeNull();
      // 无下载按钮——安装通过 Update Manifest URL 优先在 chrome://iwa-dev 中完成。
      expect(root.querySelector('a.download-button')).toBeNull();
      expect(root.querySelector('.qq-copy')?.getAttribute('data-copy')).toBe('725955796');
      // 安装教程包含三个开关、更新指引、可用的安装入口与 Update Manifest URL。
      expect(root.textContent).toContain('chrome://web-app-internals');
      expect(root.textContent).toContain('enable-isolated-web-apps');
      expect(root.textContent).toContain('enable-isolated-web-app-dev-mode');
      expect(root.textContent).toContain('Update Manifest');
      expect(root.textContent).toContain('Chrome 154');
      expect(root.querySelector('.install-step a[href="https://www.google.cn/chrome/"]')).not.toBeNull();
      // chrome:// 和 https:// 地址渲染为点击复制芯片。
      const copyChips = [...root.querySelectorAll('.install-steps .copy-chip')].map((el) => el.getAttribute('data-copy'));
      expect(copyChips).toEqual([
        'chrome://flags/#enable-isolated-web-apps',
        'chrome://flags/#enable-isolated-web-app-dev-mode',
        'https://www.google.cn/chrome/',
        'chrome://iwa-dev',
        'chrome://web-app-internals',
        'https://client.ltsd.ro/updates.json',
      ]);
    } finally {
      restore();
    }
  });

  it('copies chrome:// addresses to the clipboard when a chip is clicked', async () => {
    const { root, written, restore } = mountInJsdom();

    try {
      const chip = root.querySelector<HTMLButtonElement>('.install-steps .copy-chip[data-copy="chrome://iwa-dev"]');
      if (!chip) throw new Error('Missing iwa-dev copy chip');

      chip.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(written).toEqual(['chrome://iwa-dev']);
      expect(chip.querySelector('.copy-hint')?.textContent).toBe('已复制');
    } finally {
      restore();
    }
  });

  it('updates the displayed version from the latest release info', async () => {
    const previousFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: '0.1.101', src: 'https://client.ltsd.ro/releases/0.1.101/lastro-v2-abc.swbn' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    try {
      const { root, restore } = mountInJsdom();
      try {
        // 等待 refreshLatestRelease 的异步 fetch 完成并更新 DOM。
        await vi.waitFor(() => expect(root.querySelector('[data-latest-version]')?.textContent).toBe('v0.1.101'), { timeout: 1000 });
        expect(fetchMock).toHaveBeenCalledWith('/api/v1/iwa/info', expect.objectContaining({ headers: expect.any(Object) }));
      } finally {
        restore();
      }
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch });
    }
  });
});
