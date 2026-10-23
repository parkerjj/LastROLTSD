import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../src/db/mysql-client';
import type { AppEnv } from '../src/env';
import { registerKeBuildRoutes } from '../src/ke/build-register-router';
import { registerKeRoutes } from '../src/ke/router';

const INSTANCE = '11111111-1111-4111-8111-111111111111';
const BUILD = 'aaaaaaa-202610232100-123-1';
const HASH = 'a'.repeat(64);
const NOW = 1800000000000;
const bearer = `Bearer ke1_${Buffer.alloc(32, 1).toString('base64url')}`;
const secret = (fill: number) => Buffer.alloc(32, fill).toString('base64');
function environment(): AppEnv {
  return {
    ENVIRONMENT: 'production', MYSQL_URL: 'mysql://fixture:fixture@127.0.0.1/fixture',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
    KE_LICENSE_PRIVATE_KEY_v1: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    KE_CORE_KEY: secret(5), KE_BUILD_MANIFEST: 'invalid legacy JSON',
  } as AppEnv;
}

// 只替代 SQL 边界；请求解析、认证、限流、policy 检查及授权 service 均使用真实实现。
function database(policy: { enforced: number; status?: string; fail?: boolean; activeInstance?: boolean }): MysqlDatabase {
  const db = {
    async first(sql: string, values: readonly unknown[] = []) {
      if (sql.includes('ke_build_policy')) {
        if (policy.fail) throw new Error('isolated database failure');
        if (sql.includes('LEFT JOIN')) return { enforced: policy.enforced,
          status: values[0] === BUILD ? policy.status ?? 'ACTIVE' : null, core_sha256: HASH };
        return { enforced: policy.enforced };
      }
      if (sql.includes('FROM ke_tokens AS t')) return { id: 1, user_id: 1, last_used_at: NOW };
      if (sql.includes('FROM auth_rate_limits')) return { request_count: 0, next_allowed_at: 0, expires_at: NOW + 3600000 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async all(sql: string) {
      if (sql.includes('FROM auth_users')) return [{ id: 1 }];
      if (sql.includes('FROM ke_characters')) return [];
      if (sql.includes('FROM ke_instances')) return policy.activeInstance ? [{ instance_id: INSTANCE, user_id: 1, aid: 1, cid: 2, nid: 3, state: 'ACTIVE' }] : [];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async run() { return { affectedRows: 1, insertId: 1 }; },
    async transaction<T>(work: (tx: MysqlDatabase) => Promise<T>): Promise<T> { return work(db as unknown as MysqlDatabase); },
  };
  return db as unknown as MysqlDatabase;
}
function licenseApp(policy: Parameters<typeof database>[0], env = environment()) {
  const app = new Hono();
  registerKeRoutes(app, env, database(policy), { now: () => NOW, fetch: globalThis.fetch });
  return app;
}
async function bind(app: Hono, build = BUILD) {
  return app.request('/api/v1/ke/instances/bind', { method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: INSTANCE, aid: 1, cid: 2, nid: 3, build_id: build, build_hash: HASH }),
  });
}

describe('构建登记 HTTP body 错误', () => {
  it.each([
    ['非法 JSON', 'application/json', '{', 400],
    ['body 超限', 'application/json', 'x'.repeat(8193), 413],
    ['非 JSON 媒体类型', 'text/plain', '{}', 415],
  ])('%s 保留状态码并返回 KE_BAD_REQUEST', async (_name, contentType, body, status) => {
    const app = new Hono<{ Bindings: AppEnv; Variables: { requestId: string } }>();
    registerKeBuildRoutes(app, environment());
    const response = await app.request('/api/v1/ke/builds/register', { method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': contentType }, body });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: 'KE_BAD_REQUEST' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('数据库构建 policy 与 legacy 配置隔离', () => {
  it('enforced=1 的 ACTIVE 构建不受非法 legacy secret 阻断', async () => {
    const response = await bind(licenseApp({ enforced: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ instance_id: INSTANCE });
  });
  it.each([
    '/api/v1/ke/instances/bind',
    `/api/v1/ke/instances/${INSTANCE}/start`,
    `/api/v1/ke/instances/${INSTANCE}/heartbeat`,
    `/api/v1/ke/instances/${INSTANCE}/stop`,
  ])('enforced 模式 %s 仍要求有效 Bearer', async (path) => {
    const response = await licenseApp({ enforced: 1 }).request(path, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'KE_AUTH_UNAUTHENTICATED' } });
  });
  it('enforced 模式仍要求账号体系启用以及有效授权密钥', async () => {
    for (const patch of [{ AUTH_ENABLED: 'false' }, { KE_CORE_KEY: 'invalid' }, { KE_LICENSE_PRIVATE_KEY_v1: '' }]) {
      const response = await bind(licenseApp({ enforced: 1 }, { ...environment(), ...patch }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'KE_UNAVAILABLE' } });
    }
  });
  it('bootstrap 仍对非法 legacy secret 封闭失败', async () => {
    const response = await bind(licenseApp({ enforced: 0 }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'KE_UNAVAILABLE' } });
  });
  it('enforced=1 仍拒绝未知构建及已撤销构建', async () => {
    for (const response of [await bind(licenseApp({ enforced: 1 }), 'unknown'),
      await bind(licenseApp({ enforced: 1, status: 'REVOKED' }))]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'KE_BUILD_REJECTED' } });
    }
  });
  it('policy 读取失败仍返回503', async () => {
    const response = await bind(licenseApp({ enforced: 1, fail: true }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'KE_UNAVAILABLE' } });
  });
  it('stop 不因构建撤销或坏 legacy 被拒绝', async () => {
    const response = await licenseApp({ enforced: 1, status: 'REVOKED', activeInstance: true })
      .request(`/api/v1/ke/instances/${INSTANCE}/stop`, { method: 'POST', headers: { authorization: bearer } });
    expect(response.status).toBe(204);
  });
  it('同一 router 从 bootstrap 切换 enforced 后不缓存坏 legacy 的失败', async () => {
    const policy = { enforced: 0 };
    const app = licenseApp(policy);
    expect((await bind(app)).status).toBe(503);
    policy.enforced = 1;
    expect((await bind(app)).status).toBe(200);
  });
});
