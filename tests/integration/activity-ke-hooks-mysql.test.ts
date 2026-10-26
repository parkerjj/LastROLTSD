import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, ActivityRecorder } from '../../apps/worker/src/activity/recorder';
import { createOpaqueToken, digestToken } from '../../apps/worker/src/auth/crypto';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import type { AppEnv } from '../../apps/worker/src/env';
import { KE_PERMANENT_MS } from '../../apps/worker/src/ke/entitlements';
import { registerKeRoutes } from '../../apps/worker/src/ke/router';
import { KE_TOKEN_PREFIX, KE_TOKEN_TTL_MS } from '../../apps/worker/src/ke/types';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const run = Boolean(process.env.MYSQL_TEST_URL) || process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const SITE = 'https://lastro.example';
const NOW = 1_800_000_000_000;
const INST_A = '11111111-1111-4111-8111-111111111111';

function bindings(): AppEnv {
  const secret = (n: number) => Buffer.alloc(32, n).toString('base64');
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 524288,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: SITE,
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
    KE_LICENSE_PRIVATE_KEY_v1: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    KE_CORE_KEY: randomBytes(32).toString('base64'),
  } as AppEnv;
}

async function insertUser(database: MysqlDatabase, name: string): Promise<number> {
  const result = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`${name}@example.test`, `${name}@example.test`, name, 'ACTIVE', 1, 1, 1],
  );
  for (const [resource, ref] of [['slots', 'email-verified:slots'], ['module:core', 'email-verified:module:core']] as const) {
    await database.run(
      'INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [result.insertId, resource, 1, 1, 1 + KE_PERMANENT_MS, 'signup', ref, null, 1],
    );
  }
  return result.insertId;
}

async function bearerFor(database: MysqlDatabase, userId: number): Promise<string> {
  const opaque = createOpaqueToken();
  await database.run(
    'INSERT INTO ke_tokens (user_id, token_digest, label, credential_version, auth_version, created_at, last_used_at, expires_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?)',
    [userId, await digestToken(opaque), '测试设备', NOW, NOW, NOW + KE_TOKEN_TTL_MS],
  );
  return `Bearer ${KE_TOKEN_PREFIX}${opaque}`;
}

async function sessionCookieFor(database: MysqlDatabase, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await database.run(
    'INSERT INTO auth_sessions (token_digest, user_id, credential_version, auth_version, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, ?, ?, ?)',
    [await digestToken(token), userId, NOW, NOW, NOW + 100_000],
  );
  return `__Host-ltsd-session=${token}`;
}

const characterBody = (aid: number) => ({ aid, cid: 2000002, nid: 3000003, char_name: 'Poring', base_level: 99, job_level: 50, job_id: 4008, map_name: 'prt_fild08' });

async function harness(database: MysqlDatabase) {
  const entries: ActivityEntry[] = [];
  const heartbeats: ActivityEntry[] = [];
  const capturing: ActivityRecorder = {
    record: async (_request, entry) => { entries.push(entry); },
    recordHeartbeat: async (_request, entry) => { heartbeats.push(entry); },
  };
  const app = new Hono();
  registerKeRoutes(app, bindings(), database, { now: () => NOW, fetch: globalThis.fetch }, capturing);
  const bearerPost = (bearer: string, path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const webPost = (cookie: string, path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { cookie, origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const anonymousPost = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { entries, heartbeats, bearerPost, webPost, anonymousPost };
}

describe.skipIf(!run)('account activity hooks for KE routes', () => {
  it('records KE_BIND on success and KE_BIND FAILURE when another account owns the character', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database);
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      const aliceBearer = await bearerFor(database, alice);
      const bobBearer = await bearerFor(database, bob);

      const bound = await h.bearerPost(aliceBearer, '/api/v1/ke/instances/bind', { instance_id: INST_A, ...characterBody(1000001) });
      expect(bound.status).toBe(200);
      expect(h.entries).toEqual([{ userId: String(alice), event: 'KE_BIND', character: { aid: 1000001, cid: 2000002, nid: 3000003 }, ref: INST_A, requestId: expect.any(String) }]);

      h.entries.length = 0;
      const stolen = await h.bearerPost(bobBearer, '/api/v1/ke/instances/bind', { instance_id: '22222222-2222-4222-8222-222222222222', ...characterBody(1000001) });
      expect(stolen.status).toBe(409);
      expect(((await stolen.json()) as { error: { code: string } }).error.code).toBe('KE_CHARACTER_BOUND');
      expect(h.entries).toEqual([{
        userId: String(bob), event: 'KE_BIND', result: 'FAILURE', character: { aid: 1000001, cid: 2000002, nid: 3000003 },
        ref: '22222222-2222-4222-8222-222222222222', requestId: expect.any(String),
      }]);
    });
  });

  it('records KE_START on success and KE_START FAILURE once the character belongs to someone else', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database);
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      const aliceBearer = await bearerFor(database, alice);
      const character = { aid: 1000001, cid: 2000002, nid: 3000003 };
      expect((await h.bearerPost(aliceBearer, '/api/v1/ke/instances/bind', { instance_id: INST_A, ...characterBody(1000001) })).status).toBe(200);
      h.entries.length = 0;

      const started = await h.bearerPost(aliceBearer, `/api/v1/ke/instances/${INST_A}/start`, characterBody(1000001));
      expect(started.status).toBe(200);
      expect(h.entries).toEqual([{ userId: String(alice), event: 'KE_START', character, ref: INST_A, requestId: expect.any(String) }]);

      h.entries.length = 0;
      await database.run('UPDATE ke_characters SET user_id = ?, bound_at = ? WHERE aid = ?', [bob, NOW, 1000001]);
      const rejected = await h.bearerPost(aliceBearer, `/api/v1/ke/instances/${INST_A}/start`, characterBody(1000001));
      expect(rejected.status).toBe(409);
      expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('KE_CHARACTER_BOUND');
      expect(h.entries).toEqual([{ userId: String(alice), event: 'KE_START', result: 'FAILURE', character, ref: INST_A, requestId: expect.any(String) }]);
    });
  });

  it('hands every successful heartbeat to recordHeartbeat with the instance and character', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database);
      const alice = await insertUser(database, 'alice');
      const aliceBearer = await bearerFor(database, alice);
      await h.bearerPost(aliceBearer, '/api/v1/ke/instances/bind', { instance_id: INST_A, ...characterBody(1000001) });
      expect((await h.bearerPost(aliceBearer, `/api/v1/ke/instances/${INST_A}/start`, characterBody(1000001))).status).toBe(200);
      h.entries.length = 0;

      const beat = await h.bearerPost(aliceBearer, `/api/v1/ke/instances/${INST_A}/heartbeat`, { ...characterBody(1000001), ts: Math.floor(NOW / 1000) });
      expect(beat.status).toBe(200);
      expect(h.heartbeats).toEqual([{ userId: String(alice), event: 'KE_HEARTBEAT', character: { aid: 1000001, cid: 2000002, nid: 3000003 }, ref: INST_A, requestId: expect.any(String) }]);
      expect(h.entries).toEqual([]);
    });
  });

  it('records KE_DEVICE_APPROVE only for approvals and KE_DEVICE_TOKEN for the approver on redemption', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const h = await harness(database);
      const alice = await insertUser(database, 'alice');
      const cookie = await sessionCookieFor(database, alice);

      const denied = await (await h.anonymousPost('/api/v1/ke/device/code', { label: '被拒设备' })).json() as { user_code: string };
      expect((await h.webPost(cookie, '/api/v1/ke/device/decision', { user_code: denied.user_code, approve: false })).status).toBe(204);
      expect(h.entries).toEqual([]);

      const issued = await (await h.anonymousPost('/api/v1/ke/device/code', { label: '电脑 A' })).json() as { device_code: string; user_code: string };
      expect((await h.webPost(cookie, '/api/v1/ke/device/decision', { user_code: issued.user_code, approve: true })).status).toBe(204);
      expect(h.entries).toEqual([{ userId: String(alice), event: 'KE_DEVICE_APPROVE', requestId: expect.any(String) }]);

      h.entries.length = 0;
      const polled = await h.anonymousPost('/api/v1/ke/device/token', { device_code: issued.device_code });
      expect(polled.status).toBe(200);
      expect(((await polled.json()) as { status: string }).status).toBe('approved');
      expect(h.entries).toEqual([{ userId: String(alice), event: 'KE_DEVICE_TOKEN', requestId: expect.any(String) }]);
    });
  });
});
