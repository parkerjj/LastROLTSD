import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { mountProfileHall } from '../src/profile-hall-page';
import type { AuthStoreState } from '../src/auth/store';

const item = {
  id: 7, title: '<img src=x onerror=alert(1)>', description: '打波利', job_id: 176,
  author: { id: 'author', display_name: '<script>alert(1)</script>' }, share_code: 'ABC-1234',
  like_count: 2, use_count: 3, liked_by_me: false, used_by_me: false, is_mine: false,
  created_at: 1000, updated_at: 2000,
};
const detail = { ...item, config_text: '<script>alert(2)</script>', mon_control: null, pickupitems: '', items_control: null, timeouts: null };

function setup(initial: AuthStoreState, responder: (path: string, init?: RequestInit) => Promise<Response>) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/ke/hall' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', vi.fn(responder));
  let state = initial;
  const listeners = new Set<(state: Readonly<AuthStoreState>) => void>();
  const store = {
    getState: () => state,
    subscribe: (listener: (state: Readonly<AuthStoreState>) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    bootstrap: async () => undefined,
  };
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const dispose = mountProfileHall(root, store);
  return { dom, root, dispose, setState(next: AuthStoreState) { state = next; listeners.forEach((listener) => listener(state)); } };
}

const active = { status: 'active' as const, user: { id: 'viewer', display_name: '玩家' }, expiresAt: Date.now() + 100000, mailAvailability: null } as AuthStoreState;
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.unstubAllGlobals());

it('anonymous view does not fetch shared data and login reveals it', async () => {
  const page = setup({ status: 'anonymous' }, async () => ok({ items: [item], page: 1, page_size: 20, total: 1 }));
  await tick();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(page.root.textContent).toContain('登录');
  page.setState(active);
  await tick();
  expect(page.root.textContent).toContain('打波利');
  page.dispose();
});

it('demo query on a public host still requires the real session', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.com/ke/hall?demo=1' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', vi.fn(async () => ok({ items: [item], page: 1, page_size: 20, total: 1 })));
  const store = {
    getState: () => ({ status: 'anonymous' }) as AuthStoreState,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
  };
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const dispose = mountProfileHall(root, store);
  await tick();

  expect(root.textContent).toContain('登录账号');
  expect(root.querySelectorAll('.hall-item')).toHaveLength(0);
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/shared-profiles'))).toBe(false);
  dispose();
});

it('renders user text literally, filters with page reset, and normalizes code lookup', async () => {
  const page = setup(active, async (path) => {
    if (path.includes('/code/') || path.endsWith('/7')) return ok(detail);
    if (path === '/ke/options.json') return ok({ jobs_zh: { '176': '武术宗师' }, jobs: { '176': 'Champion' } });
    return ok({ items: [item], page: 1, page_size: 20, total: 1 });
  });
  await tick();
  expect(page.root.querySelector('img[onerror], script')).toBeNull();
  page.root.querySelector<HTMLButtonElement>('[data-detail="7"]')!.click();
  await tick();
  expect(page.root.querySelector('script')).toBeNull();
  expect(page.root.textContent).toContain('<script>alert(2)</script>');
  const code = page.root.querySelector<HTMLInputElement>('[data-code-input]')!;
  code.value = 'abc1234';
  page.root.querySelector<HTMLButtonElement>('[data-code-find]')!.click();
  await tick();
  expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/v1/ke/shared-profiles/code/ABC-1234')).toBe(true);
  page.dispose();
});

it('copy retries with one UUID and accepts a different job target', async () => {
  let failures = 1;
  const page = setup(active, async (path, init) => {
    if (path === '/ke/options.json') return ok({ jobs_zh: {}, jobs: {} });
    if (path === '/api/v1/ke/characters') return ok({ characters: [{ aid: 8, cid: 9, nid: 10, char_name: '弓箭手', job_id: 2 }] });
    if (path.endsWith('/copy')) {
      if (failures--) throw new Error('offline');
      return ok({ profile_id: 88, name: '副本', use_count: 4, duplicate: false });
    }
    return ok({ items: [item], page: 1, page_size: 20, total: 1 });
  });
  await tick();
  page.root.querySelector<HTMLButtonElement>('[data-copy="7"]')!.click();
  await tick();
  page.root.querySelector<HTMLButtonElement>('[data-copy-confirm]')!.click();
  await tick();
  page.root.querySelector<HTMLButtonElement>('[data-copy-retry]')!.click();
  await tick();
  const calls = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/copy'));
  expect(calls).toHaveLength(2);
  const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0]).toEqual({ aid: 8, cid: 9, nid: 10, request_id: bodies[0].request_id });
  expect(bodies[1]).toEqual(bodies[0]);
  expect(page.root.querySelector<HTMLAnchorElement>('[data-open-copy]')?.getAttribute('href')).toBe('/ke?aid=8&cid=9&nid=10&profile=88');
  page.dispose();
});

it('shows update times and lets an author withdraw from the hall detail', async () => {
  const ownItem = { ...item, is_mine: true, updated_at: 2000 };
  const ownDetail = { ...detail, is_mine: true, updated_at: 2000 };
  let withdrawn = false;
  const page = setup(active, async (path, init) => {
    if (path === '/ke/options.json') return ok({ jobs_zh: { '176': '武术宗师' }, jobs: {} });
    if (path.startsWith('/ui/')) return ok({});
    if (path === '/api/v1/ke/shared-profiles?sort=newest&page=1')
      return ok({ items: withdrawn ? [] : [ownItem], page: 1, page_size: 20, total: withdrawn ? 0 : 1 });
    if (path === '/api/v1/ke/shared-profiles/7/withdraw' && init?.method === 'DELETE') {
      withdrawn = true;
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v1/ke/shared-profiles/7') return ok(ownDetail);
    return ok({});
  });
  vi.spyOn(page.dom.window, 'confirm').mockReturnValue(true);
  await tick();
  expect(page.root.textContent).toContain('更新时间');
  expect(page.root.querySelector('[data-manage]')).not.toBeNull();
  page.root.querySelector<HTMLButtonElement>('[data-detail="7"]')!.click();
  await tick();
  expect(page.root.textContent).toContain('更新时间');
  expect(page.root.querySelector('[data-withdraw]')).not.toBeNull();
  page.root.querySelector<HTMLButtonElement>('[data-withdraw]')!.click();
  await tick();
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) => path === '/api/v1/ke/shared-profiles/7/withdraw' && init?.method === 'DELETE')).toBe(true);
  expect(page.root.textContent).toContain('已撤回');
  expect(page.root.querySelector('[data-detail="7"]')).toBeNull();
  page.dispose();
});

it('local demo hall supports browsing, reversible likes, and a simulated copy without API writes', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://127.0.0.1:5173/ke/hall?demo=1' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/ke/options.json'
    ? ok({ jobs_zh: { '9': '巫师', '14': '十字军' }, jobs: {
      '1': 'Swordsman', '2': 'Mage', '7': 'Knight', '9': 'Wizard', '13': 'Peco Knight',
      '14': 'Crusader', '162': 'High Swordsman', '168': 'Lord Knight', '4002': 'High Swordsman',
      '4008': 'Lord Knight', '4054': 'Rune Knight', '4080': 'Rune Knight', '4252': 'Dragon Knight',
    } })
    : ok({})));
  const store = {
    getState: () => ({ status: 'anonymous' }) as AuthStoreState,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
  };
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const dispose = mountProfileHall(root, store);
  await tick();

  expect(root.querySelectorAll('.hall-item').length).toBeGreaterThan(0);
  const jobFilter = root.querySelector<HTMLSelectElement>('[data-job]')!;
  expect([...jobFilter.options].map((option) => option.value)).toEqual(['', 'knight', 'crusader', 'wizard', 'sage']);
  jobFilter.value = 'wizard';
  jobFilter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick();
  expect(root.querySelectorAll('.hall-item')).toHaveLength(1);
  expect(root.querySelector('.hall-item')?.textContent).toContain('巫师 · 火墙练级与补给');
  jobFilter.value = '';
  jobFilter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick();

  const codeInput = root.querySelector<HTMLInputElement>('[data-code-input]')!;
  codeInput.value = 'wiz1732';
  root.querySelector<HTMLButtonElement>('[data-code-find]')!.click();
  await tick();
  expect(root.querySelector('.hall-detail h2')?.textContent).toBe('巫师 · 火墙练级与补给');

  const firstRow = root.querySelector<HTMLElement>('.hall-item')!;
  const like = firstRow.querySelector<HTMLButtonElement>('[data-like]')!;
  like.click();
  await tick();
  expect(root.querySelector<HTMLElement>('.hall-item')?.querySelector('[data-like]')?.textContent).toBe('取消赞');
  root.querySelector<HTMLElement>('.hall-item')?.querySelector<HTMLButtonElement>('[data-like]')?.click();
  await tick();
  expect(root.querySelector<HTMLElement>('.hall-item')?.querySelector('[data-like]')?.textContent).toBe('点赞');

  const item = root.querySelector<HTMLElement>('.hall-item')!;
  const uses = item.querySelector<HTMLElement>('[data-label="使用人数"]')!;
  const originalUses = Number(uses.textContent);
  item.querySelector<HTMLButtonElement>('[data-copy]')!.click();
  await tick();
  root.querySelector<HTMLButtonElement>('[data-copy-confirm]')!.click();
  await tick();
  expect(root.textContent).toContain('演示复制完成');
  expect(Number(root.querySelector<HTMLElement>('.hall-item [data-label="使用人数"]')?.textContent)).toBe(originalUses + 1);
  root.querySelector<HTMLButtonElement>('[data-close-copy]')!.click();
  root.querySelector<HTMLElement>('.hall-item')?.querySelector<HTMLButtonElement>('[data-copy]')?.click();
  await tick();
  root.querySelector<HTMLButtonElement>('[data-copy-confirm]')!.click();
  await tick();
  expect(Number(root.querySelector<HTMLElement>('.hall-item [data-label="使用人数"]')?.textContent)).toBe(originalUses + 1);
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) => String(path).startsWith('/api/v1/ke/') && ['POST', 'PUT', 'DELETE'].includes(init?.method ?? ''))).toBe(false);
  dispose();
});
