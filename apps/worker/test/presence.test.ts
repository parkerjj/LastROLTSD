import { describe, expect, it, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerPresenceRoute } from '../src/routes/presence';

function createApp(): Hono {
  const app = new Hono();
  registerPresenceRoute(app);
  return app;
}

function postPresence(body: unknown, headers: Record<string, string> = {}) {
  return createApp().request('/lastro/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const PAGE_HTML = '<html><form><input name="_csrf" type="hidden" id="_csrf" value="page-token-123" /></form></html>';

function pageResponse(init?: { ok?: boolean; html?: string; cookie?: string | null }): Response {
  const headers = new Headers({ 'content-type': 'text/html; charset=UTF-8' });
  if (init?.cookie !== null) headers.set('set-cookie', `${init?.cookie ?? '_csrf=cookie-token-abc'}; Path=/; HttpOnly`);
  return new Response(init?.html ?? PAGE_HTML, { status: init?.ok === false ? 503 : 200, headers });
}

function mockUpstream(postInit?: { ok?: boolean; page?: { ok?: boolean; html?: string; cookie?: string | null } }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('r=pc/index')) return pageResponse(postInit?.page);
    return new Response('1', { status: postInit?.ok === false ? 500 : 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('presence route', () => {
  it('answers the CORS preflight for * only', async () => {
    const response = await createApp().request('/lastro/presence', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
  });

  it('fetches the csrf page then posts the login form for checkin nid=5', async () => {
    const fetchMock = mockUpstream();
    const response = await postPresence({ action: 'checkin', nid: 5, userid: 'testbot1', user_pass: '123456' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: 'checkin', nid: 5 });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [pageUrl, pageInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(pageUrl).toBe('https://game.lastro.cn/?r=pc/index&nid=5');
    expect((pageInit.method ?? 'GET')).toBe('GET');

    const [postUrl, postInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postUrl).toBe('https://game.lastro.cn/?r=mg/checkin&nid=5');
    expect(postInit.method).toBe('POST');
    expect(postInit.body).toBe('_csrf=page-token-123&Login_debug%5Buserid%5D=testbot1&Login_debug%5Buser_pass%5D=123456');
    expect(postHeaders['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(postHeaders.cookie).toContain('_csrf=cookie-token-abc');
    expect(postHeaders.origin).toBe('https://game.lastro.cn');
    expect(postHeaders.referer).toBe('https://game.lastro.cn/ro/api.html?71.86');
    expect(postHeaders['x-requested-with']).toBe('XMLHttpRequest');
    expect(postHeaders['user-agent']).toMatch(/^Mozilla\//);
    expect(postHeaders['accept-language']).toBeTruthy();
  });

  it('maps nid 3/4 to Login_cn2/Login_ts and uses mg/check for check', async () => {
    let fetchMock = mockUpstream();
    await postPresence({ action: 'check', nid: 3, userid: 'u', user_pass: 'p' });
    let [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://game.lastro.cn/?r=mg/check&nid=3');
    expect(init.body).toContain('Login_cn2%5Buserid%5D=u');

    fetchMock = mockUpstream();
    await postPresence({ action: 'checkin', nid: 4, userid: 'u', user_pass: 'p' });
    [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://game.lastro.cn/?r=mg/checkin&nid=4');
    expect(init.body).toContain('Login_ts%5Buser_pass%5D=p');

    fetchMock = mockUpstream();
    expect((await postPresence({ action: 'check', nid: '5', userid: 'u', user_pass: 'p' })).status).toBe(200);
    [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://game.lastro.cn/?r=pc/index&nid=5');
  });

  it('rejects invalid requests without calling upstream', async () => {
    const fetchMock = mockUpstream();
    expect(await (await postPresence({ action: 'login', nid: 5, userid: 'u', user_pass: 'p' })).json()).toMatchObject({ ok: false, error: 'unsupported_action' });
    expect(await (await postPresence({ action: 'check', nid: 6, userid: 'u', user_pass: 'p' })).json()).toMatchObject({ ok: false, error: 'unsupported_nid' });
    expect(await (await postPresence({ action: 'check', nid: 5, userid: '', user_pass: 'p' })).json()).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await (await postPresence({ action: 'check', nid: 5, userid: 'u', user_pass: 1 })).json()).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await (await postPresence('not-an-object')).json()).toMatchObject({ ok: false, error: 'invalid_request' });
    expect((await postPresence('{')).status).toBe(400);
    const oversized = { action: 'check', nid: 5, userid: 'u', user_pass: 'p', pad: 'x'.repeat(5 * 1024) };
    expect((await postPresence(oversized)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns csrf_fetch_failed when the page has no token', async () => {
    mockUpstream({ page: { html: '<html>no token here</html>' } });
    const response = await postPresence({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: 'csrf_fetch_failed' });
  });

  it('returns csrf_fetch_failed when the page request fails', async () => {
    mockUpstream({ page: { ok: false } });
    expect((await postPresence({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' })).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const response = await postPresence({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: 'csrf_fetch_failed' });
  });

  it('returns upstream_request_failed when the form post fails', async () => {
    mockUpstream({ ok: false });
    const response = await postPresence({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: 'upstream_request_failed' });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns upstream_timeout when an upstream call times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('r=pc/index')) return pageResponse();
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }));
    let response = await postPresence({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ ok: false, error: 'upstream_timeout' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')));
    response = await postPresence({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ ok: false, error: 'upstream_timeout' });
  });

  it('is registered without a database', async () => {
    const { createApp: createWorkerApp } = await import('../src/index');
    mockUpstream();
    const app = createWorkerApp({} as never);
    const response = await app.request('/lastro/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'checkin', nid: 5, userid: 'u', user_pass: 'p' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: 'checkin', nid: 5 });
  });
});
