import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import type {
  AuthRateLimitRule,
  AccountProfile,
  AccountStatus,
  ActionPurpose,
  AuthIdentity,
  ClaimedMailJob,
  CredentialSnapshot,
  MailAttemptContext,
  MailAvailability,
  MailReservation,
  NewMailJob,
  PasswordMaterial,
  SealedMailPayload,
  UserId,
} from './types';

export type {
  ClaimedMailJob,
  CredentialSnapshot,
  NewMailJob,
  PasswordMaterial,
  UserId,
} from './types';

export type LiveAuthIdentity = AuthIdentity & { readonly expiresAt: number };

const DAY_MILLISECONDS = 86_400_000;
const ZERO_RATE_KEY_DIGEST = new Uint8Array(32);
const MAIL_DAILY_LIMIT = 100;
const MAIL_MONTHLY_LIMIT = 3_000;
const MAIL_MAX_ATTEMPTS = 4;
const MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
const AUTH_CLEANUP_SLOT_MILLISECONDS = 2 * 60_000;
const AUTH_CLEANUP_BATCH_MAX = 50;
const AUTH_CLEANUP_SLOT_COUNT = 8;

export interface UserRecord {
  id: UserId;
  email: string;
  emailNormalized: string;
  displayName: string;
  status: AccountStatus;
  emailVerifiedAt: number | null;
  credentialVersion: number;
  authVersion: number;
  avatarVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSessionRecord {
  tokenDigest: Uint8Array;
  userId: UserId;
  credentialVersion: number;
  authVersion: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface ActionSnapshot {
  tokenDigest: Uint8Array;
  userId: UserId;
  purpose: ActionPurpose;
  emailSnapshot: string;
  credentialVersion: number;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface AuthRepositoryOptions {
  mailDailyLimit?: number;
  mailMonthlyLimit?: number;
}

export interface NewAuthUser {
  email: string;
  emailNormalized: string;
  displayName: string;
  createdAt: number;
}

export interface NewAuthSession {
  tokenDigest: Uint8Array;
  userId: UserId;
  credentialVersion: number;
  authVersion: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface NewActionToken {
  tokenDigest: Uint8Array;
  userId: UserId;
  purpose: ActionPurpose;
  emailSnapshot: string;
  credentialVersion: number;
  createdAt: number;
  expiresAt: number;
}

export interface AuthSecurityEventInput {
  userId: UserId | null;
  event: string;
  requestId: string | null;
  result: string;
  reason: string | null;
  createdAt: number;
}

export type ReusableActionMailLookup =
  | { status: 'none'; now: number }
  | { status: 'retry' }
  | { status: 'reuse'; action: ActionSnapshot; now: number; state: 'PENDING' | 'CLAIMED' };

export interface AuthTx {
  lockUser(userId: UserId): Promise<UserRecord | null>;
  readCredential(userId: UserId): Promise<CredentialSnapshot | null>;
  insertUser(input: NewAuthUser): Promise<UserRecord>;
  insertCredential(userId: UserId, material: PasswordMaterial): Promise<void>;
  saveCredential(userId: UserId, material: PasswordMaterial, nextVersion: number, now: number): Promise<void>;
  readSessionForUpdate(tokenDigest: Uint8Array): Promise<AuthSessionRecord | null>;
  insertSession(input: NewAuthSession): Promise<void>;
  renewSession(tokenDigest: Uint8Array, expiresAt: number, now: number): Promise<boolean>;
  revokeSession(tokenDigest: Uint8Array, now: number): Promise<boolean>;
  bumpAuthVersion(userId: UserId, now: number): Promise<void>;
  readActionForUpdate(tokenDigest: Uint8Array): Promise<ActionSnapshot | null>;
  readReusableActionMail(
    userId: UserId,
    purpose: ActionPurpose,
    credentialVersion: number,
    emailSnapshot: string,
    now: () => number,
  ): Promise<ReusableActionMailLookup>;
  insertAction(input: NewActionToken): Promise<void>;
  consumeAction(tokenDigest: Uint8Array, now: number): Promise<boolean>;
  revokeActions(userId: UserId, purposeOrAll: ActionPurpose | 'all', now: number): Promise<number>;
  markEmailVerified(userId: UserId, now: number): Promise<boolean>;
  saveDisplayName(userId: UserId, displayName: string, now: number): Promise<void>;
  saveAvatar(userId: UserId, base64OrNull: string | null, now: number): Promise<void>;
  insertMailJob(input: NewMailJob): Promise<void>;
  appendEvent(input: AuthSecurityEventInput): Promise<void>;
}

export type MailFinishResult =
  | { status: 'sent'; providerMessageId: string; observedAt: number }
  | { status: 'retry'; errorCode: string; nextAttemptAt: number; observedAt: number }
  | { status: 'paused'; errorCode: string; nextAttemptAt: number; observedAt: number }
  | { status: 'failed'; errorCode: string; observedAt: number }
  | { status: 'release'; observedAt: number };

export interface MailRepository {
  claimOneMail(now: number, leaseMs: number): Promise<ClaimedMailJob | null>;
  freezeMailPayload(id: string, leaseId: string, expected: SealedMailPayload, frozen: SealedMailPayload, observedAt: number): Promise<boolean>;
  finishMail(id: string, leaseId: string, result: MailFinishResult): Promise<boolean>;
  reserveMailAttempt(id: string, leaseId: string, now: () => number): Promise<MailReservation>;
  readMailAvailability(now: number): Promise<MailAvailability>;
  recordProviderQuota(
    id: string,
    leaseId: string,
    kind: 'daily' | 'monthly',
    attempt: MailAttemptContext,
    observedAt: number,
  ): Promise<{ pauseRecorded: boolean; jobUpdated: boolean }>;
}

export type ClaimOneMailForTickResult =
  | { kind: 'claimed'; job: ClaimedMailJob }
  | { kind: 'cleaned' }
  | { kind: 'idle' };

export interface AuthRepository extends MailRepository {
  readCredentialByEmail(emailNormalized: string): Promise<CredentialSnapshot | null>;
  readProfile(userId: UserId): Promise<AccountProfile | null>;
  readIdentity(sessionDigest: Uint8Array, now: number): Promise<LiveAuthIdentity | null>;
  transaction<T>(work: (tx: AuthTx) => Promise<T>): Promise<T>;
  readActionSnapshot(tokenDigest: Uint8Array): Promise<ActionSnapshot | null>;
  consumeAuthRateLimits(rules: readonly AuthRateLimitRule[], now: () => number): Promise<{ allowed: boolean; retryAfter: number }>;
  readAvatar(userId: UserId): Promise<{ base64: string | null; version: number } | null>;
  claimOneMailForTick(now: number, leaseMs: number): Promise<ClaimOneMailForTickResult>;
  cleanupAuthBatch(now: number, limit: number): Promise<number>;
}

interface MailLimitRow extends MysqlRow {
  scope: unknown;
  request_count: unknown;
  next_allowed_at: unknown;
  expires_at: unknown;
}

interface MailOutboxRow extends MysqlRow {
  id: unknown;
  action_digest: unknown;
  user_id: unknown;
  purpose: unknown;
  payload_ciphertext: unknown;
  payload_iv: unknown;
  payload_key_version: unknown;
  priority: unknown;
  state: unknown;
  lease_id: unknown;
  lease_until: unknown;
  attempt_count: unknown;
  next_attempt_at: unknown;
  created_at: unknown;
  expires_at: unknown;
  first_attempt_at: unknown;
  provider_message_id: unknown;
  last_error_code: unknown;
}

interface ReusableMailOutboxRow extends MysqlRow {
  id: unknown;
  action_digest: unknown;
  user_id: unknown;
  purpose: unknown;
  has_payload: unknown;
  state: unknown;
  lease_until: unknown;
  attempt_count: unknown;
  next_attempt_at: unknown;
  expires_at: unknown;
  first_attempt_at: unknown;
}

interface MailUserRow extends MysqlRow {
  email: unknown;
  status: unknown;
  credential_version: unknown;
}

interface MailActionRow extends MysqlRow {
  purpose: unknown;
  email_snapshot: unknown;
  credential_version: unknown;
  expires_at: unknown;
  consumed_at: unknown;
  revoked_at: unknown;
}

interface CredentialRow extends MysqlRow {
  user_id: unknown;
  status: unknown;
  credential_version: unknown;
  auth_version: unknown;
  scheme: unknown;
  salt: unknown;
  digest: unknown;
  key_version: unknown;
}

interface UserRow extends MysqlRow {
  id: unknown;
  email: unknown;
  email_normalized: unknown;
  display_name: unknown;
  status: unknown;
  email_verified_at: unknown;
  credential_version: unknown;
  auth_version: unknown;
  avatar_version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ProfileRow extends MysqlRow {
  id: unknown;
  email: unknown;
  display_name: unknown;
  status: unknown;
  admin: unknown;
  email_verified_at: unknown;
  created_at: unknown;
  has_avatar: unknown;
  avatar_version: unknown;
}

const USER_COLUMNS = `CAST(id AS CHAR) AS id, email, email_normalized, display_name, status,
  email_verified_at, credential_version, auth_version, avatar_version, created_at, updated_at`;
const CREDENTIAL_COLUMNS = `CAST(u.id AS CHAR) AS user_id, u.status, u.credential_version, u.auth_version,
  c.scheme, c.salt, c.digest, c.key_version`;
const MAIL_OUTBOX_COLUMNS = `id, action_digest, CAST(user_id AS CHAR) AS user_id, purpose, payload_ciphertext,
  payload_iv, payload_key_version, priority, state, lease_id, lease_until, attempt_count, next_attempt_at,
  created_at, expires_at, first_attempt_at, provider_message_id, last_error_code`;
const REUSABLE_MAIL_OUTBOX_COLUMNS = `id, action_digest, CAST(user_id AS CHAR) AS user_id, purpose,
  (payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL) AS has_payload,
  state, lease_until, attempt_count, next_attempt_at, expires_at, first_attempt_at`;

export function createAuthRepository(db: MysqlDatabase, options: AuthRepositoryOptions = {}): AuthRepository {
  const mailDailyLimit = positiveInteger(options.mailDailyLimit ?? MAIL_DAILY_LIMIT, 'mailDailyLimit');
  const mailMonthlyLimit = positiveInteger(options.mailMonthlyLimit ?? MAIL_MONTHLY_LIMIT, 'mailMonthlyLimit');

  return {
    async readCredentialByEmail(emailNormalized) {
      const row = await db.first<CredentialRow>(`SELECT ${CREDENTIAL_COLUMNS}
        FROM auth_users AS u
        INNER JOIN auth_credentials AS c ON c.user_id = u.id
        WHERE u.email_normalized = ?
        LIMIT 1`, [emailNormalized]);
      return row ? mapCredential(row) : null;
    },

    async readProfile(userId) {
      const row = await db.first<ProfileRow>(`SELECT CAST(u.id AS CHAR) AS id, u.email, u.display_name, u.status,
          u.admin, u.email_verified_at, u.created_at, u.avatar_version,
          EXISTS (SELECT 1 FROM auth_avatars AS a WHERE a.user_id = u.id) AS has_avatar
        FROM auth_users AS u
        WHERE u.id = ?
        LIMIT 1`, [userId]);
      if (!row) return null;
      const id = requiredString(row.id, 'id');
      const avatarVersion = numberValue(row.avatar_version, 'avatar_version');
      return {
        id,
        email: requiredString(row.email, 'email'),
        display_name: requiredString(row.display_name, 'display_name'),
        status: requiredString(row.status, 'status') as AccountStatus,
        admin: numberValue(row.admin, 'admin'),
        email_verified_at: nullableNumberValue(row.email_verified_at, 'email_verified_at'),
        created_at: numberValue(row.created_at, 'created_at'),
        has_avatar: numberValue(row.has_avatar, 'has_avatar') === 1,
        avatar_version: avatarVersion,
        avatar_url: `/api/v1/users/${id}/avatar?v=${avatarVersion}`,
      };
    },

    async readIdentity(sessionDigest, now) {
      const row = await db.first<MysqlRow>(`SELECT CAST(s.user_id AS CHAR) AS user_id, u.status,
          s.credential_version, s.auth_version, s.expires_at
        FROM auth_sessions AS s
        INNER JOIN auth_users AS u ON u.id = s.user_id
        WHERE s.token_digest = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > ?
          AND s.credential_version = u.credential_version
          AND s.auth_version = u.auth_version
          AND u.status <> 'DISABLED'
          AND (u.status <> 'ACTIVE' OR u.email_verified_at IS NOT NULL)
        LIMIT 1`, [sessionDigest, timestampValue(now, 'now')]);
      if (!row) return null;
      return {
        userId: requiredString(row.user_id, 'user_id'),
        status: requiredString(row.status, 'status') as AccountStatus,
        credentialVersion: numberValue(row.credential_version, 'credential_version'),
        authVersion: numberValue(row.auth_version, 'auth_version'),
        sessionDigest: new Uint8Array(sessionDigest),
        expiresAt: numberValue(row.expires_at, 'expires_at'),
      };
    },

    async transaction(work) {
      return db.transaction((transactionDb) => work(createAuthTx(transactionDb)));
    },

    async readActionSnapshot(tokenDigest) {
      const row = await db.first<MysqlRow>(`SELECT token_digest, CAST(user_id AS CHAR) AS user_id,
          purpose, email_snapshot, credential_version, created_at, expires_at, consumed_at, revoked_at
        FROM auth_action_tokens
        WHERE token_digest = ?
        LIMIT 1`, [tokenDigest]);
      return row ? mapAction(row) : null;
    },

    async readMailAvailability(now) {
      return readMailAvailability(db, mailDailyLimit, mailMonthlyLimit, now);
    },

    async claimOneMail(now, leaseMs) {
      return claimOneMail(db, mailDailyLimit, mailMonthlyLimit, now, leaseMs);
    },

    async claimOneMailForTick(now, leaseMs) {
      return claimOneMailForTick(db, mailDailyLimit, mailMonthlyLimit, now, leaseMs);
    },

    async cleanupAuthBatch(now, limit) {
      return cleanupAuthBatch(db, now, limit);
    },

    async freezeMailPayload(id, leaseId, expected, frozen, observedAt) {
      return freezeMailPayload(db, id, leaseId, expected, frozen, observedAt);
    },

    async finishMail(id, leaseId, result) {
      return finishMail(db, id, leaseId, result);
    },

    async reserveMailAttempt(id, leaseId, getNow) {
      return reserveMailAttempt(db, id, leaseId, getNow, mailDailyLimit, mailMonthlyLimit);
    },

    async recordProviderQuota(id, leaseId, kind, attempt, observedAt) {
      return recordProviderQuota(db, id, leaseId, kind, attempt, observedAt);
    },

    async consumeAuthRateLimits(rules, getNow) {
      if (rules.length === 0) return { allowed: true, retryAfter: 0 };
      const initialNow = timestampValue(getNow(), 'now');
      const lockRows = prepareRateLimitRows(rules, initialNow);

      return db.transaction(async (transactionDb) => {
        for (const row of lockRows) {
          await transactionDb.run(`INSERT INTO auth_rate_limits
              (scope, key_digest, bucket_start, request_count, next_allowed_at, expires_at)
            VALUES (?, ?, ?, 0, 0, ?)
            ON DUPLICATE KEY UPDATE request_count = request_count`, [
            row.scope, row.keyDigest, row.bucketStart, row.expiresAt,
          ]);
        }

        const records = new Map<string, MailLimitRow>();
        for (const row of lockRows) {
          const record = await transactionDb.first<MailLimitRow>(`SELECT request_count, next_allowed_at, expires_at
            FROM auth_rate_limits
            WHERE scope = ? AND key_digest = ? AND bucket_start = ?
            FOR UPDATE`, [row.scope, row.keyDigest, row.bucketStart]);
          if (!record) throw new Error('auth rate limit row missing after lock');
          records.set(rateLimitRowId(row), record);
        }

        const currentNow = timestampValue(getNow(), 'now');
        if (lockRows.some((row) => row.rule.kind === 'window'
          && Math.floor(currentNow / row.rule.windowMs) * row.rule.windowMs !== row.bucketStart)) {
          return { allowed: false, retryAfter: 1 };
        }

        let blockedUntil = 0;
        for (const row of lockRows) {
          const record = records.get(rateLimitRowId(row))!;
          if (row.rule.kind === 'window') {
            if (countValue(record) >= row.rule.limit) blockedUntil = Math.max(blockedUntil, row.expiresAt);
          } else if (providerPauseActive(record, currentNow)) {
            blockedUntil = Math.max(blockedUntil, numberValue(record.next_allowed_at, 'next_allowed_at'));
          }
        }

        for (const row of lockRows) {
          if (row.rule.kind !== 'window') continue;
          const clamp = row.rule.limit + 1;
          await transactionDb.run(`UPDATE auth_rate_limits
            SET request_count = CASE WHEN request_count >= ? THEN ? ELSE request_count + 1 END
            WHERE scope = ? AND key_digest = ? AND bucket_start = ?`, [
            clamp, clamp, row.scope, row.keyDigest, row.bucketStart,
          ]);
        }

        const hasExceededWindow = lockRows.some((row) => row.rule.kind === 'window'
          && countValue(records.get(rateLimitRowId(row))) >= row.rule.limit);
        for (const row of lockRows) {
          if (row.rule.kind !== 'cooldown' || hasExceededWindow) continue;
          const record = records.get(rateLimitRowId(row))!;
          if (!providerPauseActive(record, currentNow)) {
            const nextAllowedAt = timestampValue(currentNow + row.rule.cooldownMs, 'cooldown next_allowed_at');
            await transactionDb.run(`UPDATE auth_rate_limits
              SET request_count = 1, next_allowed_at = ?, expires_at = ?
              WHERE scope = ? AND key_digest = ? AND bucket_start = 0`, [
              nextAllowedAt, nextAllowedAt, row.scope, row.keyDigest,
            ]);
          }
        }

        return blockedUntil > currentNow
          ? { allowed: false, retryAfter: Math.max(1, Math.ceil((blockedUntil - currentNow) / 1000)) }
          : { allowed: true, retryAfter: 0 };
      });
    },

    async readAvatar(userId) {
      const row = await db.first<MysqlRow>(`SELECT a.avatar_base64, u.avatar_version
        FROM auth_users AS u
        LEFT JOIN auth_avatars AS a ON a.user_id = u.id
        WHERE u.id = ?
        LIMIT 1`, [userId]);
      if (!row) return null;
      return {
        base64: row.avatar_base64 == null ? null : requiredString(row.avatar_base64, 'avatar_base64'),
        version: numberValue(row.avatar_version, 'avatar_version'),
      };
    },
  };
}

function createAuthTx(db: MysqlDatabase): AuthTx {
  const lockedUsers = new Set<UserId>();
  const lockedSessions = new Map<string, UserId>();
  const lockedActions = new Map<string, UserId>();
  let lockPhase = 0;

  const requireLockedUser = (userId: UserId): void => {
    if (!lockedUsers.has(userId)) throw new Error('auth user must be locked before writing account state');
  };
  const assertUserLockOrder = (): void => {
    if (lockPhase >= 2) throw new Error('auth user must be locked before session or action rows');
  };
  const singleLockedUser = (): UserId => {
    if (lockedUsers.size !== 1) throw new Error('exactly one auth user must be locked before session or action rows');
    return lockedUsers.values().next().value as UserId;
  };
  const beginAuthWrite = (userId: UserId): void => {
    requireLockedUser(userId);
    if (lockPhase >= 3) throw new Error('auth state must be written before mail outbox and security events');
  };
  const beginUserWrite = (): void => {
    if (lockPhase >= 2) throw new Error('auth user must be written before session or action rows');
  };
  const beginSessionOrActionLock = (): UserId => {
    const userId = singleLockedUser();
    if (lockPhase >= 3) throw new Error('session and action rows must be locked before mail outbox rows');
    lockPhase = 2;
    return userId;
  };
  const lockedDigestOwner = (owners: ReadonlyMap<string, UserId>, digest: Uint8Array, userId: UserId): UserId | null => {
    const owner = owners.get(digestKey(digest));
    return owner === userId && lockedUsers.has(owner) ? owner : null;
  };
  const beginMailWrite = (userId: UserId | null): void => {
    if (userId !== null) requireLockedUser(userId);
    if (lockPhase >= 4) throw new Error('mail outbox rows must be written before security events');
    lockPhase = 3;
  };
  const beginEventWrite = (userId: UserId | null): void => {
    if (userId !== null) requireLockedUser(userId);
    lockPhase = 4;
  };

  return {
    async lockUser(userId) {
      assertUserLockOrder();
      const row = await db.first<UserRow>(`SELECT ${USER_COLUMNS}
        FROM auth_users
        WHERE id = ?
        FOR UPDATE`, [userId]);
      if (!row) return null;
      const user = mapUser(row);
      if (user.id !== userId) return null;
      lockedUsers.add(userId);
      lockPhase = 1;
      return user;
    },

    async readCredential(userId) {
      const row = await db.first<CredentialRow>(`SELECT ${CREDENTIAL_COLUMNS}
        FROM auth_users AS u
        INNER JOIN auth_credentials AS c ON c.user_id = u.id
        WHERE u.id = ?
        LIMIT 1`, [userId]);
      return row ? mapCredential(row) : null;
    },

    async insertUser(input) {
      beginUserWrite();
      timestampValue(input.createdAt, 'createdAt');
      await db.run(`INSERT INTO auth_users
          (email, email_normalized, display_name, status, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING_EMAIL', NULL, ?, ?)`, [
        input.email, input.emailNormalized, input.displayName, input.createdAt, input.createdAt,
      ]);
      const row = await db.first<UserRow>(`SELECT ${USER_COLUMNS}
        FROM auth_users
        WHERE email_normalized = ?
        LIMIT 1`, [input.emailNormalized]);
      if (!row) throw new Error('inserted auth user could not be read back');
      const user = mapUser(row);
      lockedUsers.add(user.id);
      lockPhase = 1;
      return user;
    },

    async insertCredential(userId, material) {
      beginAuthWrite(userId);
      const result = await db.run(`INSERT INTO auth_credentials
          (user_id, scheme, salt, digest, key_version, updated_at)
        SELECT u.id, ?, ?, ?, ?, u.created_at
        FROM auth_users AS u
        WHERE u.id = ?`, [material.scheme, material.salt, material.digest, material.keyVersion, userId]);
      if (result.affectedRows !== 1) throw new Error('auth credential user does not exist');
    },

    async saveCredential(userId, material, nextVersion, now) {
      beginAuthWrite(userId);
      const version = positiveInteger(nextVersion, 'nextVersion');
      const at = timestampValue(now, 'now');
      const current = await db.first<MysqlRow>(`SELECT 1 AS credential_exists
        FROM auth_credentials
        WHERE user_id = ?
        FOR UPDATE`, [userId]);
      if (!current) throw new Error('auth credential does not exist');
      await db.run(`UPDATE auth_credentials
        SET scheme = ?, salt = ?, digest = ?, key_version = ?, updated_at = ?
        WHERE user_id = ?`, [material.scheme, material.salt, material.digest, material.keyVersion, at, userId]);
      const result = await db.run(`UPDATE auth_users
        SET credential_version = ?, updated_at = ?
        WHERE id = ?`, [version, at, userId]);
      if (result.affectedRows !== 1) throw new Error('auth user does not exist');
    },

    async readSessionForUpdate(tokenDigest) {
      const userId = beginSessionOrActionLock();
      const row = await db.first<MysqlRow>(`SELECT token_digest, CAST(user_id AS CHAR) AS user_id,
          credential_version, auth_version, created_at, last_seen_at, expires_at, revoked_at
        FROM auth_sessions
        WHERE token_digest = ? AND user_id = ?
        FOR UPDATE`, [tokenDigest, userId]);
      if (!row) return null;
      const session = mapSession(row);
      if (session.userId !== userId || digestKey(session.tokenDigest) !== digestKey(tokenDigest)) return null;
      lockedSessions.set(digestKey(tokenDigest), userId);
      return session;
    },

    async insertSession(input) {
      beginAuthWrite(input.userId);
      const userId = beginSessionOrActionLock();
      if (input.userId !== userId) throw new Error('auth session user must match the locked user');
      const result = await db.run(`INSERT INTO auth_sessions
          (token_digest, user_id, credential_version, auth_version, created_at, last_seen_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, [
        input.tokenDigest, input.userId, positiveInteger(input.credentialVersion, 'credentialVersion'),
        positiveInteger(input.authVersion, 'authVersion'), timestampValue(input.createdAt, 'createdAt'),
        timestampValue(input.lastSeenAt, 'lastSeenAt'), timestampValue(input.expiresAt, 'expiresAt'),
      ]);
      if (result.affectedRows !== 1) throw new Error('auth session was not inserted');
    },

    async renewSession(tokenDigest, expiresAt, now) {
      const userId = beginSessionOrActionLock();
      const owner = lockedDigestOwner(lockedSessions, tokenDigest, userId);
      if (owner === null) return false;
      const at = timestampValue(now, 'now');
      const lastSeenCutoff = Math.max(0, at - DAY_MILLISECONDS);
      const result = await db.run(`UPDATE auth_sessions
        SET last_seen_at = CASE WHEN last_seen_at <= ? THEN ? ELSE last_seen_at END,
            expires_at = GREATEST(expires_at, ?)
        WHERE token_digest = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`, [
        lastSeenCutoff, at, timestampValue(expiresAt, 'expiresAt'), tokenDigest, owner, at,
      ]);
      return result.affectedRows === 1;
    },

    async revokeSession(tokenDigest, now) {
      const userId = beginSessionOrActionLock();
      const owner = lockedDigestOwner(lockedSessions, tokenDigest, userId);
      if (owner === null) return false;
      const result = await db.run(`UPDATE auth_sessions
        SET revoked_at = ?
        WHERE token_digest = ? AND user_id = ? AND revoked_at IS NULL`, [timestampValue(now, 'now'), tokenDigest, owner]);
      return result.affectedRows === 1;
    },

    async bumpAuthVersion(userId, now) {
      beginAuthWrite(userId);
      const result = await db.run(`UPDATE auth_users
        SET auth_version = auth_version + 1, updated_at = ?
        WHERE id = ?`, [timestampValue(now, 'now'), userId]);
      if (result.affectedRows !== 1) throw new Error('auth user does not exist');
    },

    async readActionForUpdate(tokenDigest) {
      const userId = beginSessionOrActionLock();
      const row = await db.first<MysqlRow>(`SELECT token_digest, CAST(user_id AS CHAR) AS user_id,
          purpose, email_snapshot, credential_version, created_at, expires_at, consumed_at, revoked_at
        FROM auth_action_tokens
        WHERE token_digest = ? AND user_id = ?
        FOR UPDATE`, [tokenDigest, userId]);
      if (!row) return null;
      const action = mapAction(row);
      if (action.userId !== userId || digestKey(action.tokenDigest) !== digestKey(tokenDigest)) return null;
      lockedActions.set(digestKey(tokenDigest), userId);
      return action;
    },

    async readReusableActionMail(userId, purpose, credentialVersion, emailSnapshot, getNow) {
      const lockedUserId = singleLockedUser();
      if (lockedUserId !== userId) throw new Error('auth action user must match the locked user');
      if (lockPhase >= 3) throw new Error('action rows must be checked before mail outbox rows');
      lockPhase = 2;

      const actionQueryAt = timestampValue(getNow(), 'now');
      const actionRows = await db.all<MysqlRow>(`SELECT token_digest, CAST(user_id AS CHAR) AS user_id,
          purpose, email_snapshot, credential_version, created_at, expires_at, consumed_at, revoked_at
        FROM auth_action_tokens
        WHERE user_id = ? AND purpose = ? AND credential_version = ?
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 128 FOR UPDATE`, [userId, purpose, positiveInteger(credentialVersion, 'credentialVersion'), actionQueryAt]);
      const actions = actionRows.map(mapAction);
      for (const action of actions) lockedActions.set(digestKey(action.tokenDigest), userId);
      const candidates = actions.filter((action) => action.userId === userId
        && action.purpose === purpose
        && action.credentialVersion === credentialVersion
        && action.emailSnapshot === emailSnapshot);
      if (candidates.length === 0) return { status: 'none', now: timestampValue(getNow(), 'now') };

      const digests = candidates.map((action) => action.tokenDigest);
      const placeholders = digests.map(() => '?').join(', ');
      const mailRows = await db.all<ReusableMailOutboxRow>(`SELECT ${REUSABLE_MAIL_OUTBOX_COLUMNS}
        FROM auth_mail_outbox
        WHERE action_digest IN (${placeholders}) AND user_id = ? AND purpose = ?`, [
        ...digests, userId, purpose,
      ]);
      const mailByAction = new Map<string, ReusableMailOutboxRow>();
      for (const row of mailRows) {
        if (row.action_digest === null) continue;
        const key = digestKey(byteArrayValue(row.action_digest, 'action_digest'));
        if (!mailByAction.has(key)) mailByAction.set(key, row);
      }

      let lockedMailCandidate = false;
      for (const action of candidates) {
        const mail = mailByAction.get(digestKey(action.tokenDigest));
        if (!mail) continue;
        const observedAt = timestampValue(getNow(), 'now');
        const state = reusableMailState(mail, observedAt);
        if (state === null || action.expiresAt <= observedAt) continue;
        const leaseUntil = nullableNumberValue(mail.lease_until, 'lease_until');
        if (state === 'CLAIMED' && leaseUntil !== null && leaseUntil > observedAt) {
          return { status: 'reuse', action, now: observedAt, state };
        }

        lockPhase = 3;
        lockedMailCandidate = true;
        const lockedMail = await db.first<ReusableMailOutboxRow>(`SELECT ${REUSABLE_MAIL_OUTBOX_COLUMNS}
          FROM auth_mail_outbox
          WHERE id = ? AND action_digest = ? AND user_id = ? AND purpose = ?
          FOR UPDATE`, [mail.id, action.tokenDigest, userId, purpose]);
        if (!lockedMail) continue;
        const lockedAt = timestampValue(getNow(), 'now');
        const lockedState = reusableMailState(lockedMail, lockedAt);
        if (lockedState !== null && action.expiresAt > lockedAt) {
          return { status: 'reuse', action, now: lockedAt, state: lockedState };
        }
      }

      return lockedMailCandidate
        ? { status: 'retry' }
        : { status: 'none', now: timestampValue(getNow(), 'now') };
    },

    async insertAction(input) {
      beginAuthWrite(input.userId);
      const userId = beginSessionOrActionLock();
      if (input.userId !== userId) throw new Error('auth action user must match the locked user');
      const result = await db.run(`INSERT INTO auth_action_tokens
          (token_digest, user_id, purpose, email_snapshot, credential_version, created_at, expires_at, consumed_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`, [
        input.tokenDigest, input.userId, input.purpose, input.emailSnapshot,
        positiveInteger(input.credentialVersion, 'credentialVersion'), timestampValue(input.createdAt, 'createdAt'),
        timestampValue(input.expiresAt, 'expiresAt'),
      ]);
      if (result.affectedRows !== 1) throw new Error('auth action was not inserted');
    },

    async consumeAction(tokenDigest, now) {
      const userId = beginSessionOrActionLock();
      const owner = lockedDigestOwner(lockedActions, tokenDigest, userId);
      if (owner === null) return false;
      const at = timestampValue(now, 'now');
      const result = await db.run(`UPDATE auth_action_tokens
        SET consumed_at = ?
        WHERE token_digest = ? AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, [
        at, tokenDigest, owner, at,
      ]);
      return result.affectedRows === 1;
    },

    async revokeActions(userId, purposeOrAll, now) {
      requireLockedUser(userId);
      const lockedUserId = beginSessionOrActionLock();
      if (userId !== lockedUserId) throw new Error('auth action user must match the locked user');
      const at = timestampValue(now, 'now');
      const purposeClause = purposeOrAll === 'all' ? '' : ' AND purpose = ?';
      const values: unknown[] = [at, userId, at];
      if (purposeOrAll !== 'all') values.push(purposeOrAll);
      const result = await db.run(`UPDATE auth_action_tokens
        SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?${purposeClause}`, values);
      return result.affectedRows;
    },

    async markEmailVerified(userId, now) {
      beginAuthWrite(userId);
      const at = timestampValue(now, 'now');
      // 邮箱验证通过即成为正式用户：仅将 admin=0（萌新）升为 1，不覆盖赞助(2)/管理员(100)
      const result = await db.run(`UPDATE auth_users
        SET email_verified_at = ?, status = 'ACTIVE', admin = IF(admin = 0, 1, admin), updated_at = ?
        WHERE id = ? AND status = 'PENDING_EMAIL' AND email_verified_at IS NULL`, [
        at, at, userId,
      ]);
      return result.affectedRows === 1;
    },

    async saveDisplayName(userId, displayName, now) {
      beginAuthWrite(userId);
      await db.run(`UPDATE auth_users
        SET display_name = ?, updated_at = ?
        WHERE id = ?`, [displayName, timestampValue(now, 'now'), userId]);
    },

    async saveAvatar(userId, base64OrNull, now) {
      beginAuthWrite(userId);
      const at = timestampValue(now, 'now');
      const result = await db.run(`UPDATE auth_users
        SET avatar_version = avatar_version + 1, updated_at = ?
        WHERE id = ?`, [at, userId]);
      if (result.affectedRows !== 1) throw new Error('auth user does not exist');
      if (base64OrNull === null) {
        await db.run('DELETE FROM auth_avatars WHERE user_id = ?', [userId]);
      } else {
        await db.run(`INSERT INTO auth_avatars (user_id, avatar_base64, updated_at)
          VALUES (?, ?, ?) AS new_avatar
          ON DUPLICATE KEY UPDATE avatar_base64 = new_avatar.avatar_base64, updated_at = new_avatar.updated_at`, [userId, base64OrNull, at]);
      }
    },

    async insertMailJob(input) {
      beginMailWrite(input.userId);
      const at = timestampValue(input.createdAt, 'createdAt');
      const result = await db.run(`INSERT INTO auth_mail_outbox
          (id, action_digest, user_id, purpose, payload_ciphertext, payload_iv, payload_key_version, priority,
           state, lease_id, lease_until, attempt_count, next_attempt_at, created_at, expires_at,
           first_attempt_at, provider_message_id, last_error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, ?, ?, ?, NULL, NULL, NULL)`, [
        input.id, input.actionDigest, input.userId, input.purpose, input.payloadCiphertext, input.payloadIv,
        input.payloadKeyVersion, input.priority, at, at, timestampValue(input.expiresAt, 'expiresAt'),
      ]);
      if (result.affectedRows !== 1) throw new Error('auth mail job was not inserted');
    },

    async appendEvent(input) {
      beginEventWrite(input.userId);
      const result = await db.run(`INSERT INTO auth_security_events
          (user_id, \`event\`, request_id, result, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [
        input.userId, input.event, input.requestId, input.result, input.reason, timestampValue(input.createdAt, 'createdAt'),
      ]);
      if (result.affectedRows !== 1) throw new Error('auth security event was not inserted');
    },
  };
}

interface MailBuckets {
  dayBucketStart: number;
  nextDayStart: number;
  monthBucketStart: number;
  nextMonthStart: number;
}

interface MailRateEntry {
  scope: 'mail-budget-daily' | 'mail-budget-monthly' | 'mail-provider-daily' | 'mail-provider-monthly';
  bucketStart: number;
  expiresAt: number;
}

function mailBuckets(value: number): MailBuckets {
  const currentTime = timestampValue(value, 'now');
  const date = new Date(currentTime);
  if (!Number.isFinite(date.getTime())) throw new Error('now must be a valid timestamp');
  const dayBucketStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monthBucketStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return {
    dayBucketStart,
    nextDayStart: timestampValue(dayBucketStart + DAY_MILLISECONDS, 'next day'),
    monthBucketStart,
    nextMonthStart: timestampValue(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), 'next month'),
  };
}

async function readMailAvailability(
  db: MysqlDatabase,
  mailDailyLimit: number,
  mailMonthlyLimit: number,
  now: number,
): Promise<MailAvailability> {
  const currentTime = timestampValue(now, 'now');
  const buckets = mailBuckets(currentTime);
  const rows = await db.all<MailLimitRow>(`SELECT scope, request_count, next_allowed_at, expires_at
    FROM auth_rate_limits
    WHERE key_digest = ?
      AND ((scope = ? AND bucket_start = ?)
        OR (scope = ? AND bucket_start = ?)
        OR (scope = ? AND bucket_start = ?)
        OR (scope = ? AND bucket_start = ?))`, [
    ZERO_RATE_KEY_DIGEST,
    'mail-budget-daily', buckets.dayBucketStart,
    'mail-budget-monthly', buckets.monthBucketStart,
    'mail-provider-daily', buckets.dayBucketStart,
    'mail-provider-monthly', buckets.monthBucketStart,
  ]);
  const byScope = new Map(rows.map((row) => [requiredString(row.scope, 'scope'), row]));
  if (countValue(byScope.get('mail-budget-monthly')) >= mailMonthlyLimit
    || providerPauseActive(byScope.get('mail-provider-monthly'), currentTime)) {
    return { code: 'MAIL_MONTHLY_QUOTA', retry_at: null };
  }
  if (countValue(byScope.get('mail-budget-daily')) >= mailDailyLimit
    || providerPauseActive(byScope.get('mail-provider-daily'), currentTime)) {
    return { code: 'MAIL_DAILY_QUOTA', retry_at: buckets.nextDayStart };
  }
  return { code: 'AVAILABLE', retry_at: null };
}

async function claimOneMail(
  db: MysqlDatabase,
  mailDailyLimit: number,
  mailMonthlyLimit: number,
  now: number,
  leaseMs: number,
): Promise<ClaimedMailJob | null> {
  const currentTime = timestampValue(now, 'now');
  const leaseDuration = positiveInteger(leaseMs, 'leaseMs');
  const availability = await readMailAvailability(db, mailDailyLimit, mailMonthlyLimit, currentTime);
  if (availability.code !== 'AVAILABLE') return null;

  return db.transaction(async (transactionDb) => {
    await terminalizeOneExpiredMail(transactionDb, currentTime);
    return claimReadyMail(transactionDb, currentTime, leaseDuration);
  });
}

async function claimOneMailForTick(
  db: MysqlDatabase,
  mailDailyLimit: number,
  mailMonthlyLimit: number,
  now: number,
  leaseMs: number,
): Promise<ClaimOneMailForTickResult> {
  const currentTime = timestampValue(now, 'now');
  const leaseDuration = positiveInteger(leaseMs, 'leaseMs');
  const availability = await readMailAvailability(db, mailDailyLimit, mailMonthlyLimit, currentTime);

  return db.transaction(async (transactionDb) => {
    if (availability.code === 'AVAILABLE') {
      const job = await claimReadyMail(transactionDb, currentTime, leaseDuration);
      if (job) return { kind: 'claimed', job };
    }

    return await terminalizeOneExpiredMail(transactionDb, currentTime) ? { kind: 'cleaned' } : { kind: 'idle' };
  });
}

async function claimReadyMail(
  db: MysqlDatabase,
  now: number,
  leaseMs: number,
): Promise<ClaimedMailJob | null> {
  const firstAttemptCutoff = Math.max(0, now - MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS);
  for (const priority of [0, 1] as const) {
    const pending = await db.first<MailOutboxRow>(`SELECT ${MAIL_OUTBOX_COLUMNS}
      FROM auth_mail_outbox
      WHERE state = 'PENDING' AND priority = ? AND next_attempt_at <= ? AND expires_at > ?
        AND attempt_count < ? AND (first_attempt_at IS NULL OR first_attempt_at > ?)
        AND payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL
      ORDER BY next_attempt_at, id
      LIMIT 1 FOR UPDATE SKIP LOCKED`, [priority, now, now, MAIL_MAX_ATTEMPTS, firstAttemptCutoff]);
    if (pending) return claimMailRow(db, pending, 'PENDING', now, leaseMs);

    const expiredLease = await db.first<MailOutboxRow>(`SELECT ${MAIL_OUTBOX_COLUMNS}
      FROM auth_mail_outbox
      WHERE state = 'CLAIMED' AND priority = ? AND lease_until <= ? AND expires_at > ?
        AND attempt_count < ? AND (first_attempt_at IS NULL OR first_attempt_at > ?)
        AND payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL
      ORDER BY lease_until, id
      LIMIT 1 FOR UPDATE SKIP LOCKED`, [priority, now, now, MAIL_MAX_ATTEMPTS, firstAttemptCutoff]);
    if (expiredLease) return claimMailRow(db, expiredLease, 'CLAIMED', now, leaseMs);
  }
  return null;
}

async function terminalizeOneExpiredMail(db: MysqlDatabase, now: number): Promise<boolean> {
  const expired = await db.first<MailOutboxRow>(`SELECT ${MAIL_OUTBOX_COLUMNS}
    FROM auth_mail_outbox
    WHERE expires_at <= ?
      AND (state = 'PENDING' OR (state = 'CLAIMED' AND lease_until <= ?))
    ORDER BY expires_at, id
    LIMIT 1 FOR UPDATE SKIP LOCKED`, [now, now]);
  if (!expired) return false;

  const attemptCount = numberValue(expired.attempt_count, 'attempt_count');
  const firstAttemptAt = nullableNumberValue(expired.first_attempt_at, 'first_attempt_at');
  const deliveryUnknown = attemptCount >= MAIL_MAX_ATTEMPTS
    || (firstAttemptAt !== null && firstAttemptAt <= Math.max(0, now - MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS));
  await markMailTerminal(db, requiredString(expired.id, 'id'), deliveryUnknown ? 'FAILED' : 'CANCELLED',
    deliveryUnknown ? 'delivery_unknown' : 'MAIL_EXPIRED');
  return true;
}

async function cleanupAuthBatch(db: MysqlDatabase, now: number, requestedLimit: number): Promise<number> {
  const currentTime = timestampValue(now, 'now');
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error('cleanup limit must be a positive integer');
  const limit = Math.min(requestedLimit, AUTH_CLEANUP_BATCH_MAX);
  const slot = Math.floor(currentTime / AUTH_CLEANUP_SLOT_MILLISECONDS) % AUTH_CLEANUP_SLOT_COUNT;
  const firstAttemptCutoff = Math.max(0, currentTime - MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS);

  switch (slot) {
    case 0: {
      const result = await db.run(`UPDATE auth_mail_outbox
        SET state = CASE WHEN attempt_count >= ? OR (first_attempt_at IS NOT NULL AND first_attempt_at <= ?) THEN 'FAILED' ELSE 'CANCELLED' END,
            lease_id = NULL, lease_until = NULL, payload_ciphertext = NULL, payload_iv = NULL,
            last_error_code = CASE WHEN attempt_count >= ? OR (first_attempt_at IS NOT NULL AND first_attempt_at <= ?) THEN 'delivery_unknown' ELSE 'MAIL_EXPIRED' END
        WHERE expires_at <= ? AND state IN ('PENDING', 'CLAIMED')
          AND (state = 'PENDING' OR lease_until <= ?)
        ORDER BY expires_at, id LIMIT ?`, [MAIL_MAX_ATTEMPTS, firstAttemptCutoff, MAIL_MAX_ATTEMPTS,
        firstAttemptCutoff, currentTime, currentTime, limit]);
      return result.affectedRows;
    }
    case 1: {
      const result = await db.run(`UPDATE auth_mail_outbox
        SET state = 'FAILED', lease_id = NULL, lease_until = NULL, payload_ciphertext = NULL, payload_iv = NULL,
            last_error_code = 'delivery_unknown'
        WHERE state = 'CLAIMED' AND lease_until <= ? AND attempt_count >= ?
        ORDER BY lease_until, id LIMIT ?`, [currentTime, MAIL_MAX_ATTEMPTS, limit]);
      return result.affectedRows;
    }
    case 2: {
      const result = await db.run(`UPDATE auth_mail_outbox
        SET state = 'FAILED', lease_id = NULL, lease_until = NULL, payload_ciphertext = NULL, payload_iv = NULL,
            last_error_code = 'delivery_unknown'
        WHERE state = 'CLAIMED' AND lease_until <= ? AND attempt_count < ? AND first_attempt_at <= ?
        ORDER BY lease_until, id LIMIT ?`, [currentTime, MAIL_MAX_ATTEMPTS, firstAttemptCutoff, limit]);
      return result.affectedRows;
    }
    case 3: {
      const retentionCutoff = Math.max(0, currentTime - 30 * DAY_MILLISECONDS);
      const result = await db.run(`DELETE FROM auth_mail_outbox
        WHERE expires_at <= ? AND state IN ('SENT', 'FAILED', 'CANCELLED')
        ORDER BY expires_at, id LIMIT ?`, [retentionCutoff, limit]);
      return result.affectedRows;
    }
    case 4: {
      const retentionCutoff = Math.max(0, currentTime - 7 * DAY_MILLISECONDS);
      const result = await db.run(`DELETE FROM auth_action_tokens
        WHERE expires_at <= ? ORDER BY expires_at, token_digest LIMIT ?`, [retentionCutoff, limit]);
      return result.affectedRows;
    }
    case 5: {
      const result = await db.run(`DELETE FROM auth_sessions
        WHERE expires_at <= ? ORDER BY expires_at, token_digest LIMIT ?`, [currentTime, limit]);
      return result.affectedRows;
    }
    case 6: {
      const retentionCutoff = Math.max(0, currentTime - 90 * DAY_MILLISECONDS);
      const result = await db.run(`DELETE FROM auth_security_events
        WHERE created_at <= ? ORDER BY created_at, id LIMIT ?`, [retentionCutoff, limit]);
      return result.affectedRows;
    }
    default: {
      const result = await db.run(`DELETE FROM auth_rate_limits
        WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`, [currentTime, limit]);
      return result.affectedRows;
    }
  }
}

async function claimMailRow(
  db: MysqlDatabase,
  row: MailOutboxRow,
  previousState: 'PENDING' | 'CLAIMED',
  now: number,
  leaseMs: number,
): Promise<ClaimedMailJob | null> {
  const id = requiredString(row.id, 'id');
  const leaseId = crypto.randomUUID();
  const leaseUntil = timestampValue(now + leaseMs, 'leaseUntil');
  const result = await db.run(`UPDATE auth_mail_outbox
    SET state = 'CLAIMED', lease_id = ?, lease_until = ?
    WHERE id = ? AND state = ?`, [leaseId, leaseUntil, id, previousState]);
  if (result.affectedRows !== 1) return null;
  return mapClaimedMailJob({ ...row, state: 'CLAIMED', lease_id: leaseId, lease_until: leaseUntil });
}

async function markMailTerminal(
  db: MysqlDatabase,
  id: string,
  state: 'FAILED' | 'CANCELLED',
  errorCode: string,
): Promise<void> {
  await db.run(`UPDATE auth_mail_outbox
    SET state = ?, lease_id = NULL, lease_until = NULL, payload_ciphertext = NULL, payload_iv = NULL, last_error_code = ?
    WHERE id = ? AND state IN ('PENDING', 'CLAIMED')`, [state, errorCode, id]);
}

function mapClaimedMailJob(row: MailOutboxRow): ClaimedMailJob {
  const state = requiredString(row.state, 'state');
  if (state !== 'CLAIMED') throw new Error('invalid auth mail state');
  const priority = numberValue(row.priority, 'priority');
  if (priority !== 0 && priority !== 1) throw new Error('invalid auth mail priority');
  const purpose = requiredString(row.purpose, 'purpose');
  if (purpose !== 'VERIFY_EMAIL' && purpose !== 'RESET_PASSWORD' && purpose !== 'PASSWORD_CHANGED') {
    throw new Error('invalid auth mail purpose');
  }
  return {
    id: requiredString(row.id, 'id'),
    actionDigest: nullableByteArrayValue(row.action_digest, 'action_digest'),
    userId: row.user_id === null ? null : requiredString(row.user_id, 'user_id'),
    purpose,
    priority,
    createdAt: numberValue(row.created_at, 'created_at'),
    expiresAt: numberValue(row.expires_at, 'expires_at'),
    payloadCiphertext: requiredString(row.payload_ciphertext, 'payload_ciphertext'),
    payloadIv: requiredString(row.payload_iv, 'payload_iv'),
    payloadKeyVersion: requiredString(row.payload_key_version, 'payload_key_version'),
    state: 'CLAIMED',
    leaseId: requiredString(row.lease_id, 'lease_id'),
    leaseUntil: numberValue(row.lease_until, 'lease_until'),
    attemptCount: numberValue(row.attempt_count, 'attempt_count'),
    nextAttemptAt: numberValue(row.next_attempt_at, 'next_attempt_at'),
    firstAttemptAt: nullableNumberValue(row.first_attempt_at, 'first_attempt_at'),
    providerMessageId: row.provider_message_id === null ? null : requiredString(row.provider_message_id, 'provider_message_id'),
    lastErrorCode: row.last_error_code === null ? null : requiredString(row.last_error_code, 'last_error_code'),
  };
}

async function freezeMailPayload(
  db: MysqlDatabase,
  id: string,
  leaseId: string,
  expected: SealedMailPayload,
  frozen: SealedMailPayload,
  observedAt: number,
): Promise<boolean> {
  assertSealedMailPayload(expected);
  assertSealedMailPayload(frozen);
  const result = await db.run(`UPDATE auth_mail_outbox
    SET payload_ciphertext = ?, payload_iv = ?, payload_key_version = ?
    WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ? AND attempt_count = 0
      AND payload_ciphertext = ? AND payload_iv = ? AND payload_key_version = ?`, [
    frozen.payloadCiphertext, frozen.payloadIv, frozen.payloadKeyVersion,
    id, leaseId, timestampValue(observedAt, 'observedAt'),
    expected.payloadCiphertext, expected.payloadIv, expected.payloadKeyVersion,
  ]);
  return result.affectedRows === 1;
}

function assertSealedMailPayload(payload: SealedMailPayload): void {
  if (!payload || typeof payload.payloadCiphertext !== 'string' || payload.payloadCiphertext.length < 24
    || payload.payloadCiphertext.length > 16_384
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.payloadCiphertext)
    || typeof payload.payloadIv !== 'string' || !/^[A-Za-z0-9+/]{16}$/u.test(payload.payloadIv)
    || typeof payload.payloadKeyVersion !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u.test(payload.payloadKeyVersion)) {
    throw new Error('invalid sealed auth mail payload');
  }
}

async function finishMail(db: MysqlDatabase, id: string, leaseId: string, result: MailFinishResult): Promise<boolean> {
  const observedAt = timestampValue(result.observedAt, 'observedAt');
  return db.transaction(async (transactionDb) => {
    const row = await transactionDb.first<MailOutboxRow>(`SELECT ${MAIL_OUTBOX_COLUMNS}
      FROM auth_mail_outbox
      WHERE id = ? AND state = 'CLAIMED' AND lease_id = ?
      FOR UPDATE`, [id, leaseId]);
    if (!row || numberValue(row.lease_until, 'lease_until') <= observedAt) return false;

    if (result.status === 'sent') {
      if (typeof result.providerMessageId !== 'string' || result.providerMessageId.length < 1 || result.providerMessageId.length > 191) {
        throw new Error('invalid mail provider message id');
      }
      const updated = await transactionDb.run(`UPDATE auth_mail_outbox
        SET state = 'SENT', lease_id = NULL, lease_until = NULL, provider_message_id = ?, last_error_code = NULL,
            payload_ciphertext = NULL, payload_iv = NULL
        WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ?`, [
        result.providerMessageId, id, leaseId, observedAt,
      ]);
      return updated.affectedRows === 1;
    }

    if (result.status === 'failed') {
      assertMailErrorCode(result.errorCode);
      const updated = await transactionDb.run(`UPDATE auth_mail_outbox
        SET state = 'FAILED', lease_id = NULL, lease_until = NULL, last_error_code = ?,
            payload_ciphertext = NULL, payload_iv = NULL
        WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ?`, [result.errorCode, id, leaseId, observedAt]);
      return updated.affectedRows === 1;
    }

    const expiresAt = numberValue(row.expires_at, 'expires_at');
    const attemptCount = numberValue(row.attempt_count, 'attempt_count');
    const firstAttemptAt = nullableNumberValue(row.first_attempt_at, 'first_attempt_at');
    if (result.status === 'retry') assertMailErrorCode(result.errorCode);
    if (result.status === 'paused') assertMailErrorCode(result.errorCode);
    const nextAttemptAt = result.status === 'release'
      ? observedAt
      : Math.min(timestampValue(result.nextAttemptAt, 'nextAttemptAt'), expiresAt);
    const retryWindowExpired = firstAttemptAt !== null
      && (observedAt - firstAttemptAt >= MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS
        || nextAttemptAt - firstAttemptAt >= MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS);
    const terminal = expiresAt <= observedAt
      || (result.status === 'retry' && (attemptCount >= MAIL_MAX_ATTEMPTS || retryWindowExpired || nextAttemptAt >= expiresAt));

    const updated = terminal
      ? await transactionDb.run(`UPDATE auth_mail_outbox
          SET state = ?, lease_id = NULL, lease_until = NULL, last_error_code = ?,
              payload_ciphertext = NULL, payload_iv = NULL
          WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ?`, [
        expiresAt <= observedAt ? 'CANCELLED' : 'FAILED',
        expiresAt <= observedAt ? 'MAIL_EXPIRED' : result.status === 'retry' ? result.errorCode : 'MAIL_RETRY_WINDOW_EXPIRED',
        id, leaseId, observedAt,
      ])
      : await transactionDb.run(`UPDATE auth_mail_outbox
          SET state = 'PENDING', lease_id = NULL, lease_until = NULL, next_attempt_at = ?,
              last_error_code = ?
          WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ?`, [
        nextAttemptAt,
        result.status === 'release' ? row.last_error_code : result.errorCode,
        id, leaseId, observedAt,
      ]);
    return updated.affectedRows === 1;
  });
}

function assertMailErrorCode(value: string): void {
  if (!/^[A-Z0-9_-]{1,64}$/u.test(value)) throw new Error('invalid auth mail error code');
}

interface MailAuthSnapshotRow extends MysqlRow {
  user_id: unknown;
  action_digest: unknown;
}

async function reserveMailAttempt(
  db: MysqlDatabase,
  id: string,
  leaseId: string,
  getNow: () => number,
  mailDailyLimit: number,
  mailMonthlyLimit: number,
): Promise<MailReservation> {
  const snapshot = await db.first<MailAuthSnapshotRow>(`SELECT CAST(user_id AS CHAR) AS user_id, action_digest
    FROM auth_mail_outbox WHERE id = ? LIMIT 1`, [id]);
  if (!snapshot) return { status: 'stale' };
  const snapshotUserId = snapshot.user_id === null ? null : requiredString(snapshot.user_id, 'user_id');
  const snapshotActionDigest = nullableByteArrayValue(snapshot.action_digest, 'action_digest');

  return db.transaction(async (transactionDb) => {
    const user = snapshotUserId === null ? null : await transactionDb.first<MailUserRow>(`SELECT email, status, credential_version
      FROM auth_users WHERE id = ? FOR UPDATE`, [snapshotUserId]);
    const action = snapshotActionDigest && user
      ? await transactionDb.first<MailActionRow>(`SELECT purpose, email_snapshot, credential_version, expires_at, consumed_at, revoked_at
          FROM auth_action_tokens
          WHERE token_digest = ? AND user_id = ?
          FOR UPDATE`, [snapshotActionDigest, snapshotUserId])
      : null;
    const job = await transactionDb.first<MailOutboxRow>(`SELECT ${MAIL_OUTBOX_COLUMNS}
      FROM auth_mail_outbox
      WHERE id = ? AND state = 'CLAIMED' AND lease_id = ?
      FOR UPDATE`, [id, leaseId]);
    if (!job) return { status: 'stale' };

    const lockedUserId = job.user_id === null ? null : requiredString(job.user_id, 'user_id');
    const actionDigest = nullableByteArrayValue(job.action_digest, 'action_digest');
    if (lockedUserId !== snapshotUserId || !sameNullableBytes(actionDigest, snapshotActionDigest)) {
      return releaseClaim(transactionDb, id, leaseId, timestampValue(getNow(), 'now'));
    }

    const firstNow = timestampValue(getNow(), 'now');
    if (numberValue(job.lease_until, 'lease_until') <= firstNow) return { status: 'stale' };
    const purpose = requiredString(job.purpose, 'purpose');
    const jobExpiresAt = numberValue(job.expires_at, 'expires_at');
    if (!isMailAuthorizationValid(user, action, actionDigest, purpose, jobExpiresAt, firstNow)) {
      await terminalizeClaimedMail(transactionDb, id, leaseId, 'CANCELLED', 'MAIL_AUTHORIZATION_INVALID');
      return { status: 'exhausted' };
    }

    const rateBuckets = mailBuckets(firstNow);
    const entries = mailRateEntries(rateBuckets);
    await ensureMailRateRows(transactionDb, entries);
    const rateRows = await lockMailRateRows(transactionDb, entries);
    const currentNow = timestampValue(getNow(), 'now');
    const currentBuckets = mailBuckets(currentNow);
    if (currentBuckets.dayBucketStart !== rateBuckets.dayBucketStart
      || currentBuckets.monthBucketStart !== rateBuckets.monthBucketStart) {
      return releaseClaim(transactionDb, id, leaseId, currentNow);
    }
    if (numberValue(job.lease_until, 'lease_until') <= currentNow) return { status: 'stale' };
    if (jobExpiresAt <= currentNow) {
      await terminalizeClaimedMail(transactionDb, id, leaseId, 'CANCELLED', 'MAIL_EXPIRED');
      return { status: 'exhausted' };
    }
    if (!isMailAuthorizationValid(user, action, actionDigest, purpose, jobExpiresAt, currentNow)) {
      await terminalizeClaimedMail(transactionDb, id, leaseId, 'CANCELLED', 'MAIL_AUTHORIZATION_INVALID');
      return { status: 'exhausted' };
    }

    const attemptCount = numberValue(job.attempt_count, 'attempt_count');
    const firstAttemptAt = nullableNumberValue(job.first_attempt_at, 'first_attempt_at');
    if (attemptCount >= MAIL_MAX_ATTEMPTS
      || (firstAttemptAt !== null && currentNow - firstAttemptAt >= MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS)) {
      await terminalizeClaimedMail(transactionDb, id, leaseId, 'FAILED', 'MAIL_ATTEMPTS_EXHAUSTED');
      return { status: 'exhausted' };
    }

    const monthlyBudget = rateRows.get(rateRowId('mail-budget-monthly', rateBuckets.monthBucketStart));
    const monthlyProvider = rateRows.get(rateRowId('mail-provider-monthly', rateBuckets.monthBucketStart));
    if (countValue(monthlyBudget) >= mailMonthlyLimit) {
      await writeLocalBudgetPause(transactionDb, 'mail-budget-monthly', rateBuckets.monthBucketStart, rateBuckets.nextMonthStart);
      await terminalizeClaimedMail(transactionDb, id, leaseId, 'FAILED', 'MAIL_MONTHLY_QUOTA');
      return { status: 'quota' };
    }
    if (providerPauseActive(monthlyProvider, currentNow)) {
      const nextAttemptAt = Math.max(currentNow, numberValue(monthlyProvider!.next_allowed_at, 'next_allowed_at'));
      return releaseClaim(transactionDb, id, leaseId, nextAttemptAt, 'MAIL_MONTHLY_QUOTA');
    }

    const dailyBudget = rateRows.get(rateRowId('mail-budget-daily', rateBuckets.dayBucketStart));
    const dailyProvider = rateRows.get(rateRowId('mail-provider-daily', rateBuckets.dayBucketStart));
    if (countValue(dailyBudget) >= mailDailyLimit) {
      await writeLocalBudgetPause(transactionDb, 'mail-budget-daily', rateBuckets.dayBucketStart, rateBuckets.nextDayStart);
      await terminalizeClaimedMail(transactionDb, id, leaseId, 'FAILED', 'MAIL_DAILY_QUOTA');
      return { status: 'quota' };
    }
    if (providerPauseActive(dailyProvider, currentNow)) {
      const nextAttemptAt = Math.max(currentNow, numberValue(dailyProvider!.next_allowed_at, 'next_allowed_at'));
      return releaseClaim(transactionDb, id, leaseId, nextAttemptAt, 'MAIL_DAILY_QUOTA');
    }

    const updated = await transactionDb.run(`UPDATE auth_mail_outbox
      SET attempt_count = attempt_count + 1, first_attempt_at = COALESCE(first_attempt_at, ?)
      WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ? AND attempt_count < ?`, [
      currentNow, id, leaseId, currentNow, MAIL_MAX_ATTEMPTS,
    ]);
    if (updated.affectedRows !== 1) return { status: 'stale' };
    await incrementMailBudget(transactionDb, 'mail-budget-daily', rateBuckets.dayBucketStart);
    await incrementMailBudget(transactionDb, 'mail-budget-monthly', rateBuckets.monthBucketStart);
    return {
      status: 'reserved',
      attempt: {
        reservedAt: currentNow,
        dayBucketStart: rateBuckets.dayBucketStart,
        monthBucketStart: rateBuckets.monthBucketStart,
      },
    };
  });
}

function isMailAuthorizationValid(
  user: MailUserRow | null,
  action: MailActionRow | null,
  actionDigest: Uint8Array | null,
  purpose: string,
  jobExpiresAt: number,
  now: number,
): boolean {
  if (!user || requiredString(user.status, 'status') === 'DISABLED') return false;
  if (actionDigest === null) return purpose === 'PASSWORD_CHANGED';
  if (purpose !== 'VERIFY_EMAIL' && purpose !== 'RESET_PASSWORD') return false;
  if (!action) return false;
  return requiredString(action.purpose, 'purpose') === purpose
    && requiredString(action.email_snapshot, 'email_snapshot') === requiredString(user.email, 'email')
    && numberValue(action.credential_version, 'credential_version') === numberValue(user.credential_version, 'credential_version')
    && numberValue(action.expires_at, 'expires_at') === jobExpiresAt
    && numberValue(action.expires_at, 'expires_at') > now
    && action.consumed_at === null
    && action.revoked_at === null
    && (purpose !== 'VERIFY_EMAIL' || requiredString(user.status, 'status') === 'PENDING_EMAIL');
}

async function releaseClaim(
  db: MysqlDatabase,
  id: string,
  leaseId: string,
  nextAttemptAt: number,
  errorCode?: string,
): Promise<MailReservation> {
  const result = await db.run(`UPDATE auth_mail_outbox
    SET state = 'PENDING', lease_id = NULL, lease_until = NULL, next_attempt_at = ?, last_error_code = ?
    WHERE id = ? AND state = 'CLAIMED' AND lease_id = ?`, [
    timestampValue(nextAttemptAt, 'nextAttemptAt'), errorCode ?? null, id, leaseId,
  ]);
  return result.affectedRows === 1 ? { status: errorCode ? 'quota' : 'stale' } : { status: 'stale' };
}

async function terminalizeClaimedMail(
  db: MysqlDatabase,
  id: string,
  leaseId: string,
  state: 'FAILED' | 'CANCELLED',
  errorCode: string,
): Promise<void> {
  await db.run(`UPDATE auth_mail_outbox
    SET state = ?, lease_id = NULL, lease_until = NULL, payload_ciphertext = NULL, payload_iv = NULL, last_error_code = ?
    WHERE id = ? AND state = 'CLAIMED' AND lease_id = ?`, [state, errorCode, id, leaseId]);
}

function mailRateEntries(buckets: MailBuckets): MailRateEntry[] {
  const entries: MailRateEntry[] = [
    { scope: 'mail-budget-daily', bucketStart: buckets.dayBucketStart, expiresAt: buckets.nextDayStart + DAY_MILLISECONDS },
    { scope: 'mail-budget-monthly', bucketStart: buckets.monthBucketStart, expiresAt: buckets.nextMonthStart + DAY_MILLISECONDS },
    { scope: 'mail-provider-daily', bucketStart: buckets.dayBucketStart, expiresAt: buckets.nextDayStart + DAY_MILLISECONDS },
    { scope: 'mail-provider-monthly', bucketStart: buckets.monthBucketStart, expiresAt: buckets.nextMonthStart + DAY_MILLISECONDS },
  ];
  return entries.sort((left, right) => compareAscii(left.scope, right.scope));
}

async function ensureMailRateRows(db: MysqlDatabase, entries: readonly MailRateEntry[]): Promise<void> {
  for (const entry of entries) {
    await db.run(`INSERT INTO auth_rate_limits
        (scope, key_digest, bucket_start, request_count, next_allowed_at, expires_at)
      VALUES (?, ?, ?, 0, 0, ?)
      ON DUPLICATE KEY UPDATE request_count = request_count`, [
      entry.scope, ZERO_RATE_KEY_DIGEST, entry.bucketStart, entry.expiresAt,
    ]);
  }
}

async function lockMailRateRows(db: MysqlDatabase, entries: readonly MailRateEntry[]): Promise<Map<string, MailLimitRow>> {
  const records = new Map<string, MailLimitRow>();
  for (const entry of entries) {
    const row = await db.first<MailLimitRow>(`SELECT scope, request_count, next_allowed_at, expires_at
      FROM auth_rate_limits
      WHERE scope = ? AND key_digest = ? AND bucket_start = ?
      FOR UPDATE`, [entry.scope, ZERO_RATE_KEY_DIGEST, entry.bucketStart]);
    if (!row) throw new Error('mail rate row missing after lock');
    records.set(rateRowId(entry.scope, entry.bucketStart), row);
  }
  return records;
}

function rateRowId(scope: string, bucketStart: number): string {
  return `${scope}\0${bucketStart}`;
}

async function incrementMailBudget(db: MysqlDatabase, scope: 'mail-budget-daily' | 'mail-budget-monthly', bucketStart: number): Promise<void> {
  const result = await db.run(`UPDATE auth_rate_limits
    SET request_count = request_count + 1
    WHERE scope = ? AND key_digest = ? AND bucket_start = ?`, [scope, ZERO_RATE_KEY_DIGEST, bucketStart]);
  if (result.affectedRows !== 1) throw new Error('mail budget row missing after reservation');
}

async function writeLocalBudgetPause(
  db: MysqlDatabase,
  scope: 'mail-budget-daily' | 'mail-budget-monthly',
  bucketStart: number,
  retryAt: number,
): Promise<void> {
  const nextAllowedAt = timestampValue(retryAt, 'retryAt');
  await db.run(`UPDATE auth_rate_limits
    SET next_allowed_at = ?, expires_at = ?
    WHERE scope = ? AND key_digest = ? AND bucket_start = ?`, [
    nextAllowedAt, timestampValue(nextAllowedAt + DAY_MILLISECONDS, 'pause expiresAt'), scope, ZERO_RATE_KEY_DIGEST, bucketStart,
  ]);
}

async function recordProviderQuota(
  db: MysqlDatabase,
  id: string,
  leaseId: string,
  kind: 'daily' | 'monthly',
  attempt: MailAttemptContext,
  observedAt: number,
): Promise<{ pauseRecorded: boolean; jobUpdated: boolean }> {
  const responseAt = timestampValue(observedAt, 'observedAt');
  const reservedAt = timestampValue(attempt.reservedAt, 'reservedAt');
  const buckets = mailBuckets(reservedAt);
  if (attempt.dayBucketStart !== buckets.dayBucketStart || attempt.monthBucketStart !== buckets.monthBucketStart) {
    throw new Error('mail attempt buckets do not match reservation time');
  }
  const scope = kind === 'daily' ? 'mail-provider-daily' : 'mail-provider-monthly';
  const bucketStart = kind === 'daily' ? buckets.dayBucketStart : buckets.monthBucketStart;
  const nextAllowedAt = kind === 'daily' ? buckets.nextDayStart : buckets.nextMonthStart;
  const expiresAt = timestampValue(nextAllowedAt + DAY_MILLISECONDS, 'provider pause expiresAt');
  const errorCode = kind === 'daily' ? 'MAIL_DAILY_QUOTA' : 'MAIL_MONTHLY_QUOTA';

  return db.transaction(async (transactionDb) => {
    const jobResult = await transactionDb.run(`UPDATE auth_mail_outbox
      SET state = 'FAILED', lease_id = NULL, lease_until = NULL, last_error_code = ?,
          payload_ciphertext = NULL, payload_iv = NULL
      WHERE id = ? AND state = 'CLAIMED' AND lease_id = ? AND lease_until > ?`, [errorCode, id, leaseId, responseAt]);
    await transactionDb.run(`INSERT INTO auth_rate_limits
        (scope, key_digest, bucket_start, request_count, next_allowed_at, expires_at)
      VALUES (?, ?, ?, 0, ?, ?) AS incoming
      ON DUPLICATE KEY UPDATE
        next_allowed_at = GREATEST(auth_rate_limits.next_allowed_at, incoming.next_allowed_at),
        expires_at = GREATEST(auth_rate_limits.expires_at, incoming.expires_at)`, [
      scope, ZERO_RATE_KEY_DIGEST, bucketStart, nextAllowedAt, expiresAt,
    ]);
    return { pauseRecorded: true, jobUpdated: jobResult.affectedRows === 1 };
  });
}

function sameNullableBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return digestKey(left) === digestKey(right);
}

function nullableByteArrayValue(value: unknown, name: string): Uint8Array | null {
  return value == null ? null : byteArrayValue(value, name);
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: requiredString(row.id, 'id'),
    email: requiredString(row.email, 'email'),
    emailNormalized: requiredString(row.email_normalized, 'email_normalized'),
    displayName: requiredString(row.display_name, 'display_name'),
    status: requiredString(row.status, 'status') as AccountStatus,
    emailVerifiedAt: nullableNumberValue(row.email_verified_at, 'email_verified_at'),
    credentialVersion: numberValue(row.credential_version, 'credential_version'),
    authVersion: numberValue(row.auth_version, 'auth_version'),
    avatarVersion: numberValue(row.avatar_version, 'avatar_version'),
    createdAt: numberValue(row.created_at, 'created_at'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

function mapCredential(row: CredentialRow): CredentialSnapshot {
  return {
    userId: requiredString(row.user_id, 'user_id'),
    status: requiredString(row.status, 'status') as AccountStatus,
    credentialVersion: numberValue(row.credential_version, 'credential_version'),
    authVersion: numberValue(row.auth_version, 'auth_version'),
    scheme: requiredString(row.scheme, 'scheme'),
    salt: byteArrayValue(row.salt, 'salt'),
    digest: byteArrayValue(row.digest, 'digest'),
    keyVersion: requiredString(row.key_version, 'key_version'),
  };
}

function mapSession(row: MysqlRow): AuthSessionRecord {
  return {
    tokenDigest: byteArrayValue(row.token_digest, 'token_digest'),
    userId: requiredString(row.user_id, 'user_id'),
    credentialVersion: numberValue(row.credential_version, 'credential_version'),
    authVersion: numberValue(row.auth_version, 'auth_version'),
    createdAt: numberValue(row.created_at, 'created_at'),
    lastSeenAt: numberValue(row.last_seen_at, 'last_seen_at'),
    expiresAt: numberValue(row.expires_at, 'expires_at'),
    revokedAt: nullableNumberValue(row.revoked_at, 'revoked_at'),
  };
}

function mapAction(row: MysqlRow): ActionSnapshot {
  return {
    tokenDigest: byteArrayValue(row.token_digest, 'token_digest'),
    userId: requiredString(row.user_id, 'user_id'),
    purpose: requiredString(row.purpose, 'purpose') as ActionPurpose,
    emailSnapshot: requiredString(row.email_snapshot, 'email_snapshot'),
    credentialVersion: numberValue(row.credential_version, 'credential_version'),
    createdAt: numberValue(row.created_at, 'created_at'),
    expiresAt: numberValue(row.expires_at, 'expires_at'),
    consumedAt: nullableNumberValue(row.consumed_at, 'consumed_at'),
    revokedAt: nullableNumberValue(row.revoked_at, 'revoked_at'),
  };
}

function reusableMailState(row: ReusableMailOutboxRow, now: number): 'PENDING' | 'CLAIMED' | null {
  const state = requiredString(row.state, 'state');
  const expiresAt = numberValue(row.expires_at, 'expires_at');
  const nextAttemptAt = numberValue(row.next_attempt_at, 'next_attempt_at');
  if (expiresAt <= now || nextAttemptAt >= expiresAt || numberValue(row.has_payload, 'has_payload') !== 1) return null;

  if (state === 'CLAIMED') {
    const leaseUntil = nullableNumberValue(row.lease_until, 'lease_until');
    if (leaseUntil !== null && leaseUntil > now) return 'CLAIMED';
  }

  const attemptCount = numberValue(row.attempt_count, 'attempt_count');
  const firstAttemptAt = nullableNumberValue(row.first_attempt_at, 'first_attempt_at');
  if (attemptCount >= MAIL_MAX_ATTEMPTS
    || (firstAttemptAt !== null && firstAttemptAt <= Math.max(0, now - MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS))) return null;
  if (state === 'PENDING') return 'PENDING';
  if (state === 'CLAIMED' && nullableNumberValue(row.lease_until, 'lease_until') !== null) return 'CLAIMED';
  return null;
}

function countValue(row: MailLimitRow | undefined): number {
  return row ? numberValue(row.request_count, 'request_count') : 0;
}

interface RateLimitLockRow {
  rule: AuthRateLimitRule;
  scope: string;
  keyDigest: Uint8Array;
  digestHex: string;
  bucketStart: number;
  expiresAt: number;
}

function prepareRateLimitRows(rules: readonly AuthRateLimitRule[], now: number): RateLimitLockRow[] {
  const rows = rules.map((rule): RateLimitLockRow => {
    if (!(rule.keyDigest instanceof Uint8Array) || rule.keyDigest.byteLength !== 32) throw new Error('invalid auth rate limit digest');
    const digestHex = digestKey(rule.keyDigest);
    if (rule.kind === 'window') {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(rule.scope) || rule.scope === 'mail_cooldown'
        || !Number.isSafeInteger(rule.limit) || rule.limit < 1 || rule.limit > 4_294_967_294
        || !Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1) {
        throw new Error('invalid auth rate limit rule');
      }
      const bucketStart = Math.floor(now / rule.windowMs) * rule.windowMs;
      const expiresAt = timestampValue(bucketStart + rule.windowMs, 'rate limit expires_at');
      return { rule, scope: rule.scope, keyDigest: new Uint8Array(rule.keyDigest), digestHex, bucketStart, expiresAt };
    }
    if (rule.scope !== 'mail_cooldown' || !Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 1) {
      throw new Error('invalid auth cooldown rule');
    }
    return {
      rule,
      scope: rule.scope,
      keyDigest: new Uint8Array(rule.keyDigest),
      digestHex,
      bucketStart: 0,
      expiresAt: timestampValue(now + rule.cooldownMs, 'cooldown expires_at'),
    };
  });

  const uniqueRows = new Set<string>();
  for (const row of rows) {
    const id = rateLimitRowId(row);
    if (uniqueRows.has(id)) throw new Error('duplicate auth rate limit rule');
    uniqueRows.add(id);
  }
  return rows.sort((left, right) => compareAscii(left.scope, right.scope)
    || compareAscii(left.digestHex, right.digestHex)
    || left.bucketStart - right.bucketStart);
}

function rateLimitRowId(row: Pick<RateLimitLockRow, 'scope' | 'digestHex' | 'bucketStart'>): string {
  return `${row.scope}\0${row.digestHex}\0${row.bucketStart}`;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerPauseActive(row: MailLimitRow | undefined, now: number): boolean {
  return row !== undefined
    && numberValue(row.next_allowed_at, 'next_allowed_at') > now
    && numberValue(row.expires_at, 'expires_at') > now;
}

function digestKey(digest: Uint8Array): string {
  let value = '';
  for (const byte of digest) value += byte.toString(16).padStart(2, '0');
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`invalid auth repository ${name}`);
  return value;
}

function numberValue(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid auth repository ${name}`);
  return number;
}

function nullableNumberValue(value: unknown, name: string): number | null {
  return value == null ? null : numberValue(value, name);
}

function byteArrayValue(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`invalid auth repository ${name}`);
  return new Uint8Array(value);
}

function timestampValue(value: number, name: string): number {
  const timestamp = numberValue(value, name);
  if (!Number.isSafeInteger(timestamp)) throw new Error(`invalid auth repository ${name}`);
  return timestamp;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
