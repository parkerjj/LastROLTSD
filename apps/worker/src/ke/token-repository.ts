import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../db/mysql-client';

export type DeviceStatus = 'PENDING' | 'APPROVED' | 'DENIED';

export interface DeviceCodeRow {
  id: number;
  user_code: string;
  status: DeviceStatus;
  user_id: number | null;
  label: string;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
}

export interface TokenRow {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
}

/** Bearer 校验通过后的最小身份信息。 */
export interface BearerRecord {
  id: number;
  user_id: number;
  last_used_at: number;
}

export interface TokenUser {
  credentialVersion: number;
  authVersion: number;
  /** 账号可用：未禁用，且（ACTIVE 时）邮箱已验证——与会话的放行规则一致。 */
  usable: boolean;
}

export interface NewDeviceCode {
  digest: Uint8Array;
  userCode: string;
  label: string;
  ipHash: Uint8Array | null;
  uaHash: Uint8Array | null;
  now: number;
  expiresAt: number;
}

export interface NewToken {
  userId: number;
  digest: Uint8Array;
  label: string;
  credentialVersion: number;
  authVersion: number;
  ipHash: Uint8Array | null;
  uaHash: Uint8Array | null;
  now: number;
  expiresAt: number;
}

/** 事务作用域：设备码兑换 token（锁设备码行 + 账号行，保证一个设备码只能兑换一次）。 */
export interface TokenTx {
  readUserForUpdate(userId: number): Promise<TokenUser | null>;
  findDeviceByDigestForUpdate(digest: Uint8Array): Promise<DeviceCodeRow | null>;
  markPolled(id: number, now: number): Promise<void>;
  deleteDevice(id: number): Promise<void>;
  countActiveTokens(userId: number, now: number): Promise<number>;
  revokeLeastRecentlyUsed(userId: number, now: number): Promise<void>;
  insertToken(token: NewToken): Promise<number>;
}

export interface TokenRepository {
  /** 返回 false 表示 user_code 撞号（调用方换一个再试）。 */
  insertDeviceCode(code: NewDeviceCode): Promise<boolean>;
  findPendingByUserCode(userCode: string, now: number): Promise<DeviceCodeRow | null>;
  /** 仅在 PENDING 且未过期时生效；返回是否命中。 */
  decide(userCode: string, userId: number, status: 'APPROVED' | 'DENIED', now: number): Promise<boolean>;
  readBearer(digest: Uint8Array, now: number): Promise<BearerRecord | null>;
  touchToken(id: number, now: number, expiresAt: number): Promise<void>;
  listTokens(userId: number, now: number): Promise<TokenRow[]>;
  revokeToken(userId: number, id: number, now: number): Promise<boolean>;
  transaction<T>(work: (tx: TokenTx) => Promise<T>): Promise<T>;
}

const ER_DUP_ENTRY = 1062;

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function readDevice(row: MysqlRow): DeviceCodeRow {
  return {
    id: asNumber(row.id),
    user_code: String(row.user_code),
    status: String(row.status) as DeviceStatus,
    user_id: asNullableNumber(row.user_id),
    label: typeof row.label === 'string' ? row.label : '',
    last_polled_at: asNullableNumber(row.last_polled_at),
    created_at: asNumber(row.created_at),
    expires_at: asNumber(row.expires_at),
  };
}

const DEVICE_COLUMNS = 'id, user_code, status, user_id, label, last_polled_at, created_at, expires_at';

function txFor(db: MysqlDatabase): TokenTx {
  return {
    async readUserForUpdate(userId) {
      const row = await db.first<MysqlRow>(
        'SELECT credential_version, auth_version, status, email_verified_at FROM auth_users WHERE id = ? FOR UPDATE',
        [userId],
      );
      if (row === null) return null;
      const status = String(row.status);
      return {
        credentialVersion: asNumber(row.credential_version),
        authVersion: asNumber(row.auth_version),
        usable: status !== 'DISABLED' && (status !== 'ACTIVE' || row.email_verified_at !== null),
      };
    },

    async findDeviceByDigestForUpdate(digest) {
      const row = await db.first<MysqlRow>(`SELECT ${DEVICE_COLUMNS} FROM ke_device_codes WHERE device_digest = ? FOR UPDATE`, [digest]);
      return row === null ? null : readDevice(row);
    },

    async markPolled(id, now) {
      await db.run('UPDATE ke_device_codes SET last_polled_at = ? WHERE id = ?', [now, id]);
    },

    async deleteDevice(id) {
      await db.run('DELETE FROM ke_device_codes WHERE id = ?', [id]);
    },

    async countActiveTokens(userId, now) {
      const row = await db.first<MysqlRow>(
        'SELECT COUNT(*) AS cnt FROM ke_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
        [userId, now],
      );
      return row === null ? 0 : asNumber(row.cnt);
    },

    async revokeLeastRecentlyUsed(userId, now) {
      await db.run(
        'UPDATE ke_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at ASC, id ASC LIMIT 1',
        [now, userId, now],
      );
    },

    async insertToken(token) {
      const result = await db.run(
        'INSERT INTO ke_tokens (user_id, token_digest, label, credential_version, auth_version, ip_hash, ua_hash, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [token.userId, token.digest, token.label, token.credentialVersion, token.authVersion, token.ipHash, token.uaHash, token.now, token.now, token.expiresAt],
      );
      return result.insertId;
    },
  };
}

export function createTokenRepository(database: MysqlDatabase): TokenRepository {
  return {
    async insertDeviceCode(code) {
      try {
        await database.run(
          'INSERT INTO ke_device_codes (device_digest, user_code, status, label, ip_hash, ua_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [code.digest, code.userCode, 'PENDING', code.label, code.ipHash, code.uaHash, code.now, code.expiresAt],
        );
        return true;
      } catch (error) {
        if (error instanceof MysqlDatabaseError && error.errno === ER_DUP_ENTRY) return false;
        throw error;
      }
    },

    async findPendingByUserCode(userCode, now) {
      const row = await database.first<MysqlRow>(
        `SELECT ${DEVICE_COLUMNS} FROM ke_device_codes WHERE user_code = ? AND status = 'PENDING' AND expires_at > ?`,
        [userCode, now],
      );
      return row === null ? null : readDevice(row);
    },

    async decide(userCode, userId, status, now) {
      const result = await database.run(
        "UPDATE ke_device_codes SET status = ?, user_id = ? WHERE user_code = ? AND status = 'PENDING' AND expires_at > ?",
        [status, userId, userCode, now],
      );
      return result.affectedRows > 0;
    },

    async readBearer(digest, now) {
      const row = await database.first<MysqlRow>(
        `SELECT t.id, t.user_id, t.last_used_at
         FROM ke_tokens AS t
         INNER JOIN auth_users AS u ON u.id = t.user_id
         WHERE t.token_digest = ?
           AND t.revoked_at IS NULL
           AND t.expires_at > ?
           AND t.credential_version = u.credential_version
           AND t.auth_version = u.auth_version
           AND u.status <> 'DISABLED'
           AND (u.status <> 'ACTIVE' OR u.email_verified_at IS NOT NULL)
         LIMIT 1`,
        [digest, now],
      );
      return row === null ? null : { id: asNumber(row.id), user_id: asNumber(row.user_id), last_used_at: asNumber(row.last_used_at) };
    },

    async touchToken(id, now, expiresAt) {
      await database.run('UPDATE ke_tokens SET last_used_at = ?, expires_at = ? WHERE id = ?', [now, expiresAt, id]);
    },

    async listTokens(userId, now) {
      const rows = await database.all<MysqlRow>(
        'SELECT id, label, created_at, last_used_at, expires_at FROM ke_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC, id DESC',
        [userId, now],
      );
      return rows.map((row) => ({
        id: asNumber(row.id),
        label: typeof row.label === 'string' ? row.label : '',
        created_at: asNumber(row.created_at),
        last_used_at: asNumber(row.last_used_at),
        expires_at: asNumber(row.expires_at),
      }));
    },

    async revokeToken(userId, id, now) {
      const result = await database.run(
        'UPDATE ke_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
        [now, id, userId],
      );
      return result.affectedRows > 0;
    },

    transaction: (work) => database.transaction((db) => work(txFor(db))),
  };
}
