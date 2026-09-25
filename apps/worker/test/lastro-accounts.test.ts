import { describe, expect, it, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerLastroAccountRoute } from '../src/routes/lastro-accounts';

function createApp(): Hono {
  const app = new Hono();
  registerLastroAccountRoute(app);
  return app;
}

function postStatus(body: unknown) {
  return createApp().request('/api/v1/lastro/account-status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockUpstream(payload: unknown, init?: { ok?: boolean }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status: init?.ok === false ? 503 : 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lastro account status route', () => {
  it('forwards credentials as form data and maps an online payload', async () => {
    const fetchMock = mockUpstream({ name: '暴力男团', base_level: 99, hp: '6850', updatetime: '202609251937' });
    const response = await postStatus({ userid: 'testbot', user_pass: 'secret' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ state: 'online', data: { name: '暴力男团', base_level: 99, hp: '6850', updatetime: '202609251937' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://game.lastro.cn/?r=mn/search&nid=5');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('Login_debug%5Buserid%5D=testbot&Login_debug%5Buser_pass%5D=secret');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('XMLHttpRequest');
  });

  it('maps upstream 1 to auth_failed and 2 to offline', async () => {
    mockUpstream('1');
    expect(await (await postStatus({ userid: 'a', user_pass: 'b' })).json()).toEqual({ state: 'auth_failed' });
    mockUpstream('2');
    expect(await (await postStatus({ userid: 'a', user_pass: 'b' })).json()).toEqual({ state: 'offline' });
  });

  it('rejects invalid input without calling upstream', async () => {
    const fetchMock = mockUpstream({});
    expect((await postStatus({ userid: '', user_pass: 'b' })).status).toBe(400);
    expect((await postStatus({ userid: 'a', user_pass: '' })).status).toBe(400);
    expect((await postStatus({ userid: 'a'.repeat(65), user_pass: 'b' })).status).toBe(400);
    expect((await postStatus('not-an-object')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-JSON bodies', async () => {
    const response = await createApp().request('/api/v1/lastro/account-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(response.status).toBe(400);
  });

  it('returns 502 when upstream fails, errors, or returns non-JSON', async () => {
    mockUpstream({}, { ok: false });
    expect((await postStatus({ userid: 'a', user_pass: 'b' })).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect((await postStatus({ userid: 'a', user_pass: 'b' })).status).toBe(502);
    mockUpstream('<html>not json');
    expect((await postStatus({ userid: 'a', user_pass: 'b' })).status).toBe(502);
    mockUpstream('[1,2,3]');
    expect((await postStatus({ userid: 'a', user_pass: 'b' })).status).toBe(502);
  });

  it('is registered without a database', async () => {
    const { createApp: createWorkerApp } = await import('../src/index');
    mockUpstream('2');
    const app = createWorkerApp({} as never);
    const response = await app.request('/api/v1/lastro/account-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userid: 'a', user_pass: 'b' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'offline' });
  });
});
