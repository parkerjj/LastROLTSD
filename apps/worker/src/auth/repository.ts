import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import type {
  AuthRateLimitRule,
  AccountProfile,
  AccountStatus,
  ActionPurpose,
  AuthIdentity,
  ClaimedMailJob,
  CredentialSnapshot,
  MailAvailability,
  NewMailJob,
  PasswordMaterial,
  UserId,
} from './types';

export type {
  ClaimedMailJob,
  CredentialSnapshot,
  NewMailJob,
  PasswordMaterial,
  UserId,
} from './types';

const DAY_MILLISECONDS = 86_400_000;
const ZERO_RATE_KEY_DIGEST = new Uint8Array(32);
const MAIL_DAILY_LIMIT = 100;
const MAIL_MONTHLY_LIMIT = 3_000;

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
  insertAction(input: NewActionToken): Promise<void>;
  consumeAction(tokenDigest: Uint8Array, now: number): Promise<boolean>;
  revokeActions(userId: UserId, purposeOrAll: ActionPurpose | 'all', now: number): Promise<number>;
  markEmailVerified(userId: UserId, now: number): Promise<boolean>;
  saveDisplayName(userId: UserId, displayName: string, now: number): Promise<void>;
  saveAvatar(userId: UserId, base64OrNull: string | null, now: number): Promise<void>;
  insertMailJob(input: NewMailJob): Promise<void>;
  appendEvent(input: AuthSecurityEventInput): Promise<void>;
}

export interface AuthRepository {
  readCredentialByEmail(emailNormalized: string): Promise<CredentialSnapshot | null>;
  readProfile(userId: UserId): Promise<AccountProfile | null>;
  readIdentity(sessionDigest: Uint8Array, now: number): Promise<AuthIdentity | null>;
  transaction<T>(work: (tx: AuthTx) => Promise<T>): Promise<T>;
  readActionSnapshot(tokenDigest: Uint8Array): Promise<ActionSnapshot | null>;
  readMailAvailability(now: number): Promise<MailAvailability>;
  consumeAuthRateLimits(rules: readonly AuthRateLimitRule[], now: () => number): Promise<{ allowed: boolean; retryAfter: number }>;
  readAvatar(userId: UserId): Promise<{ base64: string | null; version: number } | null>;
}

interface MailLimitRow extends MysqlRow {
  scope: unknown;
  request_count: unknown;
  next_allowed_at: unknown;
  expires_at: unknown;
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
  email_verified_at: unknown;
  created_at: unknown;
  has_avatar: unknown;
  avatar_version: unknown;
}

const USER_COLUMNS = `CAST(id AS CHAR) AS id, email, email_normalized, display_name, status,
  email_verified_at, credential_version, auth_version, avatar_version, created_at, updated_at`;
const CREDENTIAL_COLUMNS = `CAST(u.id AS CHAR) AS user_id, u.status, u.credential_version, u.auth_version,
  c.scheme, c.salt, c.digest, c.key_version`;

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
          u.email_verified_at, u.created_at, u.avatar_version,
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
        email_verified_at: nullableNumberValue(row.email_verified_at, 'email_verified_at'),
        created_at: numberValue(row.created_at, 'created_at'),
        has_avatar: numberValue(row.has_avatar, 'has_avatar') === 1,
        avatar_version: avatarVersion,
        avatar_url: `/api/v1/users/${id}/avatar?v=${avatarVersion}`,
      };
    },

    async readIdentity(sessionDigest, now) {
      const row = await db.first<MysqlRow>(`SELECT CAST(s.user_id AS CHAR) AS user_id, u.status,
          s.credential_version, s.auth_version
        FROM auth_sessions AS s
        INNER JOIN auth_users AS u ON u.id = s.user_id
        WHERE s.token_digest = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > ?
          AND s.credential_version = u.credential_version
          AND s.auth_version = u.auth_version
          AND u.status <> 'DISABLED'
        LIMIT 1`, [sessionDigest, timestampValue(now, 'now')]);
      if (!row) return null;
      return {
        userId: requiredString(row.user_id, 'user_id'),
        status: requiredString(row.status, 'status') as AccountStatus,
        credentialVersion: numberValue(row.credential_version, 'credential_version'),
        authVersion: numberValue(row.auth_version, 'auth_version'),
        sessionDigest: new Uint8Array(sessionDigest),
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
      const currentTime = timestampValue(now, 'now');
      const dayBucketStart = Math.floor(currentTime / DAY_MILLISECONDS) * DAY_MILLISECONDS;
      const nextDayStart = dayBucketStart + DAY_MILLISECONDS;
      const date = new Date(currentTime);
      if (!Number.isFinite(date.getTime())) throw new Error('now must be a valid timestamp');
      const monthBucketStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
      const rows = await db.all<MailLimitRow>(`SELECT scope, request_count, next_allowed_at, expires_at
        FROM auth_rate_limits
        WHERE key_digest = ?
          AND ((scope = ? AND bucket_start = ?)
            OR (scope = ? AND bucket_start = ?)
            OR (scope = ? AND bucket_start = ?)
            OR (scope = ? AND bucket_start = ?))`, [
        ZERO_RATE_KEY_DIGEST,
        'mail-budget-daily', dayBucketStart,
        'mail-budget-monthly', monthBucketStart,
        'mail-provider-daily', dayBucketStart,
        'mail-provider-monthly', monthBucketStart,
      ]);
      const byScope = new Map(rows.map((row) => [requiredString(row.scope, 'scope'), row]));
      const monthlyBudget = byScope.get('mail-budget-monthly');
      const monthlyProvider = byScope.get('mail-provider-monthly');
      if (countValue(monthlyBudget) >= mailMonthlyLimit || providerPauseActive(monthlyProvider, currentTime)) {
        return { code: 'MAIL_MONTHLY_QUOTA', retry_at: null };
      }
      const dailyBudget = byScope.get('mail-budget-daily');
      const dailyProvider = byScope.get('mail-provider-daily');
      if (countValue(dailyBudget) >= mailDailyLimit || providerPauseActive(dailyProvider, currentTime)) {
        return { code: 'MAIL_DAILY_QUOTA', retry_at: nextDayStart };
      }
      return { code: 'AVAILABLE', retry_at: null };
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
      const result = await db.run(`UPDATE auth_sessions
        SET last_seen_at = ?, expires_at = ?
        WHERE token_digest = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`, [
        at, timestampValue(expiresAt, 'expiresAt'), tokenDigest, owner, at,
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
      const result = await db.run(`UPDATE auth_users
        SET email_verified_at = ?, status = 'ACTIVE', updated_at = ?
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
