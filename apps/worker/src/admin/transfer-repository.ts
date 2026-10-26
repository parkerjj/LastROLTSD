import { insertActivityRow } from '../activity/repository';
import type { ActivityRow } from '../activity/types';
import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import { normalizeEmail } from '../auth/input';
import { insertAdminAudit } from './audit';
import { USER_COLUMNS, readUser } from './repository';
import type { AdminAuditEntry, AdminUserRow } from './types';

export interface TransferCharacter {
  aid: number;
  cid: number;
  nid: number;
  char_name: string;
  base_level: number | null;
  job_level: number | null;
  job_id: number | null;
  bound_at: number | null;
}

export interface TransferTx {
  /** 按 id 升序加行锁，避免两个并发转移互相等待造成死锁。 */
  lockUsers(ids: number[]): Promise<void>;
  lockCharacter(aid: number, cid: number, nid: number): Promise<(TransferCharacter & { user_id: number | null }) | null>;
  /** 角色改归 toUserId：user_id、bound_at（重新计 30 天锁定期）、updated_at。 */
  moveCharacter(aid: number, cid: number, nid: number, toUserId: number, now: number): Promise<void>;
  listProfilesForUpdate(userId: number, aid: number, cid: number, nid: number): Promise<Array<{ id: number; name: string; is_active: boolean }>>;
  moveProfile(id: number, toUserId: number, name: string, isActive: boolean, now: number): Promise<void>;
  /** 把以这些配置为来源的大厅分享的 source_profile_id 置空（分享仍归原作者），返回被断开的分享 id。 */
  detachShares(profileIds: number[]): Promise<number[]>;
  insertAudit(entry: AdminAuditEntry): Promise<void>;
  insertActivity(row: ActivityRow): Promise<void>;
}

export interface TransferRepository {
  /** 纯数字按用户 ID；含 @ 按规范化后的邮箱；其余（含非法邮箱）一律当作不存在。 */
  resolveUser(account: string): Promise<AdminUserRow | null>;
  listCharacters(userId: number): Promise<TransferCharacter[]>;
  findCharacter(aid: number, cid: number, nid: number): Promise<(TransferCharacter & { user_id: number | null }) | null>;
  /** 账号当前出现过的 aid：ke_characters ∪ ke_instances。 */
  listAids(userId: number): Promise<number[]>;
  transaction<T>(work: (tx: TransferTx) => Promise<T>): Promise<T>;
}

const CHARACTER_COLUMNS = 'aid, cid, nid, user_id, char_name, base_level, job_level, job_id, bound_at';
const MAX_CHARACTERS = 500;

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function readCharacter(row: MysqlRow): TransferCharacter & { user_id: number | null } {
  return {
    aid: asNumber(row.aid),
    cid: asNumber(row.cid),
    nid: asNumber(row.nid),
    user_id: asNullableNumber(row.user_id),
    char_name: String(row.char_name),
    base_level: asNullableNumber(row.base_level),
    job_level: asNullableNumber(row.job_level),
    job_id: asNullableNumber(row.job_id),
    bound_at: asNullableNumber(row.bound_at),
  };
}

function withoutOwner({ user_id: _owner, ...character }: TransferCharacter & { user_id: number | null }): TransferCharacter {
  return character;
}

function txFor(db: MysqlDatabase): TransferTx {
  return {
    async lockUsers(ids) {
      for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
        await db.first<MysqlRow>('SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [id]);
      }
    },

    async lockCharacter(aid, cid, nid) {
      const row = await db.first<MysqlRow>(
        `SELECT ${CHARACTER_COLUMNS} FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ? FOR UPDATE`, [aid, cid, nid]);
      return row ? readCharacter(row) : null;
    },

    async moveCharacter(aid, cid, nid, toUserId, now) {
      await db.run(
        'UPDATE ke_characters SET user_id = ?, bound_at = ?, updated_at = ? WHERE aid = ? AND cid = ? AND nid = ?',
        [toUserId, now, now, aid, cid, nid]);
    },

    async listProfilesForUpdate(userId, aid, cid, nid) {
      const rows = await db.all<MysqlRow>(
        'SELECT id, name, is_active FROM ke_profiles WHERE user_id = ? AND aid = ? AND cid = ? AND nid = ? ORDER BY id FOR UPDATE',
        [userId, aid, cid, nid]);
      return rows.map((row) => ({ id: asNumber(row.id), name: String(row.name), is_active: asNumber(row.is_active) === 1 }));
    },

    async moveProfile(id, toUserId, name, isActive, now) {
      await db.run('UPDATE ke_profiles SET user_id = ?, name = ?, is_active = ?, updated_at = ? WHERE id = ?', [toUserId, name, isActive ? 1 : 0, now, id]);
    },

    async detachShares(profileIds) {
      if (profileIds.length === 0) return [];
      const placeholders = profileIds.map(() => '?').join(', ');
      const rows = await db.all<MysqlRow>(
        `SELECT id FROM ke_shared_profiles WHERE source_profile_id IN (${placeholders}) ORDER BY id FOR UPDATE`, profileIds);
      if (rows.length === 0) return [];
      await db.run(`UPDATE ke_shared_profiles SET source_profile_id = NULL WHERE source_profile_id IN (${placeholders})`, profileIds);
      return rows.map((row) => asNumber(row.id));
    },

    insertAudit: (entry) => insertAdminAudit(db, entry),
    insertActivity: (row) => insertActivityRow(db, row),
  };
}

export function createTransferRepository(database: MysqlDatabase): TransferRepository {
  return {
    async resolveUser(account) {
      const text = account.trim();
      if (/^\d{1,20}$/u.test(text)) {
        const row = await database.first<MysqlRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE id = ?`, [text]);
        return row ? readUser(row) : null;
      }
      if (!text.includes('@')) return null;
      let normalized: string;
      try {
        normalized = normalizeEmail(text).normalized;
      } catch {
        return null;
      }
      const row = await database.first<MysqlRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE email_normalized = ?`, [normalized]);
      return row ? readUser(row) : null;
    },

    async listCharacters(userId) {
      const rows = await database.all<MysqlRow>(
        `SELECT ${CHARACTER_COLUMNS} FROM ke_characters WHERE user_id = ? ORDER BY aid, cid, nid LIMIT ${MAX_CHARACTERS}`, [userId]);
      return rows.map((row) => withoutOwner(readCharacter(row)));
    },

    async findCharacter(aid, cid, nid) {
      const row = await database.first<MysqlRow>(
        `SELECT ${CHARACTER_COLUMNS} FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ?`, [aid, cid, nid]);
      return row ? readCharacter(row) : null;
    },

    async listAids(userId) {
      const rows = await database.all<MysqlRow>(
        'SELECT aid FROM ke_characters WHERE user_id = ? UNION SELECT aid FROM ke_instances WHERE user_id = ?', [userId, userId]);
      return rows.map((row) => asNumber(row.aid));
    },

    transaction: (work) => database.transaction((db) => work(txFor(db))),
  };
}
