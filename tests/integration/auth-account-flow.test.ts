import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAuthRepository, type NewAuthUser } from '../../apps/worker/src/auth/repository';
import { resolveAuthConfig } from '../../apps/worker/src/auth/config';
import { createOpaqueToken, digestToken, openMailPayload, sealMailPayload } from '../../apps/worker/src/auth/crypto';
import { prepareActionMail, preparePasswordChangedMail } from '../../apps/worker/src/auth/mail';
import { registerAuthRoutes } from '../../apps/worker/src/auth/router';
import type { AuthBindings, AuthRateLimitRule, PasswordMaterial } from '../../apps/worker/src/auth/types';
import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../../apps/worker/src/db/mysql-client';
import type { AppEnv } from '../../apps/worker/src/env';
import { consumeAuthRateLimit } from '../../apps/worker/src/auth/rate-limit';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;
const AUTH_TABLES = [
  'auth_action_tokens', 'auth_avatars', 'auth_credentials', 'auth_mail_outbox',
  'auth_rate_limits', 'auth_security_events', 'auth_sessions', 'auth_users',
];
const FIRST_USER: NewAuthUser = {
  email: 'first@example.test', emailNormalized: 'first@example.test', displayName: 'First', createdAt: 1_800_000_000_000,
};
const CREDENTIAL: PasswordMaterial = {
  scheme: 'hmac-sha256-v1', salt: new Uint8Array(16), digest: new Uint8Array(32), keyVersion: 'v1',
};

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
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: testSecret(1), AUTH_CSRF_SECRET: testSecret(2),
    AUTH_RATE_SECRET: testSecret(3), AUTH_MAIL_PAYLOAD_SECRET: testSecret(4),
  };
}

function testAuthConfig() {
  const env = testAuthBindings();
  return resolveAuthConfig(env);
}

function failOutboxInserts(database: MysqlDatabase): MysqlDatabase {
  const wrap = (current: MysqlDatabase): MysqlDatabase => ({
    all: <T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]) => current.all<T>(sql, values),
    first: <T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]) => current.first<T>(sql, values),
    run: async (sql: string, values?: readonly unknown[]) => {
      if (/^\s*INSERT INTO auth_mail_outbox\b/iu.test(sql)) {
        const duplicate = Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY', errno: 1062 });
        throw new MysqlDatabaseError(duplicate, 'insert:auth_mail_outbox');
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

describe('real MySQL account schema and repository', () => {
  it.skipIf(!runMysqlTests)('registers a pending account once and rolls back non-user unique failures', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      let now = Date.UTC(2026, 9, 12, 12);
      let fetchCalls = 0;
      const runtime = {
        now: () => now,
        fetch: (async () => {
          fetchCalls += 1;
          return new Response('{}', { status: 200 });
        }) as typeof globalThis.fetch,
      };
      const app = new Hono();
      registerAuthRoutes(app, testAuthBindings(), database, runtime);

      const csrfResponse = await app.request('/api/v1/auth/csrf', {
        headers: { origin: 'https://lastro.example' },
      });
      expect(csrfResponse.status).toBe(200);
      const csrf = await csrfResponse.json() as { csrf_token: string };
      const csrfCookie = csrfResponse.headers.get('set-cookie')?.split(';', 1)[0];
      if (!csrfCookie) throw new Error('expected anonymous CSRF cookie');
      const headers = {
        origin: 'https://lastro.example',
        'content-type': 'application/json',
        'x-csrf-token': csrf.csrf_token,
        cookie: csrfCookie,
      };
      const submit = (email: string, password: string) => app.request('/api/v1/auth/register', {
        method: 'POST', headers,
        body: JSON.stringify({ email, password, password_confirmation: password, display_name: 'Pilot' }),
      });

      const first = await submit('Pilot@example.test', '12345');
      expect(first.status).toBe(202);
      expect(first.headers.get('set-cookie')).toBeNull();
      const firstBody = await first.json();
      expect(firstBody).toEqual({
        accepted: true,
        mail_availability: { code: 'AVAILABLE', retry_at: null },
      });
      const user = await database.first<MysqlRow>(`SELECT CAST(id AS CHAR) AS id, email, status
        FROM auth_users WHERE email_normalized = ?`, ['pilot@example.test']);
      expect(user).toMatchObject({ id: '10000', email: 'Pilot@example.test', status: 'PENDING_EMAIL' });
      const credential = await database.first<MysqlRow>('SELECT digest FROM auth_credentials WHERE user_id = ?', [user?.id]);
      const action = await database.first<MysqlRow>(`SELECT CAST(user_id AS CHAR) AS user_id, purpose
        FROM auth_action_tokens WHERE user_id = ?`, [user?.id]);
      const mailJob = await database.first<MysqlRow>(`SELECT CAST(user_id AS CHAR) AS user_id, purpose, state
        FROM auth_mail_outbox WHERE user_id = ?`, [user?.id]);
      expect(action).toEqual({ user_id: user?.id, purpose: 'VERIFY_EMAIL' });
      expect(mailJob).toEqual({ user_id: user?.id, purpose: 'VERIFY_EMAIL', state: 'PENDING' });

      now += 60_001;
      const duplicate = await submit('pilot@example.test', 'other');
      expect(duplicate.status).toBe(202);
      expect(duplicate.headers.get('set-cookie')).toBeNull();
      expect(await duplicate.json()).toEqual(firstBody);
      expect(await database.first<MysqlRow>('SELECT digest FROM auth_credentials WHERE user_id = ?', [user?.id]))
        .toEqual(credential);
      expect(await database.first<MysqlRow>('SELECT COUNT(*) AS count FROM auth_users WHERE email_normalized = ?', ['pilot@example.test']))
        .toMatchObject({ count: 1 });
      expect(await database.first<MysqlRow>('SELECT COUNT(*) AS count FROM auth_mail_outbox WHERE user_id = ?', [user?.id]))
        .toMatchObject({ count: 1 });
      expect(fetchCalls).toBe(0);

      const failingApp = new Hono();
      registerAuthRoutes(failingApp, testAuthBindings(), failOutboxInserts(database), runtime);
      const failingCsrfResponse = await failingApp.request('/api/v1/auth/csrf', {
        headers: { origin: 'https://lastro.example' },
      });
      const failingCsrf = await failingCsrfResponse.json() as { csrf_token: string };
      const failingCookie = failingCsrfResponse.headers.get('set-cookie')?.split(';', 1)[0];
      if (!failingCookie) throw new Error('expected anonymous CSRF cookie for rollback request');
      const rolledBack = await failingApp.request('/api/v1/auth/register', {
        method: 'POST',
        headers: {
          origin: 'https://lastro.example', 'content-type': 'application/json',
          'x-csrf-token': failingCsrf.csrf_token, cookie: failingCookie,
        },
        body: JSON.stringify({
          email: 'rollback@example.test', password: '12345', password_confirmation: '12345', display_name: 'Rollback',
        }),
      });
      expect(rolledBack.status).toBe(503);
      expect(await database.first<MysqlRow>('SELECT id FROM auth_users WHERE email_normalized = ?', ['rollback@example.test']))
        .toBeNull();
      expect(await database.first<MysqlRow>('SELECT COUNT(*) AS count FROM auth_security_events WHERE event = ?', ['REGISTER']))
        .toMatchObject({ count: 1 });
      expect(fetchCalls).toBe(0);
    });
  }, 120_000);

  it.skipIf(!runMysqlTests)('claims, reserves and finishes with lease CAS, shared budget and late old-cycle quota isolation', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.UTC(2026, 9, 9, 10);
      const dayMilliseconds = 86_400_000;
      const repository = createAuthRepository(database, { mailDailyLimit: 3, mailMonthlyLimit: 20 });
      const config = testAuthConfig();
      const userId = await repository.transaction(async (tx) => {
        const user = await tx.insertUser({
          email: 'task5@example.test', emailNormalized: 'task5@example.test', displayName: 'Task Five', createdAt: now,
        });
        await tx.insertCredential(user.id, CREDENTIAL);
        return user.id;
      });
      const jobs = await Promise.all(['001', '002', '003'].map((suffix) => preparePasswordChangedMail({
        mailId: `123e4567-e89b-12d3-a456-426614174${suffix}`,
        userId, email: 'task5@example.test', displayName: 'Task Five', createdAt: now,
      }, config)));
      await repository.transaction(async (tx) => {
        await tx.lockUser(userId);
        for (const job of jobs) await tx.insertMailJob(job);
      });

      const first = await repository.claimOneMail(now, 30_000);
      const second = await repository.claimOneMail(now, 30_000);
      const third = await repository.claimOneMail(now, 30_000);
      expect([first?.id, second?.id, third?.id]).toEqual(jobs.map((job) => job.id));
      if (!first || !second || !third) throw new Error('expected three claimed jobs');

      const frozen = await sealMailPayload(JSON.stringify({
        from: 'LTSD <auth@example.test>', to: ['task5@example.test'], subject: '安全通知', html: '<p>通知</p>', text: '通知',
      }), { mailId: first.id, purpose: 'PASSWORD_CHANGED' }, config);
      expect(await repository.freezeMailPayload(first.id, first.leaseId, first, frozen, now)).toBe(true);
      expect(await repository.reserveMailAttempt(first.id, first.leaseId, () => now)).toMatchObject({ status: 'reserved' });
      expect(await repository.finishMail(first.id, first.leaseId, {
        status: 'retry', errorCode: 'MAIL_RATE_LIMIT', nextAttemptAt: now + 1_000, observedAt: now + 1,
      })).toBe(true);

      const reclaimed = await repository.claimOneMail(now + 2_000, 30_000);
      expect(reclaimed?.id).toBe(first.id);
      if (!reclaimed) throw new Error('expected the retry job to be reclaimed');
      expect(await openMailPayload(reclaimed, { mailId: reclaimed.id, purpose: reclaimed.purpose }, config)).toBe(
        JSON.stringify({ from: 'LTSD <auth@example.test>', to: ['task5@example.test'], subject: '安全通知', html: '<p>通知</p>', text: '通知' }),
      );
      expect(await repository.finishMail(first.id, first.leaseId, {
        status: 'sent', providerMessageId: 'stale-provider-id', observedAt: now + 2_001,
      })).toBe(false);

      expect(await repository.reserveMailAttempt(reclaimed.id, reclaimed.leaseId, () => now + 2_000)).toMatchObject({ status: 'reserved' });
      expect(await repository.reserveMailAttempt(second.id, second.leaseId, () => now + 3_000)).toMatchObject({ status: 'reserved' });
      expect(await repository.reserveMailAttempt(third.id, third.leaseId, () => now + 4_000)).toEqual({ status: 'quota' });
      expect(await repository.finishMail(reclaimed.id, reclaimed.leaseId, {
        status: 'sent', providerMessageId: 'provider-accepted-id', observedAt: now + 5_000,
      })).toBe(true);
      await expect(repository.readMailAvailability(now + 5_000)).resolves.toEqual({
        code: 'MAIL_DAILY_QUOTA', retry_at: Date.UTC(2026, 9, 10),
      });
      const terminalQuota = await database.first<MysqlRow>(`SELECT state, last_error_code, payload_ciphertext
        FROM auth_mail_outbox WHERE id = ?`, [third.id]);
      expect(terminalQuota).toMatchObject({ state: 'FAILED', last_error_code: 'MAIL_DAILY_QUOTA', payload_ciphertext: null });
      await expect(database.first<MysqlRow>('SELECT status FROM auth_users WHERE id = ?', [userId])).resolves.toMatchObject({ status: 'PENDING_EMAIL' });

      const oldDayStart = Date.UTC(2026, 9, 10);
      const boundary = Date.UTC(2026, 9, 10, 23, 59, 59);
      const nextDay = Date.UTC(2026, 9, 11);
      const lateJob = await preparePasswordChangedMail({
        mailId: '123e4567-e89b-12d3-a456-426614174004',
        userId, email: 'task5@example.test', displayName: 'Task Five', createdAt: boundary,
      }, config);
      await repository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.insertMailJob(lateJob);
      });
      const lateClaim = await repository.claimOneMail(boundary, 1_000);
      expect(lateClaim?.id).toBe(lateJob.id);
      if (!lateClaim) throw new Error('expected the boundary job to be claimed');
      const lateAttempt = await repository.reserveMailAttempt(lateClaim.id, lateClaim.leaseId, () => boundary);
      expect(lateAttempt).toMatchObject({ status: 'reserved', attempt: {
        reservedAt: boundary, dayBucketStart: oldDayStart, monthBucketStart: Date.UTC(2026, 9, 1),
      } });
      if (lateAttempt.status !== 'reserved') throw new Error('expected boundary reservation');
      const nextPeriodClaim = await repository.claimOneMail(nextDay + 1_000, 30_000);
      expect(nextPeriodClaim?.id).toBe(lateJob.id);
      if (!nextPeriodClaim) throw new Error('expected the expired provider lease to be reclaimed');
      await expect(repository.recordProviderQuota(lateClaim.id, lateClaim.leaseId, 'daily', lateAttempt.attempt, nextDay + 2_000))
        .resolves.toEqual({ pauseRecorded: true, jobUpdated: false });
      const lateJobState = await database.first<MysqlRow>(`SELECT state, lease_id, payload_ciphertext
        FROM auth_mail_outbox WHERE id = ?`, [lateJob.id]);
      expect(lateJobState).toMatchObject({ state: 'CLAIMED', lease_id: nextPeriodClaim.leaseId });
      expect(lateJobState?.payload_ciphertext).not.toBeNull();
      expect(await repository.finishMail(lateJob.id, nextPeriodClaim.leaseId, {
        status: 'failed', errorCode: 'MAIL_TEST_DONE', observedAt: nextDay + 3_000,
      })).toBe(true);
      await expect(repository.readMailAvailability(nextDay + 3_000)).resolves.toEqual({ code: 'AVAILABLE', retry_at: null });
      const oldPause = await database.first<MysqlRow>(`SELECT next_allowed_at FROM auth_rate_limits
        WHERE scope = ? AND key_digest = ? AND bucket_start = ?`, ['mail-provider-daily', new Uint8Array(32), oldDayStart]);
      expect(Number(oldPause?.next_allowed_at)).toBe(nextDay);
      expect(oldDayStart + dayMilliseconds).toBe(nextDay);

      const retryRepository = createAuthRepository(database, { mailDailyLimit: 10, mailMonthlyLimit: 20 });
      const crashCreatedAt = nextDay + 2_000;
      const crashJob = await preparePasswordChangedMail({
        mailId: '123e4567-e89b-12d3-a456-426614174005',
        userId, email: 'task5@example.test', displayName: 'Task Five', createdAt: crashCreatedAt,
      }, config);
      await retryRepository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.insertMailJob(crashJob);
      });
      const readyCreatedAt = crashCreatedAt + 1;
      const readyExpiresAt = readyCreatedAt + 30 * 60 * 1000;
      const readyToken = createOpaqueToken();
      const readyActionDigest = await digestToken(readyToken);
      const readyJob = await prepareActionMail({
        mailId: '123e4567-e89b-12d3-a456-426614174007', actionDigest: readyActionDigest, userId,
        email: 'task5@example.test', displayName: 'Task Five', token: readyToken,
        purpose: 'RESET_PASSWORD', createdAt: readyCreatedAt, expiresAt: readyExpiresAt,
      }, config);
      await retryRepository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.insertAction({
          tokenDigest: readyActionDigest, userId, purpose: 'RESET_PASSWORD', emailSnapshot: 'task5@example.test',
          credentialVersion: 1, createdAt: readyCreatedAt, expiresAt: readyExpiresAt,
        });
        await tx.insertMailJob(readyJob);
      });
      let crashAt = crashCreatedAt;
      let stableCiphertext: string | null = null;
      let firstReservedAt: number | null = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const claim = await retryRepository.claimOneMail(crashAt, 30_000);
        expect(claim?.id).toBe(crashJob.id);
        if (!claim) throw new Error('expected the crashed task to be reclaimed');
        if (attempt === 0) {
          const crashBody = await sealMailPayload(JSON.stringify({
            from: 'LTSD <auth@example.test>', to: ['task5@example.test'], subject: '安全通知', html: '<p>通知</p>', text: '通知',
          }), { mailId: claim.id, purpose: 'PASSWORD_CHANGED' }, config);
          expect(await retryRepository.freezeMailPayload(claim.id, claim.leaseId, claim, crashBody, crashAt)).toBe(true);
          stableCiphertext = crashBody.payloadCiphertext;
        } else {
          expect(claim.payloadCiphertext).toBe(stableCiphertext);
        }
        const reservation = await retryRepository.reserveMailAttempt(claim.id, claim.leaseId, () => crashAt);
        expect(reservation.status).toBe('reserved');
        if (reservation.status !== 'reserved') throw new Error('expected crash attempt reservation');
        if (firstReservedAt === null) firstReservedAt = reservation.attempt.reservedAt;
        crashAt += 31_000;
      }
      const readyClaim = await retryRepository.claimOneMail(crashAt, 30_000);
      expect(readyClaim?.id).toBe(readyJob.id);
      if (!readyClaim) throw new Error('expected ready priority-one mail after exhausted priority-zero lease');
      expect(await retryRepository.finishMail(readyClaim.id, readyClaim.leaseId, {
        status: 'failed', errorCode: 'MAIL_TEST_DONE', observedAt: crashAt + 1,
      })).toBe(true);
      const crashState = await database.first<MysqlRow>(`SELECT state, attempt_count, first_attempt_at, payload_ciphertext
        FROM auth_mail_outbox WHERE id = ?`, [crashJob.id]);
      expect(crashState).toMatchObject({ state: 'CLAIMED' });
      expect(crashState?.payload_ciphertext).not.toBeNull();
      expect(Number(crashState?.attempt_count)).toBe(4);
      expect(Number(crashState?.first_attempt_at)).toBe(firstReservedAt);
      const crashBudget = await database.first<MysqlRow>(`SELECT request_count FROM auth_rate_limits
        WHERE scope = ? AND key_digest = ? AND bucket_start = ?`, ['mail-budget-daily', new Uint8Array(32), nextDay]);
      expect(Number(crashBudget?.request_count)).toBe(4);

      const actionCreatedAt = Date.UTC(2026, 10, 1, 12);
      const actionExpiresAt = actionCreatedAt + dayMilliseconds;
      const actionToken = createOpaqueToken();
      const actionDigest = await digestToken(actionToken);
      const invalidatedActionJob = await prepareActionMail({
        mailId: '123e4567-e89b-12d3-a456-426614174006', actionDigest, userId,
        email: 'task5@example.test', displayName: 'Task Five', token: actionToken,
        purpose: 'RESET_PASSWORD', createdAt: actionCreatedAt, expiresAt: actionExpiresAt,
      }, config);
      await retryRepository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.insertAction({
          tokenDigest: actionDigest, userId, purpose: 'RESET_PASSWORD', emailSnapshot: 'task5@example.test',
          credentialVersion: 1, createdAt: actionCreatedAt, expiresAt: actionExpiresAt,
        });
        await tx.insertMailJob(invalidatedActionJob);
      });
      const invalidatedActionClaim = await retryRepository.claimOneMail(actionCreatedAt, 30_000);
      expect(invalidatedActionClaim?.id).toBe(invalidatedActionJob.id);
      if (!invalidatedActionClaim) throw new Error('expected the action mail to be claimed');
      await retryRepository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.saveCredential(userId, { ...CREDENTIAL, digest: new Uint8Array(32).fill(77) }, 2, actionCreatedAt + 1);
      });
      await expect(retryRepository.reserveMailAttempt(
        invalidatedActionClaim.id, invalidatedActionClaim.leaseId, () => actionCreatedAt + 2,
      )).resolves.toEqual({ status: 'exhausted' });
      const invalidatedActionState = await database.first<MysqlRow>(`SELECT state, attempt_count, last_error_code, payload_ciphertext
        FROM auth_mail_outbox WHERE id = ?`, [invalidatedActionJob.id]);
      expect(invalidatedActionState).toMatchObject({
        state: 'CANCELLED', attempt_count: 0, last_error_code: 'MAIL_AUTHORIZATION_INVALID', payload_ciphertext: null,
      });
      await expect(retryRepository.readMailAvailability(actionCreatedAt + 2)).resolves.toEqual({ code: 'AVAILABLE', retry_at: null });
    });
  }, 120_000);

  it.skipIf(!runMysqlTests)('returns the live session expiry and renews without shortening or oversaving activity', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const repository = createAuthRepository(database);
      const createdAt = Date.UTC(2026, 9, 12, 12);
      const expiresAt = createdAt + 30 * 24 * 60 * 60 * 1000;
      const refreshAt = createdAt + 60 * 60 * 1000;
      const userId = await repository.transaction(async (tx) => {
        const user = await tx.insertUser({
          email: 'session@example.test', emailNormalized: 'session@example.test', displayName: 'Session', createdAt,
        });
        await tx.insertCredential(user.id, CREDENTIAL);
        return user.id;
      });
      const tokenDigest = new Uint8Array(32).fill(23);

      await repository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.insertSession({
          tokenDigest, userId, credentialVersion: 1, authVersion: 1,
          createdAt, lastSeenAt: createdAt, expiresAt,
        });
        await tx.appendEvent({
          userId, event: 'LOGIN', requestId: null, result: 'SUCCESS', reason: null, createdAt,
        });
      });

      const identity = await repository.readIdentity(tokenDigest, refreshAt);
      expect.soft(identity).toMatchObject({ expiresAt });
      await repository.transaction(async (tx) => {
        await tx.lockUser(userId);
        await tx.readSessionForUpdate(tokenDigest);
        await tx.renewSession(tokenDigest, expiresAt - 1, refreshAt);
      });

      const stored = await database.first<MysqlRow>(`SELECT expires_at, last_seen_at
        FROM auth_sessions WHERE token_digest = ?`, [tokenDigest]);
      expect.soft({ expiresAt: Number(stored?.expires_at), lastSeenAt: Number(stored?.last_seen_at) }).toEqual({
        expiresAt, lastSeenAt: createdAt,
      });

      await database.run('UPDATE auth_users SET status = ? WHERE id = ?', ['ACTIVE', userId]);
      const inconsistentIdentity = await repository.readIdentity(tokenDigest, refreshAt);
      expect.soft(inconsistentIdentity).toBeNull();

      await database.run('UPDATE auth_users SET email_verified_at = ? WHERE id = ?', [refreshAt, userId]);
      const activeIdentity = await repository.readIdentity(tokenDigest, refreshAt);
      expect.soft(activeIdentity).toMatchObject({ authVersion: 1, expiresAt });
      await repository.transaction(async (tx) => {
        await tx.lockUser(userId);
        const logoutAllAt = refreshAt + 1;
        await tx.bumpAuthVersion(userId, logoutAllAt);
        await tx.appendEvent({
          userId, event: 'LOGOUT_ALL', requestId: null, result: 'SUCCESS', reason: null, createdAt: logoutAllAt,
        });
      });
      await expect(repository.readIdentity(tokenDigest, refreshAt + 1)).resolves.toBeNull();
      const securityEvents = await database.all<MysqlRow>(
        'SELECT `event`, request_id, result, reason, created_at FROM auth_security_events WHERE user_id = ? ORDER BY id',
        [userId],
      );
      expect(securityEvents.map((event) => ({
        event: event.event, request_id: event.request_id, result: event.result,
        reason: event.reason, created_at: Number(event.created_at),
      }))).toEqual([
        { event: 'LOGIN', request_id: null, result: 'SUCCESS', reason: null, created_at: createdAt },
        { event: 'LOGOUT_ALL', request_id: null, result: 'SUCCESS', reason: null, created_at: refreshAt + 1 },
      ]);
    });
  }, 120_000);

  it.skipIf(!runMysqlTests)('preserves the market schema and enforces account IDs, uniqueness, rollback, and mail quotas', async () => {
    await withAuthTestDatabase(async ({ database, createDatabase }) => {
      const server = await database.first('SELECT VERSION() AS version');
      expect(String(server?.version)).toMatch(/^8\.4\.5(?:[-+]|$)/u);

      const tableRows = await database.all<MysqlRow>(`SELECT TABLE_NAME AS table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN (${AUTH_TABLES.map(() => '?').join(', ')})`, AUTH_TABLES);
      expect(tableRows.map((row) => String(row.table_name)).sort()).toEqual([...AUTH_TABLES].sort());

      const legacyNames = ['market_sources', 'shops', 'listings', 'listing_events', 'guestbook_entries', 'item_catalog'];
      const legacyTables = await database.all<MysqlRow>(`SELECT TABLE_NAME AS table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN (${legacyNames.map(() => '?').join(', ')})`, legacyNames);
      expect(legacyTables.map((row) => String(row.table_name)).sort()).toEqual([...legacyNames].sort());

      const uniqueEmail = await database.first('SELECT COUNT(*) AS row_count FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? AND column_name = ? AND non_unique = 0', [
        'auth_users', 'uq_auth_users_email_normalized', 'email_normalized',
      ]);
      expect(Number(uniqueEmail?.row_count)).toBe(1);
      const foreignKeys = await database.first(`SELECT COUNT(*) AS row_count
        FROM information_schema.table_constraints
        WHERE constraint_schema = DATABASE() AND constraint_type = 'FOREIGN KEY'
          AND table_name IN (${AUTH_TABLES.map(() => '?').join(', ')})`, AUTH_TABLES);
      expect(Number(foreignKeys?.row_count)).toBe(6);

      const avatarColumn = await database.first('SELECT DATA_TYPE AS data_type, CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', ['auth_avatars', 'avatar_base64']);
      expect(avatarColumn).toMatchObject({ data_type: 'text', character_set_name: 'ascii', collation_name: 'ascii_bin' });

      const repository = createAuthRepository(database);
      const firstId = await repository.transaction(async (tx) => {
        const user = await tx.insertUser(FIRST_USER);
        await tx.insertCredential(user.id, CREDENTIAL);
        return user.id;
      });
      expect(firstId).toBe('10000');
      await expect(repository.readCredentialByEmail(FIRST_USER.emailNormalized)).resolves.toMatchObject({ userId: '10000' });

      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(firstId);
        expect(user?.id).toBe(firstId);
        await tx.saveAvatar(firstId, 'QUJD', FIRST_USER.createdAt + 1);
      });
      await expect(repository.readAvatar(firstId)).resolves.toEqual({ base64: 'QUJD', version: 1 });

      await database.run('DELETE FROM auth_avatars WHERE user_id = ?', ['10000']);
      await database.run('INSERT INTO auth_avatars (user_id, avatar_base64, updated_at) VALUES (?, ?, ?)', ['10000', 'A'.repeat(43_692), FIRST_USER.createdAt]);
      await database.run('DELETE FROM auth_avatars WHERE user_id = ?', ['10000']);
      await expect(database.run('INSERT INTO auth_avatars (user_id, avatar_base64, updated_at) VALUES (?, ?, ?)', [
        '10000', 'A'.repeat(43_693), FIRST_USER.createdAt,
      ])).rejects.toThrow();

      const concurrentUser: NewAuthUser = {
        email: 'race@example.test', emailNormalized: 'race@example.test', displayName: 'Race', createdAt: FIRST_USER.createdAt + 1,
      };
      const secondDatabase = createDatabase();
      const secondRepository = createAuthRepository(secondDatabase);
      const connectionIds = await Promise.all([
        database.first('SELECT CONNECTION_ID() AS connection_id'),
        secondDatabase.first('SELECT CONNECTION_ID() AS connection_id'),
      ]);
      expect(String(connectionIds[0]?.connection_id)).not.toBe(String(connectionIds[1]?.connection_id));
      const createRacingUser = (selectedRepository: typeof repository) => selectedRepository.transaction(async (tx) => {
        const user = await tx.insertUser(concurrentUser);
        await tx.insertCredential(user.id, CREDENTIAL);
        return user.id;
      });
      const race = await Promise.allSettled([createRacingUser(repository), createRacingUser(secondRepository)]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const raceCounts = await database.first(`SELECT
          (SELECT COUNT(*) FROM auth_users WHERE email_normalized = ?) AS user_count,
          (SELECT COUNT(*) FROM auth_credentials AS c INNER JOIN auth_users AS u ON u.id = c.user_id WHERE u.email_normalized = ?) AS credential_count`, [
        concurrentUser.emailNormalized, concurrentUser.emailNormalized,
      ]);
      expect(Number(raceCounts?.user_count)).toBe(1);
      expect(Number(raceCounts?.credential_count)).toBe(1);

      const rollbackUser = { ...concurrentUser, email: 'rollback@example.test', emailNormalized: 'rollback@example.test' };
      await expect(repository.transaction(async (tx) => {
        const user = await tx.insertUser(rollbackUser);
        await tx.insertCredential(user.id, CREDENTIAL);
        throw new Error('force auth transaction rollback');
      })).rejects.toThrow('force auth transaction rollback');
      const rollbackCounts = await database.first(`SELECT
          (SELECT COUNT(*) FROM auth_users WHERE email_normalized = ?) AS user_count,
          (SELECT COUNT(*) FROM auth_credentials AS c INNER JOIN auth_users AS u ON u.id = c.user_id WHERE u.email_normalized = ?) AS credential_count`, [
        rollbackUser.emailNormalized, rollbackUser.emailNormalized,
      ]);
      expect(Number(rollbackCounts?.user_count)).toBe(0);
      expect(Number(rollbackCounts?.credential_count)).toBe(0);

      await database.run('ALTER TABLE auth_users AUTO_INCREMENT = 9007199254740993');
      const largeUser = { ...concurrentUser, email: 'large@example.test', emailNormalized: 'large@example.test' };
      const largeId = await repository.transaction(async (tx) => (await tx.insertUser(largeUser)).id);
      expect(largeId).toBe('9007199254740993');

      const now = Date.UTC(2026, 9, 12, 12);
      const dayStart = Date.UTC(2026, 9, 12);
      const monthStart = Date.UTC(2026, 9, 1);
      const nextDay = dayStart + 86_400_000;
      const nextMonth = Date.UTC(2026, 10, 1);
      const zeroDigest = new Uint8Array(32);
      await database.run(`INSERT INTO auth_rate_limits
          (scope, key_digest, bucket_start, request_count, next_allowed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`, ['mail-budget-daily', zeroDigest, dayStart, 100, nextDay, nextDay + 86_400_000]);
      await database.run(`INSERT INTO auth_rate_limits
          (scope, key_digest, bucket_start, request_count, next_allowed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`, ['mail-budget-monthly', zeroDigest, monthStart, 3_000, nextMonth, nextMonth + 86_400_000]);
      await expect(repository.readMailAvailability(now)).resolves.toEqual({ code: 'MAIL_MONTHLY_QUOTA', retry_at: null });
      await database.run('DELETE FROM auth_rate_limits WHERE scope = ? AND bucket_start = ? AND key_digest = ?', ['mail-budget-monthly', monthStart, zeroDigest]);
      await expect(repository.readMailAvailability(now)).resolves.toEqual({ code: 'MAIL_DAILY_QUOTA', retry_at: nextDay });

      const rollbackRule: AuthRateLimitRule = {
        kind: 'window', scope: 'test_rollback', keyDigest: new Uint8Array(32).fill(11), limit: 1, windowMs: 60_000,
      };
      await expect(repository.transaction(async () => {
        await expect(consumeAuthRateLimit(repository, [rollbackRule], () => Date.UTC(2026, 9, 12, 13)))
          .resolves.toEqual({ allowed: true, retryAfter: 0 });
        throw new Error('force outer business rollback');
      })).rejects.toThrow('force outer business rollback');
      await expect(consumeAuthRateLimit(repository, [rollbackRule], () => Date.UTC(2026, 9, 12, 13) + 1))
        .resolves.toEqual({ allowed: false, retryAfter: 60 });

      const concurrentRule: AuthRateLimitRule = {
        kind: 'window', scope: 'test_concurrent', keyDigest: new Uint8Array(32).fill(12), limit: 1, windowMs: 60_000,
      };
      const concurrentLimits = await Promise.all([
        consumeAuthRateLimit(repository, [concurrentRule], () => Date.UTC(2026, 9, 12, 14)),
        consumeAuthRateLimit(secondRepository, [concurrentRule], () => Date.UTC(2026, 9, 12, 14)),
      ]);
      expect(concurrentLimits.map((result) => result.allowed).sort()).toEqual([false, true]);

      const boundaryStart = Date.UTC(2026, 9, 12, 16, 0, 59, 999);
      const boundaryBucket = Math.floor(boundaryStart / 60_000) * 60_000;
      const boundaryRule: AuthRateLimitRule = {
        kind: 'window', scope: 'test_clock_boundary', keyDigest: new Uint8Array(32).fill(15), limit: 2, windowMs: 60_000,
      };
      let boundaryClockCalls = 0;
      await expect(consumeAuthRateLimit(repository, [boundaryRule], () => (
        boundaryClockCalls++ === 0 ? boundaryStart : boundaryStart + 1
      ))).resolves.toEqual({ allowed: false, retryAfter: 1 });
      expect(boundaryClockCalls).toBe(2);
      const unconsumedOldBucket = await database.first('SELECT request_count FROM auth_rate_limits WHERE scope = ? AND key_digest = ? AND bucket_start = ?', [
        'test_clock_boundary', boundaryRule.keyDigest, boundaryBucket,
      ]);
      expect(Number(unconsumedOldBucket?.request_count)).toBe(0);

      const clampNow = Date.UTC(2026, 9, 12, 15);
      const clampKey = new Uint8Array(32).fill(13);
      const clampBucket = Math.floor(clampNow / 60_000) * 60_000;
      await database.run(`INSERT INTO auth_rate_limits
          (scope, key_digest, bucket_start, request_count, next_allowed_at, expires_at)
        VALUES (?, ?, ?, ?, 0, ?)`, ['test_clamp', clampKey, clampBucket, 4_294_967_295, clampBucket + 60_000]);
      const clampRule: AuthRateLimitRule = {
        kind: 'window', scope: 'test_clamp', keyDigest: clampKey, limit: 2, windowMs: 60_000,
      };
      await expect(consumeAuthRateLimit(repository, [clampRule], () => clampNow))
        .resolves.toMatchObject({ allowed: false });
      const clamped = await database.first('SELECT request_count FROM auth_rate_limits WHERE scope = ? AND key_digest = ? AND bucket_start = ?', [
        'test_clamp', clampKey, clampBucket,
      ]);
      expect(Number(clamped?.request_count)).toBe(3);

      const hourStart = Date.UTC(2026, 9, 12, 23, 59, 50);
      const mailEmailKey = new Uint8Array(32).fill(14);
      const mailWindow: AuthRateLimitRule = {
        kind: 'window', scope: 'mail_email', keyDigest: mailEmailKey, limit: 5, windowMs: 60 * 60 * 1000,
      };
      const mailCooldown: AuthRateLimitRule = {
        kind: 'cooldown', scope: 'mail_cooldown', keyDigest: mailEmailKey, cooldownMs: 60_000,
      };
      let clockCalls = 0;
      const firstMailAt = hourStart + 3;
      await expect(consumeAuthRateLimit(repository, [mailWindow, mailCooldown], () => (
        clockCalls++ === 0 ? hourStart : firstMailAt
      ))).resolves.toEqual({ allowed: true, retryAfter: 0 });
      expect(clockCalls).toBe(2);
      const nextHourAttempt = firstMailAt + 20_000;
      await expect(consumeAuthRateLimit(repository, [mailWindow, mailCooldown], () => nextHourAttempt))
        .resolves.toEqual({ allowed: false, retryAfter: 40 });
      await expect(consumeAuthRateLimit(repository, [mailWindow, mailCooldown], () => firstMailAt + 60_000))
        .resolves.toEqual({ allowed: true, retryAfter: 0 });
    });
  }, 120_000);
});
