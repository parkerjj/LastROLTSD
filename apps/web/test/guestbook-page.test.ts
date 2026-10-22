import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { mountGuestbookPage } from '../src/guestbook-page';
import type { GuestbookAuthor, GuestbookEntry, GuestbookReply } from '../src/types';

const signedInUser = {
  id: '10002', email: 'n@example.com', display_name: '小明', status: 'ACTIVE', permission_level: 1,
  email_verified_at: 1, created_at: 1, has_avatar: true, avatar_version: 2,
  avatar_url: '/api/v1/users/10002/avatar?v=2',
};

const anonymousStore = { getState: () => ({ status: 'anonymous' }), subscribe: () => () => {} };
const activeStore = {
  getState: () => ({ status: 'active', user: signedInUser, expiresAt: Number.MAX_SAFE_INTEGER, mailAvailability: null }),
  subscribe: () => () => {},
};

const authorOf = (overrides: Partial<GuestbookAuthor> = {}): GuestbookAuthor => ({
  userId: '10002', displayName: '小明', hasAvatar: false, avatarVersion: 0,
  avatarUrl: '/api/v1/users/10002/avatar?v=0', permission_level: 1, ...overrides,
});

const entryOf = (overrides: Partial<GuestbookEntry> = {}): GuestbookEntry => ({
  id: 1, category: 'suggestion', itemId: null, isZeny: false, contact: null, content: '内容',
  createdAt: 1, expiresAt: null, isExpired: false, editedAt: null, author: null, replies: [],
  replyCount: 0, hasMoreReplies: false, hasReplied: null,
  ...overrides,
});

const replyOf = (overrides: Partial<GuestbookReply> = {}): GuestbookReply => ({
  id: 11, entryId: 1, content: '回复', createdAt: 100, editedAt: null, author: authorOf(), ...overrides,
});

function apiReturning(items: GuestbookEntry[]) {
  return { searchGuestbook: vi.fn().mockResolvedValue({ items, nextCursor: null }) };
}

function mount(entries: GuestbookEntry[], options: { store?: object; auth?: object } = {}) {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const api = apiReturning(entries);
  const auth = options.auth ?? { sessionRequest: vi.fn() };
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  mountGuestbookPage(root, api as any, { store: (options.store ?? anonymousStore) as any, auth: auth as any });
  const restore = () => Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  return { dom, root, api, auth: auth as { sessionRequest: ReturnType<typeof vi.fn> }, restore };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const adminStore = {
  getState: () => ({ status: 'active', user: { ...signedInUser, id: '1', permission_level: 100 }, expiresAt: Number.MAX_SAFE_INTEGER, mailAvailability: null }),
  subscribe: () => () => {},
};

describe('guestbook page', () => {
  it('renders public entries, escapes user content, and labels expired entries without covering text', async () => {
    const entries = [
      entryOf({ id: 1, category: 'sell', itemId: 100, contact: '<script>bad</script>', content: '<img src=x onerror=bad()>', expiresAt: 2, isExpired: true }),
      entryOf({ id: 2, content: '可以增加地图筛选', createdAt: 3, author: authorOf({ displayName: '<b>小明</b>' }) }),
    ];
    const { root, restore } = mount(entries);
    try {
      await tick();
      expect(root.querySelectorAll('.guestbook-entry')).toHaveLength(2);
      expect(root.querySelector('.guestbook-entry.is-expired .guestbook-expired-stamp')?.textContent).toContain('已过期');
      expect(root.querySelector('.guestbook-entry.is-expired .guestbook-content')?.textContent).toContain('<img src=x');
      expect(root.querySelector('.guestbook-entry img:not([data-item-image]), .guestbook-entry script')).toBeNull();
      const legacy = root.querySelector<HTMLElement>('article[data-entry-id="1"]')!;
      expect(legacy.querySelector('.guestbook-contact')?.textContent).toContain('<script>bad</script>');
      expect(legacy.querySelector('.gb-badge--guest')?.textContent).toContain('游客');
      const signed = root.querySelector<HTMLElement>('article[data-entry-id="2"]')!;
      expect(signed.querySelector('.guestbook-author-name')?.textContent).toContain('<b>小明</b>');
      expect(signed.querySelector('.gb-badge--verified')?.textContent).toContain('正式用户');
      expect(signed.querySelector('.guestbook-author-name b')).toBeNull();
    } finally {
      restore();
    }
  });

  it('gates the compose form and reply boxes behind login for anonymous visitors', async () => {
    const auth = { sessionRequest: vi.fn() };
    const { root, restore } = mount([entryOf()], { auth });
    try {
      await tick();
      const form = root.querySelector<HTMLFormElement>('#guestbook-form')!;
      expect(form.hidden).toBe(true);
      const gate = root.querySelector<HTMLElement>('#guestbook-login-gate')!;
      expect(gate.hidden).toBe(false);
      expect(gate.textContent).toContain('登录后即可发布登记');
      expect(gate.querySelector('[data-open-login]')).not.toBeNull();
      expect(root.querySelector('.guestbook-reply-gate [data-open-login]')).not.toBeNull();
      form.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('submit', { bubbles: true, cancelable: true }));
      await tick();
      expect(auth.sessionRequest).not.toHaveBeenCalled();
      expect(root.querySelector('#guestbook-form-status')?.textContent).toContain('请先登录');
    } finally {
      restore();
    }
  });

  it('requires selected catalog item or Zeny for trades while suggestions need only content', async () => {
    const auth = { sessionRequest: vi.fn().mockResolvedValue({ item: entryOf({ id: 9 }) }) };
    const { dom, root, auth: session, restore } = mount([], { store: activeStore, auth });
    try {
      const form = root.querySelector<HTMLFormElement>('#guestbook-form')!;
      expect(form.hidden).toBe(false);
      expect(root.querySelector('#guestbook-login-gate')?.getAttribute('hidden')).not.toBeNull();
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(session.sessionRequest).not.toHaveBeenCalled();
      expect(root.querySelector('#guestbook-form-status')?.textContent).toContain('请选择');
      const suggestion = root.querySelector<HTMLInputElement>('input[name="category"][value="suggestion"]')!;
      suggestion.checked = true;
      suggestion.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(root.querySelector<HTMLElement>('#guestbook-trade-fields')?.hidden).toBe(true);
      expect(root.querySelector('#guestbook-contact')).toBeNull();
      root.querySelector<HTMLTextAreaElement>('#guestbook-content')!.value = '建议';
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await tick();
      expect(session.sessionRequest).toHaveBeenCalledWith('/api/v1/guestbook', 'POST', { category: 'suggestion', content: '建议' });
      expect(root.querySelector('#guestbook-form-status')?.textContent).toContain('登记已发布');
    } finally {
      restore();
    }
  });

  it('shows the badge matching the author permission level', async () => {
    const entries = [
      entryOf({ id: 1, author: authorOf({ permission_level: 0 }) }),
      entryOf({ id: 2, author: authorOf({ permission_level: 1 }) }),
      entryOf({ id: 3, author: authorOf({ permission_level: 2 }) }),
      entryOf({ id: 4, author: authorOf({ permission_level: 100 }) }),
    ];
    const { root, restore } = mount(entries);
    try {
      await tick();
      expect(root.querySelector('article[data-entry-id="1"] .gb-badge--newbie')?.textContent).toContain('萌新用户');
      expect(root.querySelector('article[data-entry-id="2"] .gb-badge--verified')?.textContent).toContain('正式用户');
      expect(root.querySelector('article[data-entry-id="3"] .gb-badge--sponsor')?.textContent).toContain('赞助用户');
      expect(root.querySelector('article[data-entry-id="4"] .gb-badge--admin')?.textContent).toContain('管理员');
    } finally {
      restore();
    }
  });

  it('lets the author edit their own entry inline and marks it as edited', async () => {
    const own = entryOf({ id: 5, content: '原文', author: authorOf() });
    const auth = { sessionRequest: vi.fn().mockResolvedValue({ item: entryOf({ id: 5, content: '改后', editedAt: 999, author: authorOf() }) }) };
    const { root, auth: session, restore } = mount([own], { store: activeStore, auth });
    try {
      await tick();
      const article = () => root.querySelector<HTMLElement>('article[data-entry-id="5"]')!;
      expect(article().querySelector('[data-gb-edit="5"]')).not.toBeNull();
      (article().querySelector<HTMLElement>('[data-gb-edit="5"]')!).click();
      const textarea = article().querySelector<HTMLTextAreaElement>('.gb-editor textarea')!;
      expect(textarea.value).toBe('原文');
      textarea.value = '改后';
      article().querySelector<HTMLButtonElement>('.gb-editor-save')!.click();
      await tick();
      await tick();
      expect(session.sessionRequest).toHaveBeenCalledWith('/api/v1/guestbook/5', 'PATCH', { content: '改后' });
      expect(article().querySelector('.guestbook-content')?.textContent).toContain('改后');
      expect(article().querySelector('.gb-edited')?.textContent).toContain('已编辑');
    } finally {
      restore();
    }
  });

  it('hides the entry edit button on other users\' entries', async () => {
    const other = entryOf({ id: 6, author: authorOf({ userId: '99999', displayName: '别人' }) });
    const { root, restore } = mount([other], { store: activeStore });
    try {
      await tick();
      expect(root.querySelector('[data-gb-edit]')).toBeNull();
      expect(root.querySelector('[data-gb-reply-edit]')).toBeNull();
    } finally {
      restore();
    }
  });

  it('posts a reply through the session API and closes the compose box afterwards', async () => {
    const other = entryOf({ id: 7, author: authorOf({ userId: '99999', displayName: '别人' }) });
    const created = replyOf({ id: 11, entryId: 7, content: '回复内容' });
    const auth = { sessionRequest: vi.fn().mockResolvedValue({ item: created }) };
    const { root, auth: session, restore } = mount([other], { store: activeStore, auth });
    try {
      await tick();
      const compose = root.querySelector<HTMLElement>('[data-reply-compose="7"]')!;
      expect(compose).not.toBeNull();
      compose.querySelector<HTMLTextAreaElement>('textarea')!.value = '回复内容';
      compose.querySelector<HTMLButtonElement>('[data-gb-reply-submit]')!.click();
      await tick();
      await tick();
      expect(session.sessionRequest).toHaveBeenCalledWith('/api/v1/guestbook/7/replies', 'POST', { content: '回复内容' });
      const article = root.querySelector<HTMLElement>('article[data-entry-id="7"]')!;
      expect(article.querySelector('[data-reply-id="11"] .guestbook-reply-content')?.textContent).toContain('回复内容');
      expect(article.querySelector('.guestbook-reply-gate.is-done')).not.toBeNull();
      expect(article.querySelector('[data-reply-compose]')).toBeNull();
    } finally {
      restore();
    }
  });

  it('shows the done gate instead of compose when the user already replied, and edits that reply inline', async () => {
    const own = replyOf({ id: 11, entryId: 8, content: '我的回复' });
    const entry = entryOf({ id: 8, author: authorOf({ userId: '99999', displayName: '别人' }), replies: [own] });
    const auth = { sessionRequest: vi.fn().mockResolvedValue({ item: { id: 11, content: '改后的回复', editedAt: 999 } }) };
    const { root, auth: session, restore } = mount([entry], { store: activeStore, auth });
    try {
      await tick();
      const article = () => root.querySelector<HTMLElement>('article[data-entry-id="8"]')!;
      expect(article().querySelector('.guestbook-reply-gate.is-done')).not.toBeNull();
      expect(article().querySelector('[data-reply-compose]')).toBeNull();
      (article().querySelector<HTMLElement>('[data-gb-reply-edit="11"]')!).click();
      const textarea = article().querySelector<HTMLTextAreaElement>('.gb-editor textarea')!;
      expect(textarea.value).toBe('我的回复');
      textarea.value = '改后的回复';
      article().querySelector<HTMLButtonElement>('.gb-editor-save')!.click();
      await tick();
      await tick();
      expect(session.sessionRequest).toHaveBeenCalledWith('/api/v1/guestbook/replies/11', 'PATCH', { content: '改后的回复' });
      expect(article().querySelector('[data-reply-id="11"] .guestbook-reply-content')?.textContent).toContain('改后的回复');
      expect(article().querySelector('[data-reply-id="11"] .gb-edited')?.textContent).toContain('已编辑');
    } finally {
      restore();
    }
  });

  it('uses the same guestbook navigation in the current route', () => {
    const { dom, restore } = mount([]);
    try {
      expect(dom.window.document.querySelector('.site-nav a[aria-current="page"]')?.getAttribute('href')).toBe('/guestbook');
    } finally {
      restore();
    }
  });

  it('offers Zeny as the first item choice without a separate checkbox', async () => {
    const { dom, root, restore } = mount([], { store: activeStore });
    try {
      const query = root.querySelector<HTMLInputElement>('#guestbook-item-query')!;
      expect(root.querySelector('#guestbook-zeny')).toBeNull();
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await tick();
      expect(root.querySelector('#guestbook-item-suggestions [data-zeny]')?.textContent ?? '').toContain('Zeny');
    } finally {
      restore();
    }
  });

  it('keeps keyboard selection aligned with the Zeny-first list', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/catalog/items.json')) return new Response(JSON.stringify({ items: [{ itemId: 601, name: '苍蝇翅膀', aliases: [] }] }), { status: 200 });
      return new Response(JSON.stringify({ descriptions: [] }), { status: 200 });
    }));
    const api = apiReturning([]);
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any, { store: activeStore as any, auth: { sessionRequest: vi.fn() } as any });
      const query = root.querySelector<HTMLInputElement>('#guestbook-item-query')!;
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await tick();
      const options = () => [...root.querySelectorAll<HTMLButtonElement>('#guestbook-item-suggestions [role="option"]')];
      expect(options().map((option) => option.textContent?.trim())).toEqual(['Zeny 游戏币 特殊交易项']);

      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(query.value).toBe('Zeny 游戏币');

      query.value = '苍蝇';
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await tick();
      expect(options().map((option) => option.textContent?.trim())).toEqual(['Zeny 游戏币 特殊交易项', '苍蝇翅膀']);
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(query.value).toBe('苍蝇翅膀');
    } finally {
      vi.stubGlobal('fetch', previousFetch);
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
    const api = apiReturning([entryOf({ id: 7, category: 'buy', itemId: 601, contact: 'QQ', content: '收购一组' })]);
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any, { store: anonymousStore as any, auth: { sessionRequest: vi.fn() } as any });
      await tick();
      expect(root.querySelector('.guestbook-item-name')?.textContent).toBe('苍蝇翅膀');
      expect(root.querySelector('.guestbook-item-description')?.textContent).toContain('可以瞬间移动');
      expect(root.querySelector('.guestbook-item-name')?.textContent).not.toContain('#601');
    } finally {
      vi.stubGlobal('fetch', previousFetch);
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });

  it('fills the selected-item preview card where the contact field used to be', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/guestbook' });
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/catalog/items.json')) return new Response(JSON.stringify({ items: [{ itemId: 601, name: '苍蝇翅膀', aliases: [] }] }), { status: 200 });
      return new Response(JSON.stringify({ descriptions: [] }), { status: 200 });
    }));
    const api = apiReturning([]);
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountGuestbookPage(root, api as any, { store: activeStore as any, auth: { sessionRequest: vi.fn() } as any });
      const preview = root.querySelector<HTMLElement>('#guestbook-item-preview')!;
      expect(preview.textContent).toContain('尚未选择道具');
      const query = root.querySelector<HTMLInputElement>('#guestbook-item-query')!;
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await tick();
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(preview.textContent).toContain('Zeny 游戏币');
      query.value = '苍蝇';
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await tick();
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      query.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(preview.querySelector('[data-preview-card] strong')?.textContent).toBe('苍蝇翅膀');
      expect(preview.querySelector('[data-preview-card] img[data-item-image]')).not.toBeNull();
    } finally {
      vi.stubGlobal('fetch', previousFetch);
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });
  describe('管理员删除', () => {
    const withReplies = () => entryOf({
      id: 1, content: '违规留言', author: authorOf({ userId: '10003', displayName: '路人' }),
      replies: [replyOf({ id: 11, entryId: 1, content: '回复甲' }), replyOf({ id: 12, entryId: 1, content: '回复乙', author: authorOf({ userId: '10004', displayName: '路人乙' }) })],
      replyCount: 2,
    });
    const confirmWith = (dom: JSDOM, answer: boolean) => {
      const confirm = vi.fn().mockReturnValue(answer);
      Object.defineProperty(dom.window, 'confirm', { configurable: true, value: confirm });
      return confirm;
    };

    it('只有管理员能看到留言与回复上的删除按钮', async () => {
      const normal = mount([withReplies()], { store: activeStore });
      try {
        await tick();
        expect(normal.root.querySelector('[data-gb-admin-delete-entry], [data-gb-admin-delete-reply]')).toBeNull();
      } finally {
        normal.restore();
      }
      const admin = mount([withReplies()], { store: adminStore });
      try {
        await tick();
        expect(admin.root.querySelectorAll('[data-gb-admin-delete-entry]')).toHaveLength(1);
        expect(admin.root.querySelectorAll('[data-gb-admin-delete-reply]')).toHaveLength(2);
      } finally {
        admin.restore();
      }
    });

    it('删除留言：二次确认（提示会连带删除回复）后调用后台接口，并从列表移除', async () => {
      const auth = { sessionRequest: vi.fn().mockResolvedValue({ deleted_replies: 2 }) };
      const { dom, root, restore } = mount([withReplies(), entryOf({ id: 2, content: '另一条' })], { store: adminStore, auth });
      try {
        await tick();
        const confirm = confirmWith(dom, true);
        root.querySelector<HTMLButtonElement>('[data-gb-admin-delete-entry="1"]')!.click();
        await tick();
        expect(confirm.mock.calls[0]![0]).toContain('2 条回复');
        expect(auth.sessionRequest).toHaveBeenCalledWith('/api/v1/admin/guestbook/entries/1', 'DELETE');
        expect(root.querySelector('article[data-entry-id="1"]')).toBeNull();
        expect(root.querySelector('article[data-entry-id="2"]')).not.toBeNull();
      } finally {
        restore();
      }
    });

    it('删除回复：只移除这一条回复，留言保留', async () => {
      const auth = { sessionRequest: vi.fn().mockResolvedValue({ ok: true }) };
      const { dom, root, restore } = mount([withReplies()], { store: adminStore, auth });
      try {
        await tick();
        confirmWith(dom, true);
        root.querySelector<HTMLButtonElement>('[data-gb-admin-delete-reply]')!.click();
        await tick();
        expect(auth.sessionRequest).toHaveBeenCalledWith('/api/v1/admin/guestbook/replies/11', 'DELETE');
        expect(root.querySelector('[data-reply-id="11"]')).toBeNull();
        expect(root.querySelector('[data-reply-id="12"]')).not.toBeNull();
        expect(root.querySelector('article[data-entry-id="1"]')).not.toBeNull();
      } finally {
        restore();
      }
    });

    it('取消确认不发请求；接口失败时内容保留', async () => {
      const auth = { sessionRequest: vi.fn().mockRejectedValue(new Error('boom')) };
      const { dom, root, restore } = mount([withReplies()], { store: adminStore, auth });
      try {
        await tick();
        confirmWith(dom, false);
        root.querySelector<HTMLButtonElement>('[data-gb-admin-delete-entry="1"]')!.click();
        await tick();
        expect(auth.sessionRequest).not.toHaveBeenCalled();
        confirmWith(dom, true);
        root.querySelector<HTMLButtonElement>('[data-gb-admin-delete-entry="1"]')!.click();
        await tick();
        expect(root.querySelector('article[data-entry-id="1"]')).not.toBeNull();
      } finally {
        restore();
      }
    });
  });
});
