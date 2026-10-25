import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../src/db/mysql-client';
import type { AppEnv } from '../src/env';
import { parseProfileInput, registerKeRoutes } from '../src/ke/router';

const SITE = 'https://lastro.example';
const INSTANCE = '11111111-1111-4111-8111-111111111111';

function secret(fill: number): string {
  return Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');
}

function bindings(withKe: boolean): AppEnv {
  const ke = withKe
    ? {
      KE_LICENSE_PRIVATE_KEY_v1: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      KE_CORE_KEY: randomBytes(32).toString('base64'),
    }
    : {};
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 524288,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: SITE,
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
    ...ke,
  } as AppEnv;
}

function appFor(withKe: boolean): Hono {
  const app = new Hono();
  // 授权端点先读取 bootstrap policy；其余用例在认证前返回，不访问业务数据。
  registerKeRoutes(app, bindings(withKe), { first: async () => ({ enforced: 0 }) } as unknown as MysqlDatabase);
  return app;
}

async function call(app: Hono, method: string, path: string, headers: Record<string, string> = {}) {
  const response = await app.request(path, { method, headers });
  const body = await response.json() as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

describe('ke routes: Origin 校验（/ke 网页编辑器的无 body 写操作）', () => {
  const guarded = [
    ['POST', '/api/v1/ke/profiles/1/activate'],
    ['DELETE', '/api/v1/ke/profiles/1'],
    ['POST', '/api/v1/ke/device/decision'],
    ['DELETE', '/api/v1/ke/tokens/1'],
  ] as const;

  for (const [method, path] of guarded) {
    it(`${method} ${path} 拒绝跨源 / 缺失 Origin，放行同源后才进入会话鉴权`, async () => {
      const app = appFor(false);
      expect(await call(app, method, path, { origin: 'https://evil.example' })).toEqual({ status: 403, code: 'KE_AUTH_FORBIDDEN' });
      expect(await call(app, method, path)).toEqual({ status: 403, code: 'KE_AUTH_FORBIDDEN' });
      expect(await call(app, method, path, { origin: SITE, 'sec-fetch-site': 'cross-site' })).toEqual({ status: 403, code: 'KE_AUTH_FORBIDDEN' });
      expect(await call(app, method, path, { origin: SITE })).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    });
  }
});

describe('ke routes: profile 输入解析的 all 兜底', () => {
  it('mon/pickup/items 缺失或为空时回退到 all 兜底文本，绝不落 NULL', () => {
    expect(parseProfileInput({})).toMatchObject({
      mon_control: 'all 1 0 0\n',
      pickupitems: 'all 1\n',
      items_control: 'all 0 0 0\n',
      timeouts: null,
    });
    expect(parseProfileInput({ mon_control: '   ', pickupitems: null, items_control: 123 })).toMatchObject({
      mon_control: 'all 1 0 0\n',
      pickupitems: 'all 1\n',
      items_control: 'all 0 0 0\n',
    });
    // 有效内容原样保留。
    expect(parseProfileInput({ mon_control: '1555 0 0 0\n', timeouts: 'ai_attack 0.3' })).toMatchObject({
      mon_control: '1555 0 0 0\n',
      timeouts: 'ai_attack 0.3',
    });
  });
});

describe('ke routes: license 配置与 Profile 路由解耦', () => {
  it('未配置 KE 密钥时，Profile/角色路由仍可用（走到会话鉴权），授权端点返回 503', async () => {
    const app = appFor(false);
    expect(await call(app, 'GET', '/api/v1/ke/profiles?aid=1&cid=2&nid=3')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    expect(await call(app, 'GET', '/api/v1/ke/characters')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    expect(await call(app, 'POST', '/api/v1/ke/instances/bind', { 'content-type': 'application/json' })).toEqual({ status: 503, code: 'KE_UNAVAILABLE' });
  });

  it('KE 密钥格式错误同样只影响授权端点', async () => {
    const env = { ...bindings(true), KE_CORE_KEY: 'not-base64' } as AppEnv;
    const app = new Hono();
    registerKeRoutes(app, env, {} as MysqlDatabase);
    expect(await call(app, 'GET', '/api/v1/ke/characters')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    expect(await call(app, 'POST', '/api/v1/ke/instances/bind', { 'content-type': 'application/json' })).toEqual({ status: 503, code: 'KE_UNAVAILABLE' });
  });
});

describe('ke routes: KE 自己的接口只认 Bearer（IWA 无 cookie、也不按站点 Origin 拦截）', () => {
  const iwa = 'isolated-app://nuqzolbnqymznffqhrx7ylosbqvbzekt4eybubmopsmsbjz5z2uqaaic';
  const sessionCookie = `__Host-ltsd-session=${'a'.repeat(43)}`;
  const bearerOnly = [
    ['POST', '/api/v1/ke/instances/bind'],
    ['POST', '/api/v1/ke/modules/keys'],
    ['POST', `/api/v1/ke/instances/${INSTANCE}/start`],
    ['POST', `/api/v1/ke/instances/${INSTANCE}/heartbeat`],
    ['POST', `/api/v1/ke/instances/${INSTANCE}/stop`],
    ['GET', '/api/v1/ke/profiles/active?aid=1&cid=2&nid=3'],
    ['GET', '/api/v1/ke/me'],
    ['POST', '/api/v1/ke/token/revoke'],
  ] as const;

  for (const [method, path] of bearerOnly) {
    it(`${method} ${path.split('?')[0]}：无 Authorization / 非法 Bearer / 仅有会话 cookie 均为 401；IWA Origin 不被拦`, async () => {
      const app = appFor(true);
      const unauthenticated = { status: 401, code: 'KE_AUTH_UNAUTHENTICATED' };
      expect(await call(app, method, path, { origin: iwa })).toEqual(unauthenticated);
      expect(await call(app, method, path, { origin: iwa, authorization: 'Bearer garbage' })).toEqual(unauthenticated);
      expect(await call(app, method, path, { origin: iwa, authorization: `Bearer ke1_${'a'.repeat(43)}` })).toEqual(unauthenticated);
      expect(await call(app, method, path, { origin: iwa, authorization: `Basic ${'a'.repeat(20)}` })).toEqual(unauthenticated);
      // 会话 cookie 不能代替 Bearer：KE 端点不接受 cookie
      expect(await call(app, method, path, { origin: SITE, cookie: sessionCookie })).toEqual(unauthenticated);
    });
  }
});

describe('ke routes: 设备授权接口', () => {
  it('device/code 与 device/token 不依赖 KE 密钥；非 JSON 请求在触达数据库前被拒绝', async () => {
    const app = appFor(false);
    expect(await call(app, 'POST', '/api/v1/ke/device/code')).toEqual({ status: 415, code: 'KE_BAD_REQUEST' });
    expect(await call(app, 'POST', '/api/v1/ke/device/token', { 'content-type': 'text/plain' })).toEqual({ status: 415, code: 'KE_BAD_REQUEST' });
  });

  it('网页侧（lookup / tokens）需要会话 cookie', async () => {
    const app = appFor(false);
    expect(await call(app, 'GET', '/api/v1/ke/device/lookup?user_code=BCDF-GHJK')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    expect(await call(app, 'GET', '/api/v1/ke/tokens')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
  });
});
