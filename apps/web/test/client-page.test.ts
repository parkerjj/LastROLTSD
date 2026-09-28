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
  it('renders the IWA client guide as an unlisted page', () => {
    const { root, restore } = mountInJsdom();

    try {
      expect(root.querySelector('h1')?.textContent).toBe('进阶客户端');
      expect(root.querySelectorAll('.install-step')).toHaveLength(4);
      expect(root.querySelectorAll('.compare-table tbody tr')).toHaveLength(15);
      expect(root.querySelectorAll('.issue-item')).toHaveLength(5);
      // 半开放测试页：主导航不包含 /client 入口，也没有任何 active 高亮。
      expect(root.querySelector('.site-nav a[href="/client"]')).toBeNull();
      expect(root.querySelector('.site-nav a[aria-current="page"]')).toBeNull();
      // 下载按钮固定指向 Worker 的 latest 端点，发布新版本无需改页面。
      const downloadLink = root.querySelector<HTMLAnchorElement>('a.download-button');
      expect(downloadLink?.getAttribute('href')).toBe('/api/v1/iwa/latest');
      expect(root.querySelector('.qq-copy')?.getAttribute('data-copy')).toBe('725955796');
      // 安装教程指向真实的 IWA 安装入口：Dev Mode flag + chrome://iwa-dev。
      expect(root.textContent).toContain('chrome://iwa-dev');
      expect(root.textContent).toContain('enable-isolated-web-app-dev-mode');
      // chrome:// 无法做成超链接，渲染为点击复制芯片。
      const copyChips = [...root.querySelectorAll('.install-steps .copy-chip')].map((el) => el.getAttribute('data-copy'));
      expect(copyChips).toEqual([
        'chrome://flags/#enable-isolated-web-app-dev-mode',
        'chrome://iwa-dev',
        'chrome://web-app-internals',
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
        // 有可用 Release 时下载按钮保持可点击链接。
        expect(root.querySelector('a.download-button')?.getAttribute('href')).toBe('/api/v1/iwa/latest');
      } finally {
        restore();
      }
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch });
    }
  });

  it('falls back to the pending state when no release is available', async () => {
    const previousFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no release available' }), { status: 404 }));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    try {
      const { root, restore } = mountInJsdom();
      try {
        await vi.waitFor(() => expect(root.querySelector('.download-button.is-pending')?.textContent).toContain('安装包即将发布'), { timeout: 1000 });
      } finally {
        restore();
      }
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch });
    }
  });
});
