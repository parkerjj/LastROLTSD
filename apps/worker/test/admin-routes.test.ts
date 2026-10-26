import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerAdminAccountRoutes, type AdminAuthServices } from '../src/admin/router';
import type { AdminService } from '../src/admin/service';
import type { TransferService } from '../src/admin/transfer-service';
import { AdminFailure } from '../src/admin/types';
import { AuthFailure } from '../src/auth/types';

interface Call { method: string; args: unknown[] }

function setup(options: { signedIn?: boolean; admin?: boolean; csrfOk?: boolean; adjustError?: Error } = {}) {
  const { signedIn = true, admin = true, csrfOk = true, adjustError } = options;
  const calls: Call[] = [];
  const record = <T>(method: string, result: T) => async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    return result;
  };
  const service = {
    assertAdmin: async (userId: number) => {
      calls.push({ method: 'assertAdmin', args: [userId] });
      if (!admin) throw new AdminFailure('ADMIN_NOT_FOUND', 404, 'Not found');
    },
    searchUsers: record('searchUsers', [{ id: 2 }]),
    getUser: record('getUser', { user: { id: 2 }, effective: { slots: 1, modules: ['core'] }, entitlements: [] }),
    adjustEntitlement: adjustError ? async () => { throw adjustError; } : record('adjustEntitlement', { id: 7 }),
    editEntitlement: record('editEntitlement', undefined),
    deleteGuestbookEntry: record('deleteGuestbookEntry', { deleted_replies: 2 }),
    deleteGuestbookReply: record('deleteGuestbookReply', undefined),
    listAudit: record('listAudit', [{ id: 9 }]),
  } as unknown as AdminService;
  const auth: AdminAuthServices = {
    authenticate: async () => {
      calls.push({ method: 'authenticate', args: [] });
      if (!signedIn) throw new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录');
      return { userId: '1' } as never;
    },
    assertSession: async () => {
      calls.push({ method: 'assertSession', args: [] });
      if (!csrfOk) throw new AuthFailure('AUTH_CSRF_INVALID', 403, '请求来源校验失败');
    },
    setPassword: async (...args: unknown[]) => { calls.push({ method: 'setPassword', args }); },
  } as AdminAuthServices;
  const transfer = {
    listCharacters: record('listCharacters', { user: { id: 2 }, characters: [] }),
    preview: record('preview', { analysis: { verdict: 'NONE' }, timeline: [] }),
    confirm: record('confirm', { moved_profile_ids: [1], detached_share_ids: [] }),
  } as unknown as TransferService;
  const app = new Hono();
  registerAdminAccountRoutes(app, service, auth, transfer);
  const json = (path: string, method: string, body: unknown) => app.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const called = (method: string) => calls.filter((call) => call.method === method);
  const withoutTransfer = new Hono();
  registerAdminAccountRoutes(withoutTransfer, service, auth);
  return { app, calls, json, called, withoutTransfer };
}

describe('admin 路由 · 访问控制', () => {
  it('未登录 → 401；登录但不是管理员 → 404（写操作也一样，且不会先暴露 CSRF 结果）', async () => {
    const anonymous = setup({ signedIn: false });
    expect((await anonymous.app.request('/api/v1/admin/users')).status).toBe(401);

    const normal = setup({ admin: false, csrfOk: false });
    for (const [path, method] of [
      ['/api/v1/admin/users', 'GET'], ['/api/v1/admin/users/2', 'GET'], ['/api/v1/admin/audit', 'GET'],
      ['/api/v1/admin/users/2/entitlements', 'POST'], ['/api/v1/admin/entitlements/1', 'PATCH'],
      ['/api/v1/admin/users/2/password', 'POST'], ['/api/v1/admin/guestbook/entries/1', 'DELETE'], ['/api/v1/admin/guestbook/replies/1', 'DELETE'],
      ['/api/v1/admin/transfer/characters?account=2', 'GET'], ['/api/v1/admin/transfer/preview?source=2&target=3&aid=1&cid=1&nid=1', 'GET'],
      ['/api/v1/admin/transfer', 'POST'],
    ] as const) {
      const response = await normal.app.request(path, method === 'GET' || method === 'DELETE'
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(normal.called('assertSession')).toHaveLength(0);
    expect(normal.called('adjustEntitlement')).toHaveLength(0);
  });

  it('写操作要求会话 CSRF；读操作不需要', async () => {
    const blocked = setup({ csrfOk: false });
    const response = await blocked.json('/api/v1/admin/users/2/entitlements', 'POST', { resource: 'slots', delta: 1, permanent: true });
    expect(response.status).toBe(403);
    expect(blocked.called('adjustEntitlement')).toHaveLength(0);
    expect((await blocked.app.request('/api/v1/admin/users')).status).toBe(200);
    expect(blocked.called('assertSession')).toHaveLength(1);
  });

  it('所有响应都带 no-store', async () => {
    const { app } = setup();
    expect((await app.request('/api/v1/admin/users')).headers.get('cache-control')).toBe('no-store');
    expect((await setup({ admin: false }).app.request('/api/v1/admin/users')).headers.get('cache-control')).toBe('no-store');
  });
});

describe('admin 路由 · 功能', () => {
  it('搜索账号 / 账号详情 / 审计列表', async () => {
    const { app, called } = setup();
    expect(await (await app.request('/api/v1/admin/users?q=alice')).json()).toEqual({ users: [{ id: 2 }] });
    expect(called('searchUsers')[0]!.args).toEqual(['alice']);
    expect(await (await app.request('/api/v1/admin/users/2')).json()).toMatchObject({ effective: { slots: 1, modules: ['core'] } });
    expect(called('getUser')[0]!.args).toEqual([2]);
    expect(await (await app.request('/api/v1/admin/audit?before=50')).json()).toEqual({ entries: [{ id: 9 }] });
    expect(called('listAudit')[0]!.args).toEqual([50]);
    expect((await app.request('/api/v1/admin/users/abc')).status).toBe(400);
    expect((await app.request('/api/v1/admin/audit?before=x')).status).toBe(400);
  });

  it('赠送 / 扣减权益：201 返回新行 id，操作者与请求号一并传给服务', async () => {
    const { json, called } = setup();
    const body = { resource: 'slots', delta: -2, duration_days: 7 };
    const response = await json('/api/v1/admin/users/2/entitlements', 'POST', body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 7 });
    const [actor, target, input, requestId] = called('adjustEntitlement')[0]!.args;
    expect([actor, target, input]).toEqual([1, 2, body]);
    expect(typeof requestId).toBe('string');
  });

  it('修改 / 撤销权益', async () => {
    const { json, called } = setup();
    const response = await json('/api/v1/admin/entitlements/5', 'PATCH', { revoked: true });
    expect(response.status).toBe(200);
    expect(called('editEntitlement')[0]!.args.slice(0, 3)).toEqual([1, 5, { revoked: true }]);
  });

  it('强制改密：只接受 new_password，交给 auth 服务；不回显密码', async () => {
    const { json, called } = setup();
    const response = await json('/api/v1/admin/users/2/password', 'POST', { new_password: 'a-new-password' });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('a-new-password');
    const args = called('setPassword')[0]!.args;
    expect(args.slice(0, 3)).toEqual(['1', '2', 'a-new-password']);
    expect((await json('/api/v1/admin/users/2/password', 'POST', {})).status).toBe(400);
    expect((await json('/api/v1/admin/users/2/password', 'POST', { new_password: 'x', extra: 1 })).status).toBe(400);
  });

  it('删除留言 / 回复', async () => {
    const { app, called } = setup();
    const entry = await app.request('/api/v1/admin/guestbook/entries/10', { method: 'DELETE' });
    expect(entry.status).toBe(200);
    expect(await entry.json()).toEqual({ deleted_replies: 2 });
    expect(called('deleteGuestbookEntry')[0]!.args.slice(0, 2)).toEqual([1, 10]);
    const reply = await app.request('/api/v1/admin/guestbook/replies/20', { method: 'DELETE' });
    expect(reply.status).toBe(200);
    expect(called('deleteGuestbookReply')[0]!.args.slice(0, 2)).toEqual([1, 20]);
    expect((await app.request('/api/v1/admin/guestbook/entries/0', { method: 'DELETE' })).status).toBe(400);
  });

  it('服务层错误按状态码与错误码原样返回', async () => {
    const { json } = setup({ adjustError: new AdminFailure('ADMIN_USER_NOT_FOUND', 404, '账号不存在') });
    const response = await json('/api/v1/admin/users/2/entitlements', 'POST', { resource: 'slots', delta: 1, permanent: true });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'ADMIN_USER_NOT_FOUND', message: '账号不存在' } });
  });

  it('未预期的错误 → 500，不泄露内部信息；请求体不是 JSON → 415', async () => {
    const broken = setup({ adjustError: new Error('connection string leaked: mysql://root:secret@host') });
    const response = await broken.json('/api/v1/admin/users/2/entitlements', 'POST', { resource: 'slots', delta: 1, permanent: true });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret');

    const { app } = setup();
    const bad = await app.request('/api/v1/admin/users/2/entitlements', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    expect(bad.status).toBe(415);
  });
});

describe('admin 路由 · 角色转移', () => {
  const body = { source: '2', target: 'b@example.test', aid: 1, cid: 2, nid: 3, note: '工单' };

  it('查询角色 / 预览：参数交给服务，aid/cid/nid 转成数字', async () => {
    const { app, called } = setup();
    expect(await (await app.request('/api/v1/admin/transfer/characters?account=a%40b.test')).json()).toEqual({ user: { id: 2 }, characters: [] });
    expect(called('listCharacters')[0]!.args).toEqual(['a@b.test']);
    const response = await app.request('/api/v1/admin/transfer/preview?source=2&target=b%40example.test&aid=4294967295&cid=0&nid=3');
    expect(response.status).toBe(200);
    expect(called('preview')[0]!.args).toEqual([{ source: '2', target: 'b@example.test', aid: 4294967295, cid: 0, nid: 3 }]);
  });

  it('确认转移：写操作要求 CSRF，操作者与请求号一并传给服务', async () => {
    const blocked = setup({ csrfOk: false });
    expect((await blocked.json('/api/v1/admin/transfer', 'POST', body)).status).toBe(403);
    expect(blocked.called('confirm')).toHaveLength(0);

    const { json, called } = setup();
    const response = await json('/api/v1/admin/transfer', 'POST', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moved_profile_ids: [1], detached_share_ids: [] });
    const [actor, input, requestId] = called('confirm')[0]!.args;
    expect([actor, input]).toEqual([1, body]);
    expect(typeof requestId).toBe('string');
  });

  it('参数无效 → 400：多余字段、aid 非整数、越界、缺字段', async () => {
    const { app, json, called } = setup();
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, extra: 1 })).status).toBe(400);
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, aid: 'abc' })).status).toBe(400);
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, aid: 4294967296 })).status).toBe(400);
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, cid: -1 })).status).toBe(400);
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, nid: 1.5 })).status).toBe(400);
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, note: undefined })).status).toBe(400);
    expect((await json('/api/v1/admin/transfer', 'POST', { ...body, target: 5 })).status).toBe(400);
    expect(called('confirm')).toHaveLength(0);
    expect((await app.request('/api/v1/admin/transfer/preview?source=2&target=3&aid=abc&cid=1&nid=1')).status).toBe(400);
    expect((await app.request('/api/v1/admin/transfer/preview?source=2&target=3&aid=1&cid=1')).status).toBe(400);
    expect((await app.request('/api/v1/admin/transfer/preview?source=2&aid=1&cid=1&nid=1')).status).toBe(400);
    expect((await app.request('/api/v1/admin/transfer/characters')).status).toBe(400);
    expect(called('preview')).toHaveLength(0);
  });

  it('未提供转移服务 → 管理员校验通过后返回 503', async () => {
    const { withoutTransfer } = setup();
    expect((await withoutTransfer.request('/api/v1/admin/transfer/characters?account=2')).status).toBe(503);
    const denied = setup({ admin: false });
    expect((await denied.withoutTransfer.request('/api/v1/admin/transfer/characters?account=2')).status).toBe(404);
  });
});

describe('admin 路由 · 接入应用', () => {
  it('账号体系未启用时后台接口返回 503（路由已注册，不会落到静态资源兜底）', async () => {
    const { createApp } = await import('../src/index');
    const database = {
      all: async () => [], first: async () => null, run: async () => ({ affectedRows: 0, insertId: 0 }),
      transaction: async (work: (db: never) => unknown) => work(database as never), healthcheck: async () => {}, close: async () => {},
    };
    const app = createApp({ ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192 }, database as never);
    const response = await app.request('/api/v1/admin/users');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'auth_unavailable' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
