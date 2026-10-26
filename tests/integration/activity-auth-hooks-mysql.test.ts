import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { resolveAuthConfig } from '../../apps/worker/src/auth/config';
import { openMailPayload } from '../../apps/worker/src/auth/crypto';
import { registerAuthRoutes } from '../../apps/worker/src/auth/router';
import type { ActivityEntry, ActivityRecorder } from '../../apps/worker/src/activity/recorder';
import type { ActionPurpose, AuthBindings, NewMailJob } from '../../apps/worker/src/auth/types';
import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../../apps/worker/src/db/mysql-client';
import type { AppEnv } from '../../apps/worker/src/env';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;
const ORIGIN = 'https://lastro.example';

function testSecret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function testAuthBindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: ORIGIN,
    AUTH_PASSWORD_SECRET: testSecret(1), AUTH_CSRF_SECRET: testSecret(2),
    AUTH_RATE_SECRET: testSecret(3), AUTH_MAIL_PAYLOAD_SECRET: testSecret(4),
  };
}

/** 让指定表的 INSERT 抛错，用来验证日志写入失败不影响主流程。 */
function failActivityInserts(database: MysqlDatabase): MysqlDatabase {
  const wrap = (current: MysqlDatabase): MysqlDatabase => ({
    all: <T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]) => current.all<T>(sql, values),
    first: <T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]) => current.first<T>(sql, values),
    run: async (sql: string, values?: readonly unknown[]) => {
      if (/^\s*INSERT INTO account_activity_log\b/iu.test(sql)) {
        throw new MysqlDatabaseError(new Error('simulated activity insert failure'), 'insert:account_activity_log');
      }
      return current.run(sql, values);
    },
    transaction: <T>(work: (transaction: MysqlDatabase) => Promise<T>) =>
      current.transaction((transaction) => work(wrap(transaction))),
    healthcheck: () => current.healthcheck(),
    close: () => current.close(),
  });
  return wrap(database);
}

async function harness(database: MysqlDatabase, options: { capture: boolean; routeDatabase?: MysqlDatabase }) {
  let now = Date.UTC(2026, 9, 12, 12);
  const entries: ActivityEntry[] = [];
  const capturing: ActivityRecorder = {
    record: async (_request, entry) => { entries.push(entry); },
    recordHeartbeat: async (_request, entry) => { entries.push(entry); },
  };
  const app = new Hono();
  const runtime = { now: () => now, fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch };
  const config = resolveAuthConfig(testAuthBindings());
  registerAuthRoutes(app, testAuthBindings(), options.routeDatabase ?? database, runtime, options.capture ? capturing : undefined);

  const csrfResponse = await app.request('/api/v1/auth/csrf', { headers: { origin: ORIGIN } });
  const anonymous = await csrfResponse.json() as { csrf_token: string };
  const anonymousCookie = csrfResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (!anonymousCookie) throw new Error('expected anonymous CSRF cookie');

  const post = (path: string, body: unknown, cookie = anonymousCookie, csrf = anonymous.csrf_token) => app.request(path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
  const register = (email: string, password: string) => post('/api/v1/auth/register', {
    email, password, password_confirmation: password, display_name: 'Pilot',
  });
  const login = (email: string, password: string) => post('/api/v1/auth/login', { email, password });
  const session = async (email: string, password: string) => {
    const response = await login(email, password);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('expected authenticated session cookie');
    const body = await response.json() as { csrf_token: string };
    return { cookie: `${anonymousCookie}; ${cookie}`, csrf: body.csrf_token };
  };
  const userIdFor = async (emailNormalized: string): Promise<string> => {
    const row = await database.first<MysqlRow>('SELECT CAST(id AS CHAR) AS id FROM auth_users WHERE email_normalized = ?', [emailNormalized]);
    if (typeof row?.id !== 'string') throw new Error('expected created auth user');
    return row.id;
  };
  const actionToken = async (userId: string, purpose: ActionPurpose): Promise<string> => {
    const row = await database.first<MysqlRow>(`SELECT id, action_digest, CAST(user_id AS CHAR) AS user_id, purpose,
        priority, created_at, expires_at, payload_ciphertext, payload_iv, payload_key_version
      FROM auth_mail_outbox WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1`, [userId, purpose]);
    if (!row || !(row.action_digest instanceof Uint8Array)) throw new Error('expected prepared action mail');
    const job: NewMailJob = {
      id: String(row.id), actionDigest: row.action_digest, userId: String(row.user_id), purpose,
      priority: Number(row.priority) === 0 ? 0 : 1,
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      payloadCiphertext: String(row.payload_ciphertext), payloadIv: String(row.payload_iv),
      payloadKeyVersion: String(row.payload_key_version),
    };
    const intent = JSON.parse(await openMailPayload(job, { mailId: job.id, purpose }, config)) as { text: string };
    const token = /token=([A-Za-z0-9_-]{43})/u.exec(intent.text)?.[1];
    if (!token) throw new Error('expected action token in sealed mail');
    return token;
  };
  const advance = (milliseconds: number) => { now += milliseconds; };
  return { entries, post, register, login, session, userIdFor, actionToken, advance };
}

describe('account activity hooks for auth routes', () => {
  it.skipIf(!runMysqlTests)('records REGISTER only for a newly created account', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database, { capture: true });
      expect((await h.register('pilot@example.test', '12345')).status).toBe(202);
      const userId = await h.userIdFor('pilot@example.test');
      expect(h.entries).toEqual([{ userId, event: 'REGISTER', requestId: expect.any(String) }]);

      h.advance(61_000);
      expect((await h.register('Pilot@example.test', '67890')).status).toBe(202);
      expect(h.entries).toHaveLength(1);
    });
  });

  it.skipIf(!runMysqlTests)('records EMAIL_VERIFIED after confirm', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database, { capture: true });
      await h.register('pilot@example.test', '12345');
      const userId = await h.userIdFor('pilot@example.test');
      const owner = await h.session('pilot@example.test', '12345');
      const token = await h.actionToken(userId, 'VERIFY_EMAIL');
      h.entries.length = 0;

      const confirmed = await h.post('/api/v1/auth/email-verification/confirm', { token }, owner.cookie, owner.csrf);
      expect(confirmed.status).toBe(200);
      expect(h.entries).toEqual([{ userId, event: 'EMAIL_VERIFIED', requestId: expect.any(String) }]);

      const repeated = await h.post('/api/v1/auth/email-verification/confirm', { token }, owner.cookie, owner.csrf);
      expect(repeated.status).toBeGreaterThanOrEqual(400);
      expect(h.entries).toHaveLength(1);
    });
  });

  it.skipIf(!runMysqlTests)('records LOGIN success and wrong-password failure, ignores unknown email', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database, { capture: true });
      await h.register('pilot@example.test', '12345');
      const userId = await h.userIdFor('pilot@example.test');
      h.entries.length = 0;

      expect((await h.login('pilot@example.test', '12345')).status).toBe(200);
      expect(h.entries).toEqual([{ userId, event: 'LOGIN', requestId: expect.any(String) }]);

      const wrong = await h.login('pilot@example.test', 'wrong-password');
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ error: { code: 'AUTH_INVALID_CREDENTIALS' } });
      expect(h.entries[1]).toEqual({ userId, event: 'LOGIN', result: 'FAILURE', requestId: expect.any(String) });

      const unknown = await h.login('nobody@example.test', '12345');
      expect(unknown.status).toBe(401);
      expect(h.entries).toHaveLength(2);
    });
  });

  it.skipIf(!runMysqlTests)('records password reset request/confirm and password change', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database, { capture: true });
      await h.register('pilot@example.test', '12345');
      const userId = await h.userIdFor('pilot@example.test');
      // 改密码要求邮箱已验证；重置密码会让旧验证令牌失效，所以先验证
      const pending = await h.session('pilot@example.test', '12345');
      const verified = await h.post('/api/v1/auth/email-verification/confirm',
        { token: await h.actionToken(userId, 'VERIFY_EMAIL') }, pending.cookie, pending.csrf);
      expect(verified.status).toBe(200);
      h.entries.length = 0;

      h.advance(61_000);
      expect((await h.post('/api/v1/auth/password-reset/request', { email: 'nobody@example.test' })).status).toBe(202);
      expect(h.entries).toEqual([]);
      expect((await h.post('/api/v1/auth/password-reset/request', { email: 'pilot@example.test' })).status).toBe(202);
      expect(h.entries).toEqual([{ userId, event: 'PASSWORD_RESET_REQUEST', requestId: expect.any(String) }]);

      const reset = await h.post('/api/v1/auth/password-reset/confirm', {
        token: await h.actionToken(userId, 'RESET_PASSWORD'),
        new_password: 'reset-password-1', new_password_confirmation: 'reset-password-1',
      });
      expect(reset.status).toBe(204);
      expect(h.entries[1]).toEqual({ userId, event: 'PASSWORD_RESET', requestId: expect.any(String) });

      const owner = await h.session('pilot@example.test', 'reset-password-1');
      const changed = await h.post('/api/v1/auth/password/change', {
        current_password: 'reset-password-1', new_password: 'changed-password-2', new_password_confirmation: 'changed-password-2',
      }, owner.cookie, owner.csrf);
      expect(changed.status).toBe(204);
      expect(h.entries.map((entry) => entry.event)).toEqual(['PASSWORD_RESET_REQUEST', 'PASSWORD_RESET', 'LOGIN', 'PASSWORD_CHANGE']);
      expect(h.entries[3]).toEqual({ userId, event: 'PASSWORD_CHANGE', requestId: expect.any(String) });
    });
  });

  it.skipIf(!runMysqlTests)('register still returns 202 when the activity insert fails', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database, { capture: false, routeDatabase: failActivityInserts(database) });
      const response = await h.register('pilot@example.test', '12345');
      expect(response.status).toBe(202);
      await expect(database.first<MysqlRow>('SELECT COUNT(*) AS n FROM auth_users WHERE email_normalized = ?', ['pilot@example.test']))
        .resolves.toMatchObject({ n: 1 });
    });
  });
});
