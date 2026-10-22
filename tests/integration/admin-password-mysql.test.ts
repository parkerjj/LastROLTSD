// 管理员强制改密的真实 MySQL 验证：新密码生效、旧会话与旧密码失效、通知邮件、审计，以及不可对管理员使用。
// 需要 MYSQL_TEST_URL（库名以 _test 结尾、且不同于 MYSQL_URL）与 AUTH_TEST_DB_ALLOW_RESET=1，会清空并重建该库。
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/worker/src/index';
import { createActionService } from '../../apps/worker/src/auth/action-service';
import { resolveAuthConfig } from '../../apps/worker/src/auth/config';
import { createPasswordMaterial } from '../../apps/worker/src/auth/crypto';
import { createAuthRepository, type AuthRepository } from '../../apps/worker/src/auth/repository';
import { createSessionService } from '../../apps/worker/src/auth/session-service';
import type { AuthBindings, AuthRuntime } from '../../apps/worker/src/auth/types';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import type { AppEnv } from '../../apps/worker/src/env';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;
const BASE_TIME = Date.UTC(2026, 9, 13, 12);
const OLD_PASSWORD = 'old-account-password';
const NEW_PASSWORD = 'brand-new-password-from-admin';

function testSecret(fill: number): string {
  let binary = '';
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: testSecret(1), AUTH_CSRF_SECRET: testSecret(2),
    AUTH_RATE_SECRET: testSecret(3), AUTH_MAIL_PAYLOAD_SECRET: testSecret(4),
  };
}

async function seedUser(
  repository: AuthRepository, database: MysqlDatabase, config: ReturnType<typeof resolveAuthConfig>,
  email: string, permissionLevel: number,
): Promise<string> {
  const material = await createPasswordMaterial(OLD_PASSWORD, config);
  const user = await repository.transaction(async (tx) => {
    const created = await tx.insertUser({ email, emailNormalized: email.toLowerCase(), displayName: email.split('@')[0]!, createdAt: BASE_TIME });
    await tx.insertCredential(created.id, material);
    return created;
  });
  await database.run(
    "UPDATE auth_users SET status = 'ACTIVE', email_verified_at = ?, permission_level = ? WHERE id = ?",
    [BASE_TIME, permissionLevel, user.id],
  );
  return user.id;
}

async function count(database: MysqlDatabase, sql: string, values: unknown[] = []): Promise<number> {
  const row = await database.first<{ n: number | string }>(sql, values);
  return Number(row?.n ?? 0);
}

describe.skipIf(!runMysqlTests)('Admin password × MySQL', () => {
  it('强制改密：新密码生效、旧会话与旧密码失效、发通知邮件并留审计；管理员账号不可被改', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const config = resolveAuthConfig(bindings());
      const runtime: AuthRuntime = { now: () => BASE_TIME + 1000, fetch: (async () => { throw new Error('tests must not send mail'); }) as typeof fetch };
      const repository = createAuthRepository(database);
      const sessions = createSessionService(repository, config, runtime);
      const actions = createActionService(repository, config, runtime);
      const root = await seedUser(repository, database, config, 'root@example.test', 100);
      const otherAdmin = await seedUser(repository, database, config, 'boss@example.test', 100);
      const alice = await seedUser(repository, database, config, 'alice@example.test', 1);

      const login = await sessions.login('alice@example.test', OLD_PASSWORD);
      const cookie = login.cookie.split(';', 1)[0]!;
      const meRequest = () => new Request('https://lastro.example/api/v1/auth/me', { headers: { cookie } });
      await expect(sessions.authenticate(meRequest())).resolves.toBeDefined();

      await actions.adminSetPassword(root, alice, NEW_PASSWORD, 'req-1');

      await expect(sessions.authenticate(meRequest())).rejects.toBeDefined();
      await expect(sessions.login('alice@example.test', OLD_PASSWORD)).rejects.toBeDefined();
      await expect(sessions.login('alice@example.test', NEW_PASSWORD)).resolves.toBeDefined();
      expect(await count(database, "SELECT COUNT(*) AS n FROM auth_mail_outbox WHERE user_id = ? AND purpose = 'PASSWORD_CHANGED'", [alice])).toBe(1);
      expect(await count(database, "SELECT COUNT(*) AS n FROM auth_security_events WHERE user_id = ? AND event = 'PASSWORD_ADMIN_SET'", [alice])).toBe(1);
      const audit = await database.first<{ actor_user_id: number | string; target_user_id: number | string; request_id: string; detail: unknown }>(
        "SELECT actor_user_id, target_user_id, request_id, detail FROM admin_audit_log WHERE action = 'PASSWORD_SET'");
      expect(Number(audit!.actor_user_id)).toBe(Number(root));
      expect(Number(audit!.target_user_id)).toBe(Number(alice));
      expect(audit!.request_id).toBe('req-1');
      expect(JSON.stringify(audit!.detail ?? null)).not.toContain(NEW_PASSWORD);

      // 管理员账号（含自己）不允许被强制改密；密码不变
      await expect(actions.adminSetPassword(root, otherAdmin, NEW_PASSWORD, 'req-2')).rejects.toMatchObject({ code: 'AUTH_ADMIN_TARGET_FORBIDDEN', status: 403 });
      await expect(actions.adminSetPassword(root, root, NEW_PASSWORD, 'req-3')).rejects.toMatchObject({ code: 'AUTH_ADMIN_TARGET_FORBIDDEN' });
      await expect(sessions.login('boss@example.test', OLD_PASSWORD)).resolves.toBeDefined();

      // 参数与目标校验
      await expect(actions.adminSetPassword(root, alice, 'abc', 'req-4')).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
      await expect(actions.adminSetPassword(root, '99999999', NEW_PASSWORD, 'req-5')).rejects.toMatchObject({ code: 'AUTH_USER_NOT_FOUND', status: 404 });
      expect(await count(database, "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'PASSWORD_SET'")).toBe(1);
    });
  }, 120_000);

  it('原子性：审计写入失败（操作者不存在）时，密码、通知邮件、安全事件全部回滚', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const config = resolveAuthConfig(bindings());
      const runtime: AuthRuntime = { now: () => BASE_TIME + 1000, fetch: (async () => { throw new Error('tests must not send mail'); }) as typeof fetch };
      const repository = createAuthRepository(database);
      const sessions = createSessionService(repository, config, runtime);
      const actions = createActionService(repository, config, runtime);
      const alice = await seedUser(repository, database, config, 'alice@example.test', 1);

      await expect(actions.adminSetPassword('987654', alice, NEW_PASSWORD, 'req-1')).rejects.toBeDefined();
      await expect(sessions.login('alice@example.test', OLD_PASSWORD)).resolves.toBeDefined();
      expect(await count(database, "SELECT COUNT(*) AS n FROM auth_mail_outbox WHERE purpose = 'PASSWORD_CHANGED'")).toBe(0);
      expect(await count(database, "SELECT COUNT(*) AS n FROM auth_security_events WHERE event = 'PASSWORD_ADMIN_SET'")).toBe(0);
    });
  }, 120_000);

  it('端到端：真实登录会话 + CSRF 经 createApp 走完后台接口；普通用户一律 404', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const env = bindings();
      const config = resolveAuthConfig(env);
      const repository = createAuthRepository(database);
      const root = await seedUser(repository, database, config, 'root@example.test', 100);
      const alice = await seedUser(repository, database, config, 'alice@example.test', 1);
      const app = createApp(env, database);
      const origin = 'https://lastro.example';

      async function login(email: string, password: string): Promise<{ cookie: string; csrf: string } | null> {
        const csrfResponse = await app.request('/api/v1/auth/csrf', { headers: { origin } });
        const anonymous = await csrfResponse.json() as { csrf_token: string };
        const anonymousCookie = csrfResponse.headers.get('set-cookie')!.split(';', 1)[0]!;
        const response = await app.request('/api/v1/auth/login', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json', cookie: anonymousCookie, 'x-csrf-token': anonymous.csrf_token },
          body: JSON.stringify({ email, password }),
        });
        if (response.status !== 200) return null;
        const body = await response.json() as { csrf_token: string };
        return { cookie: response.headers.get('set-cookie')!.split(';', 1)[0]!, csrf: body.csrf_token };
      }
      const call = (session: { cookie: string; csrf: string }, method: string, path: string, body?: unknown, withCsrf = true) => app.request(path, {
        method,
        headers: { origin, cookie: session.cookie, ...(withCsrf ? { 'x-csrf-token': session.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const admin = (await login('root@example.test', OLD_PASSWORD))!;
      const found = await (await call(admin, 'GET', '/api/v1/admin/users?q=alice')).json() as { users: Array<{ id: number }> };
      expect(found.users.map((user) => String(user.id))).toEqual([alice]);

      // 缺少 CSRF 头 → 403；带上 → 201
      expect((await call(admin, 'POST', `/api/v1/admin/users/${alice}/entitlements`, { resource: 'slots', delta: 3, duration_days: 30 }, false)).status).toBe(403);
      const granted = await call(admin, 'POST', `/api/v1/admin/users/${alice}/entitlements`, { resource: 'slots', delta: 3, duration_days: 30, note: '端到端' });
      expect(granted.status).toBe(201);
      const detail = await (await call(admin, 'GET', `/api/v1/admin/users/${alice}`)).json() as { effective: { slots: number; modules: string[] } };
      expect(detail.effective).toEqual({ slots: 3, modules: [] });

      // 强制改密后：旧密码登录失败，新密码成功；审计可读
      expect((await call(admin, 'POST', `/api/v1/admin/users/${alice}/password`, { new_password: NEW_PASSWORD })).status).toBe(200);
      expect(await login('alice@example.test', OLD_PASSWORD)).toBeNull();
      const aliceSession = (await login('alice@example.test', NEW_PASSWORD))!;
      expect(aliceSession).not.toBeNull();
      const audit = await (await call(admin, 'GET', '/api/v1/admin/audit')).json() as { entries: Array<{ action: string }> };
      expect(audit.entries.map((entry) => entry.action)).toEqual(['PASSWORD_SET', 'ENTITLEMENT_ADJUST']);

      // 普通用户：读写全部 404；匿名：401
      expect((await call(aliceSession, 'GET', '/api/v1/admin/users')).status).toBe(404);
      expect((await call(aliceSession, 'POST', `/api/v1/admin/users/${root}/password`, { new_password: NEW_PASSWORD })).status).toBe(404);
      expect((await app.request('/api/v1/admin/users')).status).toBe(401);
    });
  }, 120_000);
});
