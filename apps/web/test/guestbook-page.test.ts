import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { mountGuestbookPage } from '../src/guestbook-page';
import type { GuestbookEntry, ItemAutocomplete } from '../src/types';

const entries: GuestbookEntry[] = [
  { id: 1, category: 'sell', itemId: 100, isZeny: false, contact: '<script>bad</script>', content: '<img src=x onerror=bad()>', createdAt: 1, expiresAt: 2, isExpired: true },
  { id: 2, category: 'suggestion', itemId: null, isZeny: false, contact: null, content: '可以增加地图筛选', createdAt: 3, expiresAt: null, isExpired: false },
];

describe('guestbook page', () => {
  it('renders public entries, escapes user content, and labels expired entries without covering text', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    const api = { searchGuestbook: vi.fn().mockResolvedValue({ items: entries, nextCursor: null }), createGuestbookEntry: vi.fn() };
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(root.querySelectorAll('.guestbook-entry')).toHaveLength(2);
      expect(root.querySelector('.guestbook-entry.is-expired .guestbook-expired-stamp')?.textContent).toContain('已过期');
      expect(root.querySelector('.guestbook-entry.is-expired .guestbook-content')?.textContent).toContain('<img src=x');
      expect(root.querySelector('.guestbook-entry img, .guestbook-entry script')).toBeNull();
      expect(root.querySelector('.guestbook-entry .guestbook-contact')?.textContent).toContain('<script>bad</script>');
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });

  it('requires selected catalog item or Zeny for trades while suggestions need only content', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    const item: ItemAutocomplete = { itemId: 100, name: '波利卡片', aliases: [] };
    const api = { searchGuestbook: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), createGuestbookEntry: vi.fn().mockResolvedValue({ item: entries[1] }) };
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any);
      const form = root.querySelector<HTMLFormElement>('#guestbook-form')!;
      const tradeEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(tradeEvent);
      expect(api.createGuestbookEntry).not.toHaveBeenCalled();
      expect(root.querySelector('#guestbook-form-status')?.textContent).toContain('请选择');
      const suggestion = root.querySelector<HTMLInputElement>('input[name="category"][value="suggestion"]')!;
      suggestion.checked = true;
      suggestion.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(root.querySelector<HTMLInputElement>('#guestbook-contact')?.disabled).toBe(true);
      root.querySelector<HTMLTextAreaElement>('#guestbook-content')!.value = '建议';
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(api.createGuestbookEntry).toHaveBeenCalledWith({ category: 'suggestion', content: '建议' });
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });

  it('uses the same guestbook navigation in the current route', () => {
    const dom = new JSDOM('<main id="app"></main>');
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    try {
      mountGuestbookPage(dom.window.document.querySelector<HTMLElement>('#app')!, { searchGuestbook: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), createGuestbookEntry: vi.fn() } as any);
      expect(dom.window.document.querySelector('.site-nav a[aria-current="page"]')?.getAttribute('href')).toBe('/guestbook');
    } finally { Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument }); }
  });

  it('offers Zeny as the first item choice without a separate checkbox', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    const api = { searchGuestbook: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), createGuestbookEntry: vi.fn() };
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any);
      const query = root.querySelector<HTMLInputElement>('#guestbook-item-query')!;
      expect(root.querySelector('#guestbook-zeny')).toBeNull();
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(root.querySelector('#guestbook-item-suggestions [data-zeny]')?.textContent).toContain('Zeny');
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });

  it('hydrates trade entries with the catalog name and item description', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/catalog/items.json')) return new Response(JSON.stringify({ items: [{ itemId: 601, name: '苍蝇翅膀', aliases: [] }] }), { status: 200 });
      return new Response(JSON.stringify({ descriptions: [{ itemId: 601, description: '可以瞬间移动到随机位置。' }] }), { status: 200 });
    }));
    const api = {
      searchGuestbook: vi.fn().mockResolvedValue({ items: [{ id: 7, category: 'buy', itemId: 601, isZeny: false, contact: 'QQ', content: '收购一组', createdAt: 1, expiresAt: null, isExpired: false }], nextCursor: null }),
      createGuestbookEntry: vi.fn(),
    };
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(root.querySelector('.guestbook-item-name')?.textContent).toBe('苍蝇翅膀');
      expect(root.querySelector('.guestbook-item-description')?.textContent).toContain('可以瞬间移动');
      expect(root.querySelector('.guestbook-item-name')?.textContent).not.toContain('#601');
    } finally {
      vi.stubGlobal('fetch', previousFetch);
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });
});
