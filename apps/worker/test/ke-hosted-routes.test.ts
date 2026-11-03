import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../src/db/mysql-client';
import type { AppEnv } from '../src/env';
import { parseCreateInput, parseLeaseInput, parseReportInput } from '../src/ke/hosted/router';
import { registerKeRoutes } from '../src/ke/router';
import { KeFailure } from '../src/ke/types';

const SITE = 'https://lastro.example';
const INSTANCE = '11111111-1111-4111-8111-111111111111';

function secret(fill: number): string {
  return Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');
}

function bindings(): AppEnv {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 524288,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: SITE,
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
    KE_LICENSE_PRIVATE_KEY_v1: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    KE_CORE_KEY: randomBytes(32).toString('base64'),
    KE_HOSTED_CRED_KEY: secret(5),
  } as AppEnv;
}

function appFor(): Hono {
  const app = new Hono();
  registerKeRoutes(app, bindings(), { first: async () => ({ enforced: 0 }) } as unknown as MysqlDatabase);
  return app;
}

async function call(app: Hono, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body }) });
  const json = await response.json() as { error: { code: string } };
  return { status: response.status, code: json.error.code };
}

describe('托管面板路由：写操作校验 Origin，然后才进入会话鉴权', () => {
  const guarded = [
    ['POST', '/api/v1/ke/hosted'],
    ['POST', `/api/v1/ke/hosted/${INSTANCE}/start`],
    ['POST', `/api/v1/ke/hosted/${INSTANCE}/stop`],
    ['DELETE', `/api/v1/ke/hosted/${INSTANCE}`],
  ] as const;
  for (const [method, path] of guarded) {
    it(`${method} ${path}`, async () => {
      const app = appFor();
      expect(await call(app, method, path, { origin: 'https://evil.example' })).toEqual({ status: 403, code: 'KE_AUTH_FORBIDDEN' });
      expect(await call(app, method, path)).toEqual({ status: 403, code: 'KE_AUTH_FORBIDDEN' });
      expect(await call(app, method, path, { origin: SITE, 'sec-fetch-site': 'cross-site' })).toEqual({ status: 403, code: 'KE_AUTH_FORBIDDEN' });
      expect(await call(app, method, path, { origin: SITE })).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    });
  }

  it('列表需要会话 cookie；设备 Bearer token 不能当作会话使用', async () => {
    const app = appFor();
    expect(await call(app, 'GET', '/api/v1/ke/hosted')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    expect(await call(app, 'GET', '/api/v1/ke/hosted', { authorization: `Bearer ke1_${'A'.repeat(43)}` })).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
  });
});

describe('agent 路由：必须带有效签名，缺失/畸形一律 401', () => {
  const routes = [
    '/api/v1/ke/agent/lease',
    `/api/v1/ke/agent/instances/${INSTANCE}/launch`,
    `/api/v1/ke/agent/instances/${INSTANCE}/token`,
    `/api/v1/ke/agent/instances/${INSTANCE}/report`,
    '/api/v1/ke/agent/modules/keys',
  ];
  for (const path of routes) {
    it(`POST ${path}`, async () => {
      const app = appFor();
      expect(await call(app, 'POST', path, {}, '{}')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
      expect(await call(app, 'POST', path, {
        'x-ke-agent': 'agt_000000000000000000000001', 'x-ke-ts': '1', 'x-ke-nonce': 'short', 'x-ke-sig': 'AAAA',
      }, '{}')).toEqual({ status: 401, code: 'KE_AUTH_UNAUTHENTICATED' });
    });
  }

  it('过大的请求体在鉴权之前被拒绝', async () => {
    const app = appFor();
    const response = await app.request('/api/v1/ke/agent/lease', { method: 'POST', body: 'x'.repeat(20_000), headers: { 'content-length': '20000' } });
    expect(response.status).toBe(413);
  });
});

describe('托管 token 只在实例端点有效', () => {
  it('其他 Bearer 端点（me / modules/keys / token/revoke）不认托管 token', async () => {
    const app = appFor();
    const headers = { authorization: `Bearer ke1_${'B'.repeat(43)}` };
    expect((await call(app, 'GET', '/api/v1/ke/me', headers)).status).toBe(401);
    expect((await call(app, 'POST', '/api/v1/ke/token/revoke', headers)).status).toBe(401);
  });
});

describe('请求体解析', () => {
  const valid = { nid: 3, aid: 1000001, cid: 2000002, char_name: 'Poring', game_account: 'acct', game_password: 'pw' };

  it('创建：字段类型、范围、控制字符都被校验', () => {
    expect(parseCreateInput(valid)).toMatchObject({ nid: 3, aid: 1000001, charName: 'Poring', gameAccount: 'acct', gamePassword: 'pw' });
    for (const bad of [
      { ...valid, aid: 0 }, { ...valid, nid: -1 }, { ...valid, cid: 1.5 }, { ...valid, char_name: '' }, { ...valid, game_password: 'a\nb' },
      { ...valid, game_account: 'x'.repeat(200) }, { ...valid, game_password: undefined },
    ]) {
      expect(() => parseCreateInput(bad as Record<string, unknown>)).toThrow(KeFailure);
    }
  });

  it('租约：实例数量与字段范围受限', () => {
    expect(parseLeaseInput({ agent_version: '1.0', capacity: { mem_available_mb: 900 }, instances: [{ id: INSTANCE, epoch: 2, phase: 'running' }] }))
      .toMatchObject({ memAvailableMb: 900, cleanSlate: false, instances: [{ id: INSTANCE, epoch: 2, phase: 'running', retryAt: null }] });
    expect(parseLeaseInput({ clean_slate: true }).cleanSlate).toBe(true);
    expect(() => parseLeaseInput({ instances: new Array(129).fill({ id: INSTANCE, epoch: 1, phase: 'running' }) })).toThrow(KeFailure);
    expect(() => parseLeaseInput({ instances: [{ id: INSTANCE, epoch: -1, phase: 'running' }] })).toThrow(KeFailure);
    expect(() => parseLeaseInput({ capacity: { mem_available_mb: 'lots' } })).toThrow(KeFailure);
  });

  it('上报：phase 必须在白名单内', () => {
    expect(parseReportInput({ epoch: 1, phase: 'backoff', retry_at: 1700000000000 })).toEqual({ epoch: 1, phase: 'backoff', retryAt: 1700000000000 });
    expect(parseReportInput({ epoch: 1, phase: 'stopped' }).retryAt).toBeNull();
    expect(() => parseReportInput({ epoch: 1, phase: 'hacked' })).toThrow(KeFailure);
    expect(() => parseReportInput({ phase: 'running' })).toThrow(KeFailure);
  });
});
