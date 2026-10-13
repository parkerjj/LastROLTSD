import { describe, expect, it } from 'vitest';
import { createAuthRepository, type NewAuthUser } from '../../apps/worker/src/auth/repository';
import type { AuthRateLimitRule, PasswordMaterial } from '../../apps/worker/src/auth/types';
import type { MysqlRow } from '../../apps/worker/src/db/mysql-client';
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

describe('real MySQL account schema and repository', () => {
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
