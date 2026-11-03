import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerAppConfigRoutes, type AppConfigDeps } from '../src/app-config/router';
import { AuthFailure } from '../src/auth/types';
import type { KeEntitlements } from '../src/ke/entitlements';

const NOW = 1_800_000_000_000;
const SECRET = 'admin-secret-value';

function entitlements(modules: string[] = []): KeEntitlements {
  return { slots: 1, modules: new Set(modules) };
}

function fixture(overrides: Partial<AppConfigDeps> & { flag?: boolean; modules?: string[]; status?: string } = {}) {
  const calls = { authenticate: 0, entitlements: 0, writes: [] as Array<{ key: string; enabled: boolean; at: number }> };
  const state = { flag: overrides.flag ?? false };
  const deps: AppConfigDeps = {
    readFlag: overrides.readFlag ?? (async () => state.flag),
    writeFlag: overrides.writeFlag ?? (async (key, enabled, at) => { calls.writes.push({ key, enabled, at }); state.flag = enabled; }),
    auth: overrides.auth === undefined
      ? { authenticate: async () => { calls.authenticate += 1; return { userId: '7', status: overrides.status ?? 'ACTIVE' }; } }
      : overrides.auth,
    entitlements: overrides.entitlements ?? (async () => { calls.entitlements += 1; return entitlements(overrides.modules); }),
    now: () => NOW,
  };
  const app = new Hono();
  registerAppConfigRoutes(app, { ADMIN_SECRET: SECRET } as never, deps);
  return { app, calls, state };
}

const put = (app: Hono<any>, body: unknown, secret: string | null = SECRET, key = 'ios_engine') =>
  app.request(`/api/admin/app-flags/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) },
    body: JSON.stringify(body),
  });

describe('GET /api/v1/app/config', () => {
  it('开关关闭：不碰登录态，只返回 iosEngine=false', async () => {
    const { app, calls } = fixture({ flag: false, modules: ['standalone'] });
    const response = await app.request('/api/v1/app/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ iosEngine: false, standalone: false });
    expect(calls.authenticate).toBe(0);
    expect(calls.entitlements).toBe(0);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('开关开启、没有有效登录 cookie：standalone=false', async () => {
    const { app } = fixture({
      flag: true,
      auth: { authenticate: async () => { throw new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录'); } },
    });
    const response = await app.request('/api/v1/app/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ iosEngine: true, standalone: false });
  });

  it('开关开启、账号有 standalone 模块：standalone=true', async () => {
    const { app, calls } = fixture({ flag: true, modules: ['core', 'standalone'] });
    const response = await app.request('/api/v1/app/config', { headers: { cookie: 'x=1' } });
    expect(await response.json()).toEqual({ iosEngine: true, standalone: true });
    expect(calls.entitlements).toBe(1);
  });

  it('开关开启、账号只有 core 模块：standalone=false', async () => {
    const { app } = fixture({ flag: true, modules: ['core'] });
    expect(await (await app.request('/api/v1/app/config')).json()).toEqual({ iosEngine: true, standalone: false });
  });

  it('未验证邮箱的账号即使有权益也不算 standalone', async () => {
    const { app } = fixture({ flag: true, modules: ['standalone'], status: 'PENDING_EMAIL' });
    expect(await (await app.request('/api/v1/app/config')).json()).toEqual({ iosEngine: true, standalone: false });
  });

  it('账号系统未启用（auth=null）：standalone=false', async () => {
    const { app } = fixture({ flag: true, auth: null });
    expect(await (await app.request('/api/v1/app/config')).json()).toEqual({ iosEngine: true, standalone: false });
  });

  it('认证过程出现非登录类错误：503，不把故障当成"没权限"悄悄吞掉', async () => {
    const { app } = fixture({ flag: true, auth: { authenticate: async () => { throw new Error('db down'); } } });
    const response = await app.request('/api/v1/app/config');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('读开关失败：503', async () => {
    const { app } = fixture({ readFlag: async () => { throw new Error('db down'); } });
    expect((await app.request('/api/v1/app/config')).status).toBe(503);
  });
});

describe('admin app flags', () => {
  it('缺少或错误的 x-admin-secret 一律 404，且不写库', async () => {
    const { app, calls } = fixture();
    expect((await put(app, { enabled: true }, null)).status).toBe(404);
    expect((await put(app, { enabled: true }, 'wrong')).status).toBe(404);
    expect(calls.writes).toEqual([]);
  });

  it('未知开关名 404', async () => {
    const { app, calls } = fixture();
    expect((await put(app, { enabled: true }, SECRET, 'something_else')).status).toBe(404);
    expect(calls.writes).toEqual([]);
  });

  it('请求体必须是 {enabled: boolean}', async () => {
    const { app, calls } = fixture();
    expect((await put(app, { enabled: 'yes' })).status).toBe(400);
    expect((await put(app, {})).status).toBe(400);
    expect((await put(app, { enabled: true, extra: 1 })).status).toBe(400);
    expect(calls.writes).toEqual([]);
  });

  it('写入后 GET /api/v1/app/config 立刻反映；GET 管理接口返回当前值', async () => {
    const { app, calls } = fixture({ modules: ['standalone'] });
    const response = await put(app, { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: 'ios_engine', enabled: true });
    expect(calls.writes).toEqual([{ key: 'ios_engine', enabled: true, at: NOW }]);
    expect(await (await app.request('/api/v1/app/config')).json()).toEqual({ iosEngine: true, standalone: true });
    const admin = await app.request('/api/admin/app-flags/ios_engine', { headers: { 'x-admin-secret': SECRET } });
    expect(await admin.json()).toEqual({ key: 'ios_engine', enabled: true });
  });

  it('服务端没配置 ADMIN_SECRET 时管理接口不可用', async () => {
    const app = new Hono();
    let writes = 0;
    registerAppConfigRoutes(app, {} as never, { readFlag: async () => false, writeFlag: async () => { writes += 1; }, auth: null, entitlements: async () => entitlements(), now: () => NOW });
    const response = await app.request('/api/admin/app-flags/ios_engine', { method: 'PUT', headers: { 'x-admin-secret': '' }, body: '{"enabled":true}' });
    expect(writes).toBe(0);
    expect(response.status).toBe(404);
  });
});

describe('迁移 027', () => {
  const ddl = readFileSync(new URL('../../../migrations/mysql/027_app_flags.sql', import.meta.url), 'utf8');

  it('建表 app_flags：开关名主键、默认关闭，并预置 ios_engine=0', () => {
    expect(ddl).toMatch(/CREATE TABLE app_flags \(/u);
    expect(ddl).toMatch(/flag_key VARCHAR\(\d+\)[^\n]*NOT NULL/u);
    expect(ddl).toMatch(/enabled TINYINT\(1\) NOT NULL DEFAULT 0/u);
    expect(ddl).toMatch(/updated_at BIGINT UNSIGNED NOT NULL/u);
    expect(ddl).toMatch(/PRIMARY KEY \(flag_key\)/u);
    expect(ddl).toMatch(/INSERT INTO app_flags[\s\S]*'ios_engine', 0/u);
    expect(ddl).toMatch(/ON DUPLICATE KEY UPDATE/u);
  });
});
