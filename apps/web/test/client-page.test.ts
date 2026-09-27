import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
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
      expect(root.querySelectorAll('.compare-table tbody tr')).toHaveLength(14);
      expect(root.querySelectorAll('.issue-item')).toHaveLength(5);
      // 半开放测试页：主导航不包含 /client 入口，也没有任何 active 高亮。
      expect(root.querySelector('.site-nav a[href="/client"]')).toBeNull();
      expect(root.querySelector('.site-nav a[aria-current="page"]')).toBeNull();
      // 安装包 URL 未配置时展示「即将发布」占位态。
      expect(root.querySelector('.download-button.is-pending')?.textContent).toContain('安装包即将发布');
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
});
