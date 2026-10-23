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

it('opens checked for new and published sharing with the appropriate wording', async () => {
  const first = await setup();
  expect(first.root.querySelector<HTMLInputElement>('#ke-share-enabled')?.checked).toBe(true);
  expect(first.root.querySelector('[data-share-label]')?.textContent).toContain('同时将此配置共享给他人');
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

it('empty description can be published and editor locator selects requested profile', async () => {
  const { root } = await setup(null, 'http://localhost/ke?aid=1&cid=2&nid=3&profile=9');
  expect(root.querySelector<HTMLElement>('#ke-editor')?.hidden).toBe(false);
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
  root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
  await tick();
  const row = root.querySelector<HTMLElement>('.ke-profile-card');
  expect(row?.textContent).toContain('ABC-1234');
  expect(row?.querySelector<HTMLAnchorElement>('a[href="/ke/hall?code=ABC-1234"]')).not.toBeNull();
});
