import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import type { AppEnv } from '../../apps/worker/src/env';
import { digestToken } from '../../apps/worker/src/auth/crypto';
import { registerKeRoutes } from '../../apps/worker/src/ke/router';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const run = Boolean(process.env.MYSQL_TEST_URL) || process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const SITE = 'https://lastro.example';
const NOW = 1_800_000_000_000;
const UUID = '11111111-1111-4111-8111-111111111111';
function bindings(): AppEnv {
  const secret = (n: number) => Buffer.alloc(32, n).toString('base64');
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 524288,
    MYSQL_URL: 'mysql://test:local@127.0.0.1/lastroweb_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: SITE,
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
  } as AppEnv;
}
async function session(database: MysqlDatabase, userId: number, expires = NOW + 100000) {
  const token = randomBytes(32).toString('base64url');
  const digest = await digestToken(token);
  await database.run('INSERT INTO auth_sessions (token_digest, user_id, credential_version, auth_version, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, ?, ?, ?)', [digest, userId, NOW, NOW, expires]);
  return { cookie: `__Host-ltsd-session=${token}`, digest };
}
async function setup(database: MysqlDatabase) {
  const users = [];
  for (const [name, job] of [['作者', 11], ['读者', 9]] as const) {
    const email = `${job}@example.test`;
    const result = await database.run("INSERT INTO auth_users (email, email_normalized, display_name, status, permission_level, created_at, updated_at) VALUES (?, ?, ?, 'PENDING_EMAIL', 0, ?, ?)", [email, email, name, NOW, NOW]);
    await database.run('INSERT INTO ke_characters (aid, cid, nid, user_id, char_name, job_id, bound_at, last_seen_at, created_at, updated_at) VALUES (?, 2, 3, ?, ?, ?, ?, ?, ?, ?)', [result.insertId, result.insertId, name, job, NOW, NOW, NOW, NOW]);
    users.push({ id: result.insertId, ...(await session(database, result.insertId)) });
  }
  const app = new Hono();
  registerKeRoutes(app, bindings(), database, { now: () => NOW, fetch: globalThis.fetch });
  const request = (user: typeof users[number], method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method,
    headers: { cookie: user.cookie, origin: SITE, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, author: users[0]!, reader: users[1]!, request };
}
const personal = (aid: number, extra: Record<string, unknown> = {}) => ({
  aid, cid: 2, nid: 3, name: '<大厅方案>', config_text: 'attackAuto 2\r\n# 原文 ',
  mon_control: 'all 1 0 0\n', pickupitems: 'all 1\n', items_control: 'all 0 0 0\n', timeouts: '',
  sharing: { enabled: true, description: '<script>文本说明</script>' }, ...extra,
});
async function json(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

describe.skipIf(!run)('Shared profile HTTP × real cookie and isolated MySQL', () => {
  it('lets permission-0 unverified accounts publish/browse/like/copy/update/retract without license configuration', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const { author, reader, request } = await setup(database);
      const source = await json(await request(author, 'POST', '/api/v1/ke/profiles', personal(author.id)), 201) as { id: number };
      expect(Object.keys(source)).toEqual(['id']);
      const own = await json(await request(author, 'GET', `/api/v1/ke/profiles/${source.id}`));
      expect(own.sharing).toMatchObject({ status: 'PUBLISHED', description: '<script>文本说明</script>' });
      const id = own.sharing.id;
      const base = `/api/v1/ke/shared-profiles/${id}`;
      const listed = await json(await request(reader, 'GET', '/api/v1/ke/shared-profiles?sort=likes&job_id=11'));
      expect(listed).toMatchObject({ total: 1, page_size: 20, items: [{ title: '<大厅方案>', job_id: 11, like_count: 0, use_count: 0 }] });
      for (const field of ['config_text', 'email', 'aid', 'cid', 'source_profile_id', 'user_id']) expect(listed.items[0]).not.toHaveProperty(field);
      const summary = await json(await request(author, 'GET', `/api/v1/ke/profiles?aid=${author.id}&cid=2&nid=3`));
      expect(summary.profiles[0].sharing.share_code).toBe(own.sharing.share_code);
      const detail = await json(await request(reader, 'GET', `/api/v1/ke/shared-profiles/code/${own.sharing.share_code.toLowerCase().replace('-', '')}`));
      expect(detail.config_text).toBe(own.config_text);
      expect((await json(await request(author, 'PUT', `${base}/like`), 403)).error.code).toBe('KE_SHARED_SELF_LIKE');
      expect(await json(await request(reader, 'PUT', `${base}/like`))).toEqual({ liked: true, like_count: 1 });
      expect(await json(await request(reader, 'PUT', `${base}/like`))).toEqual({ liked: true, like_count: 1 });
      expect(await json(await request(reader, 'DELETE', `${base}/like`))).toEqual({ liked: false, like_count: 0 });
      const copyBody = { aid: reader.id, cid: 2, nid: 3, request_id: UUID };
      const copied = await json(await request(reader, 'POST', `${base}/copy`, copyBody), 201);
      expect(copied).toMatchObject({ name: '<大厅方案>', use_count: 1, duplicate: false });
      expect(await json(await request(reader, 'POST', `${base}/copy`, copyBody))).toEqual({ ...copied, duplicate: true });
      expect((await json(await request(reader, 'POST', `${base}/copy`, { ...copyBody, cid: 999 }), 409)).error.code).toBe('KE_COPY_REQUEST_CONFLICT');
      const savedCopy = await json(await request(reader, 'GET', `/api/v1/ke/profiles/${copied.profile_id}`));
      for (const field of ['config_text', 'mon_control', 'pickupitems', 'items_control', 'timeouts']) expect(savedCopy[field]).toBe(own[field]);
      expect(savedCopy).toMatchObject({ is_active: false, sharing: null });
      const privateSave = await request(author, 'PUT', `/api/v1/ke/profiles/${source.id}`, personal(author.id, { name: '只改个人', sharing: { enabled: false } }));
      expect(privateSave.status).toBe(204);
      expect((await json(await request(reader, 'GET', base))).title).toBe('<大厅方案>');
      expect((await request(author, 'PUT', `/api/v1/ke/profiles/${source.id}`, personal(author.id, { name: '更新共享' }))).status).toBe(204);
      const updated = await json(await request(reader, 'GET', base));
      expect(updated).toMatchObject({ title: '更新共享', use_count: 1, share_code: detail.share_code });
      expect((await json(await request(reader, 'GET', `/api/v1/ke/profiles/${copied.profile_id}`))).name).toBe('<大厅方案>');
      expect((await request(reader, 'DELETE', `/api/v1/ke/profiles/${source.id}/sharing`)).status).toBe(403);
      expect((await request(author, 'DELETE', `/api/v1/ke/profiles/${source.id}/sharing`)).status).toBe(204);
      for (const [method, path, body] of [['GET', base], ['GET', `/api/v1/ke/shared-profiles/code/${detail.share_code}`], ['PUT', `${base}/like`], ['POST', `${base}/copy`, { ...copyBody, request_id: '22222222-2222-4222-8222-222222222222' }]] as const) {
        expect((await json(await request(reader, method, path, body), 404)).error.code).toBe('KE_SHARED_PROFILE_NOT_FOUND');
      }
      expect((await json(await request(reader, 'GET', '/api/v1/ke/shared-profiles'))).total).toBe(0);
      expect((await request(author, 'PUT', `/api/v1/ke/profiles/${source.id}`, personal(author.id))).status).toBe(204);
      expect((await json(await request(reader, 'GET', base))).share_code).toBe(detail.share_code);
      const withdrawPath = `/api/v1/ke/shared-profiles/${id}/withdraw`;
      expect((await request(reader, 'DELETE', withdrawPath)).status).toBe(403);
      expect((await request(author, 'DELETE', withdrawPath)).status).toBe(204);
      expect((await request(author, 'DELETE', withdrawPath)).status).toBe(204);
      expect((await request(reader, 'GET', base)).status).toBe(404);
      expect((await request(author, 'PUT', `/api/v1/ke/profiles/${source.id}`, personal(author.id))).status).toBe(204);
      expect((await request(author, 'DELETE', `/api/v1/ke/profiles/${source.id}`)).status).toBe(204);
      expect((await request(reader, 'GET', base)).status).toBe(404);
      expect((await request(reader, 'GET', `/api/v1/ke/profiles/${copied.profile_id}`)).status).toBe(200);
    });
  }, 120000);

  it('validates query/body, shares rate buckets across sessions, and denies expired/revoked/disabled accounts', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const { app, author, reader, request } = await setup(database);
      for (const query of ['sort=sql', 'page=0', 'page=', 'page=1.5', 'page=9007199254740991', 'job_id=-1', 'job_id=', 'job_id=4294967296']) {
        expect((await json(await request(reader, 'GET', `/api/v1/ke/shared-profiles?${query}`), 400)).error.code).toBe('KE_BAD_REQUEST');
      }
      expect((await request(reader, 'GET', '/api/v1/ke/shared-profiles/code/bad')).status).toBe(400);
      expect((await request(reader, 'GET', '/api/v1/ke/shared-profiles/1e2')).status).toBe(400);
      const source = await json(await request(author, 'POST', '/api/v1/ke/profiles', personal(author.id)), 201);
      const shared = await json(await request(reader, 'GET', '/api/v1/ke/shared-profiles'));
      const base = `/api/v1/ke/shared-profiles/${shared.items[0].id}`;
      const copy = { aid: reader.id, cid: 2, nid: 3, request_id: UUID };
      expect((await request(reader, 'POST', `${base}/copy`, { ...copy, aid: '1' })).status).toBe(400);
      expect((await request(reader, 'POST', `${base}/copy`, copy, { 'content-type': 'text/plain' })).status).toBe(415);
      const oversize = await app.request(`${base}/copy`, { method: 'POST', headers: { origin: SITE, cookie: reader.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...copy, padding: 'x'.repeat(9000) }) });
      expect(oversize.status).toBe(413);
      expect((await request(reader, 'POST', `${base}/copy`, copy)).status).toBe(201);
      await database.run("UPDATE auth_rate_limits SET request_count = 60 WHERE scope = 'hall_copy_account'");
      const secondSession = await session(database, reader.id);
      const throttled = await json(await request({ ...reader, ...secondSession }, 'POST', `${base}/copy`, copy), 429);
      expect(throttled.error.code).toBe('KE_RATE_LIMITED');
      expect(JSON.parse(throttled.error.action).retry_after).toBeGreaterThan(0);
      expect((await json(await request(reader, 'GET', '/api/v1/ke/shared-profiles'))).items[0].use_count).toBe(1);
      expect((await request(author, 'GET', `/api/v1/ke/profiles/${source.id}`)).status).toBe(200);
      const expired = await session(database, reader.id, NOW - 1);
      expect((await request({ ...reader, ...expired }, 'GET', base)).status).toBe(401);
      await database.run('UPDATE auth_sessions SET revoked_at = ? WHERE token_digest = ?', [NOW, reader.digest]);
      expect((await request(reader, 'GET', base)).status).toBe(401);
      await database.run("UPDATE auth_users SET status = 'DISABLED' WHERE id = ?", [reader.id]);
      expect((await request({ ...reader, ...secondSession }, 'GET', base)).status).toBe(401);
    });
  }, 120000);
});
