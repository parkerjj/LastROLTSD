import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerAdminAccountRoutes, type AdminAuthServices } from '../src/admin/router';
import type { AdminService } from '../src/admin/service';
import { AdminFailure } from '../src/admin/types';
import { AuthFailure } from '../src/auth/types';
import { createAppFlagsAdmin, type AppFlagsAdmin } from '../src/app-config/admin-service';
import type { MysqlDatabase } from '../src/db/mysql-client';

function routes(options: { admin?: boolean; csrfOk?: boolean; signedIn?: boolean } = {}) {
  const { admin = true, csrfOk = true, signedIn = true } = options;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    assertAdmin: async () => { if (!admin) throw new AdminFailure('ADMIN_NOT_FOUND', 404, 'Not found'); },
  } as unknown as AdminService;
  const auth = {
    authenticate: async () => { if (!signedIn) throw new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录'); return { userId: '1' } as never; },
    assertSession: async () => { if (!csrfOk) throw new AuthFailure('AUTH_CSRF_INVALID', 403, '请求来源校验失败'); },
    setPassword: async () => {},
  } as AdminAuthServices;
  const appFlags: AppFlagsAdmin = {
    list: async () => { calls.push({ method: 'list', args: [] }); return [{ key: 'ios_engine', enabled: false }]; },
    set: async (...args) => { calls.push({ method: 'set', args }); return { key: args[1], enabled: args[2] }; },
  };
  const app = new Hono();
  registerAdminAccountRoutes(app, service, auth, null, appFlags);
  const withoutFlags = new Hono();
  registerAdminAccountRoutes(withoutFlags, service, auth);
  const put = (a: Hono<any>, key: string, body: unknown) => a.request(`/api/v1/admin/app-flags/${key}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, calls, put, withoutFlags };
}

describe('admin 路由 · app 开关', () => {
  it('管理员可读列表；写入需要 CSRF，操作者与请求号传给服务', async () => {
    const { app, calls, put } = routes();
    expect(await (await app.request('/api/v1/admin/app-flags')).json()).toEqual({ flags: [{ key: 'ios_engine', enabled: false }] });
    const response = await put(app, 'ios_engine', { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: 'ios_engine', enabled: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const set = calls.find((call) => call.method === 'set')!;
    expect(set.args.slice(0, 3)).toEqual([1, 'ios_engine', true]);
    expect(typeof set.args[3]).toBe('string');
  });

  it('未登录 401；非管理员 404 且不会校验 CSRF 或写入；CSRF 失败 403', async () => {
    expect((await routes({ signedIn: false }).app.request('/api/v1/admin/app-flags')).status).toBe(401);
    const normal = routes({ admin: false, csrfOk: false });
    expect((await normal.app.request('/api/v1/admin/app-flags')).status).toBe(404);
    expect((await normal.put(normal.app, 'ios_engine', { enabled: true })).status).toBe(404);
    expect(normal.calls).toEqual([]);
    const blocked = routes({ csrfOk: false });
    expect((await blocked.put(blocked.app, 'ios_engine', { enabled: true })).status).toBe(403);
    expect(blocked.calls).toEqual([]);
  });

  it('请求体必须恰好是 {enabled: boolean}', async () => {
    const { app, calls, put } = routes();
    expect((await put(app, 'ios_engine', { enabled: 1 })).status).toBe(400);
    expect((await put(app, 'ios_engine', {})).status).toBe(400);
    expect((await put(app, 'ios_engine', { enabled: true, x: 1 })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('未提供开关服务时 503', async () => {
    const { withoutFlags } = routes();
    expect((await withoutFlags.request('/api/v1/admin/app-flags')).status).toBe(503);
  });
});

describe('createAppFlagsAdmin', () => {
  function fakeDb(initial: Record<string, number>) {
    const store = { ...initial };
    const log: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db = {
      first: async (_sql: string, values: readonly unknown[]) => (values[0] as string) in store ? { enabled: store[values[0] as string] } : null,
      all: async () => Object.entries(store).map(([flag_key, enabled]) => ({ flag_key, enabled })),
      run: async (sql: string, values: readonly unknown[]) => {
        log.push({ sql, values });
        if (sql.startsWith('INSERT INTO app_flags')) store[values[0] as string] = values[1] as number;
        return { affectedRows: 1, insertId: 0 };
      },
      transaction: async (work: (tx: MysqlDatabase) => Promise<unknown>) => work(db as never),
    } as unknown as MysqlDatabase;
    return { db, store, log };
  }

  it('list 返回所有已知开关，缺行当作关闭', async () => {
    const { db } = fakeDb({});
    expect(await createAppFlagsAdmin(db).list()).toEqual([{ key: 'ios_engine', enabled: false }]);
  });

  it('set 在同一事务里写开关并记审计（含前后值与请求号）', async () => {
    const { db, store, log } = fakeDb({ ios_engine: 0 });
    const result = await createAppFlagsAdmin(db, () => 1234).set(9, 'ios_engine', true, 'req-1');
    expect(result).toEqual({ key: 'ios_engine', enabled: true });
    expect(store.ios_engine).toBe(1);
    const audit = log.find((entry) => entry.sql.startsWith('INSERT INTO admin_audit_log'))!;
    expect(audit.values[0]).toBe(9);
    expect(audit.values[1]).toBe('app_flag_set');
    expect(audit.values[2]).toBeNull();
    expect(JSON.parse(String(audit.values[3]))).toEqual({ key: 'ios_engine', from: false, to: true });
    expect(audit.values[4]).toBe('req-1');
    expect(audit.values[5]).toBe(1234);
  });

  it('未知开关名 404，不写任何东西', async () => {
    const { db, log } = fakeDb({});
    await expect(createAppFlagsAdmin(db).set(9, 'nope', true, 'r')).rejects.toMatchObject({ status: 404 });
    expect(log).toEqual([]);
  });
});
