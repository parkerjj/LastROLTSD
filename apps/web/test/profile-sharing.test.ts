import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { mountKePage } from '../src/ke-page';

const character = { aid: 1, cid: 2, nid: 3, char_name: '角色', job_id: 176, map_name: null, last_seen_at: 0 };
const shared = { id: 44, share_code: 'ABC-1234', status: 'PUBLISHED', updated_at: 1, description: '已有说明' };
const profile = { id: 9, name: '方案', is_active: false, config_text: '', mon_control: null, pickupitems: null, items_control: null, timeouts: null, sharing: shared };
const ok = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setup(
  sharing: typeof shared | null = null,
  href = 'http://localhost/ke',
  responder?: (path: string, init?: RequestInit) => Promise<Response>,
) {
  const dom = new JSDOM('<div id="app"></div>', { url: href });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', vi.fn(responder ?? (async (path: string, init?: RequestInit) => {
    if (path === '/ke/options.json') return ok({ jobs: { '176': 'Champion' }, jobs_zh: { '176': '武术宗师' }, skills: [], statuses: [], monsters: [], items: [], maps: [], timeouts: [{ key: 'ai_attack', value: '1', desc: '', range: '' }] });
    if (path === '/api/v1/ke/characters') return ok({ characters: [character] });
    if (path === '/api/v1/ke/profiles?aid=1&cid=2&nid=3') return ok({ profiles: [{ id: 9, name: '方案', is_active: false, sharing }] });
    if (path === '/api/v1/ke/profiles/9') return ok({ ...profile, sharing });
    if (path === '/api/v1/ke/profiles/9' && init?.method === 'PUT') return ok(null, 204);
    return ok({});
  })));
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  mountKePage(root);
  await tick();
  root.querySelector<HTMLButtonElement>('.ke-profile-actions button')?.click();
  await tick();
  return { dom, root };
}

afterEach(() => vi.unstubAllGlobals());

const enableSharing = (dom: JSDOM, root: HTMLElement) => {
  const checkbox = root.querySelector<HTMLInputElement>('#ke-share-enabled')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

it('opens unchecked unless the profile is currently published', async () => {
  const first = await setup();
  expect(first.root.querySelector<HTMLInputElement>('#ke-share-enabled')?.checked).toBe(false);
  expect(first.root.querySelector('[data-share-label]')?.textContent).toContain('同时将此配置共享给他人');
  const withdrawn = await setup({ ...shared, status: 'WITHDRAWN' });
  expect(withdrawn.root.querySelector<HTMLInputElement>('#ke-share-enabled')?.checked).toBe(false);
  const second = await setup(shared);
  expect(second.root.querySelector<HTMLInputElement>('#ke-share-enabled')?.checked).toBe(true);
  expect(second.root.querySelector('[data-share-label]')?.textContent).toContain('同时更新共享的配置');
  expect(second.root.querySelector<HTMLTextAreaElement>('#ke-share-description')?.value).toBe('已有说明');
});

it('unchecked save preserves old share and sends enabled false', async () => {
  const { dom, root } = await setup(shared);
  const checkbox = root.querySelector<HTMLInputElement>('#ke-share-enabled')!;
  checkbox.checked = false;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();
  const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
  expect(JSON.parse(String(call[1]?.body)).sharing).toEqual({ enabled: false, description: '已有说明' });
  expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/v1/ke/profiles/9/sharing')).toBe(false);
});

it('withdrawing unchecks sharing so the next save does not republish', async () => {
  const { dom, root } = await setup(shared);
  vi.spyOn(dom.window, 'confirm').mockReturnValue(true);
  root.querySelector<HTMLButtonElement>('[data-share-withdraw]')!.click();
  await tick();
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) => path === '/api/v1/ke/profiles/9/sharing' && init?.method === 'DELETE')).toBe(true);
  expect(root.querySelector<HTMLInputElement>('#ke-share-enabled')?.checked).toBe(false);
  expect(root.querySelector<HTMLElement>('.ke-share-description')?.hidden).toBe(true);
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();
  const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
  expect(JSON.parse(String(call[1]?.body)).sharing).toEqual({ enabled: false, description: '已有说明' });
});

it('empty description can be published and editor locator selects requested profile', async () => {
  const { dom, root } = await setup(null, 'http://localhost/ke?aid=1&cid=2&nid=3&profile=9');
  expect(root.querySelector<HTMLElement>('#ke-editor')?.hidden).toBe(false);
  enableSharing(dom, root);
  root.querySelector<HTMLTextAreaElement>('#ke-share-description')!.value = '';
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();
  const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
  expect(JSON.parse(String(call[1]?.body)).sharing).toEqual({ enabled: true, description: '' });
});

it('shows the new share code and hall link in the profile list after saving', async () => {
  let saved = false;
  const responder = async (path: string, init?: RequestInit) => {
    if (path === '/ke/options.json') return ok({ jobs: { '176': 'Champion' }, jobs_zh: { '176': '武术宗师' }, skills: [], statuses: [], monsters: [], items: [], maps: [], timeouts: [{ key: 'ai_attack', value: '1', desc: '', range: '' }] });
    if (path === '/api/v1/ke/characters') return ok({ characters: [character] });
    if (path === '/api/v1/ke/profiles?aid=1&cid=2&nid=3') return ok({ profiles: saved ? [{ id: 10, name: '新方案', is_active: false, sharing: { ...shared, description: '' } }] : [] });
    if (path === '/api/v1/ke/profiles' && init?.method === 'POST') { saved = true; return ok({ id: 10 }, 201); }
    return ok({});
  };
  const { dom, root } = await setup(null, 'http://localhost/ke', responder);
  root.querySelector<HTMLButtonElement>('.ke-empty button')!.click();
  await tick();
  const name = root.querySelector<HTMLInputElement>('#ke-profile-name')!;
  name.value = '新方案';
  name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  enableSharing(dom, root);
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();
  const row = root.querySelector<HTMLElement>('.ke-profile-card');
  expect(row?.textContent).toContain('ABC-1234');
  expect(row?.querySelector<HTMLAnchorElement>('a[href="/ke/hall?code=ABC-1234"]')).not.toBeNull();
});

it('local demo save stays in memory and never sends a KE write request', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/ke?demo=1' });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/ke/options.json') return ok({ jobs: {}, jobs_zh: {}, skills: [], statuses: [], monsters: [], items: [], maps: [], timeouts: [{ key: 'ai_attack', value: '1', desc: '攻击间隔', range: '0-10' }] });
    return ok({});
  }));
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  mountKePage(root);
  await tick();

  expect(root.querySelector<HTMLElement>('#ke-demo-chip')?.hidden).toBe(false);
  const name = root.querySelector<HTMLInputElement>('#ke-profile-name')!;
  name.value = '猎场安全配置';
  name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  enableSharing(dom, root);
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();

  const writes = vi.mocked(fetch).mock.calls.filter(([path, init]) =>
    String(path).startsWith('/api/v1/ke/') && ['POST', 'PUT', 'DELETE'].includes(init?.method ?? ''),
  );
  expect(writes).toHaveLength(0);
  expect(root.textContent).toContain('猎场安全配置');
  expect(root.textContent).toContain('仅在演示中');

  let card = root.querySelector<HTMLElement>('.ke-profile-card')!;
  expect(card.textContent).toContain('DEM-0001');
  card.querySelector<HTMLButtonElement>('.ke-btn-live')!.click();
  await tick();
  expect(root.textContent).toContain('已在演示中模拟激活');

  vi.spyOn(dom.window, 'confirm').mockReturnValue(true);
  card = root.querySelector<HTMLElement>('.ke-profile-card')!;
  card.querySelector<HTMLButtonElement>('.ke-profile-actions .ke-btn-ghost')!.click();
  await tick();
  root.querySelector<HTMLButtonElement>('[data-share-withdraw]')!.click();
  await tick();
  expect(root.querySelector('[data-share-hint]')?.textContent).toContain('演示中已撤回');
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();
  card = root.querySelector<HTMLElement>('.ke-profile-card')!;
  expect(card.textContent).toContain('DEM-0001');
  card.querySelector<HTMLButtonElement>('.ke-btn-danger')!.click();
  await tick();

  expect(root.querySelectorAll('.ke-profile-card')).toHaveLength(0);
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) =>
    String(path).startsWith('/api/v1/ke/') && ['POST', 'PUT', 'DELETE'].includes(init?.method ?? ''),
  )).toBe(false);
});
