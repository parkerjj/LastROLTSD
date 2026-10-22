import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import { insertAdminAudit } from './audit';
import type {
  AdminAuditRecord,
  AdminRepository,
  AdminTx,
  AdminUserRow,
  EntitlementRow,
  GuestbookEntryRow,
  GuestbookReplyRow,
} from './types';

const USER_COLUMNS = 'id, email, display_name, status, permission_level, email_verified_at, created_at';
const ENTITLEMENT_COLUMNS = 'id, user_id, resource, quantity, starts_at, expires_at, source, source_ref, actor_user_id, note, revoked_at, created_at';
const ENTITLEMENT_LIST_LIMIT = 500;

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readUser(row: MysqlRow): AdminUserRow {
  return {
    id: asNumber(row.id),
    email: String(row.email),
    display_name: String(row.display_name),
    status: String(row.status),
    permission_level: asNumber(row.permission_level),
    email_verified_at: asNullableNumber(row.email_verified_at),
    created_at: asNumber(row.created_at),
  };
}

function readEntitlement(row: MysqlRow): EntitlementRow {
  return {
    id: asNumber(row.id),
    user_id: asNumber(row.user_id),
    resource: String(row.resource),
    quantity: asNumber(row.quantity),
    starts_at: asNumber(row.starts_at),
    expires_at: asNumber(row.expires_at),
    source: String(row.source),
    source_ref: String(row.source_ref),
    actor_user_id: asNullableNumber(row.actor_user_id),
    note: asNullableString(row.note),
    revoked_at: asNullableNumber(row.revoked_at),
    created_at: asNumber(row.created_at),
  };
}

function readEntry(row: MysqlRow): GuestbookEntryRow {
  return {
    id: asNumber(row.id),
    user_id: asNullableNumber(row.user_id),
    category: String(row.category),
    item_id: asNullableNumber(row.item_id),
    is_zeny: asNumber(row.is_zeny),
    contact: asNullableString(row.contact),
    content: String(row.content),
    created_at: asNumber(row.created_at),
    edited_at: asNullableNumber(row.edited_at),
  };
}

function readReply(row: MysqlRow): GuestbookReplyRow {
  return {
    id: asNumber(row.id),
    entry_id: asNumber(row.entry_id),
    user_id: asNumber(row.user_id),
    content: String(row.content),
    created_at: asNumber(row.created_at),
    edited_at: asNullableNumber(row.edited_at),
  };
}

function readAudit(row: MysqlRow): AdminAuditRecord {
  const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) as Record<string, unknown> : (row.detail ?? null) as Record<string, unknown> | null;
  return {
    id: asNumber(row.id),
    actor_user_id: asNumber(row.actor_user_id),
    action: String(row.action),
    target_user_id: asNullableNumber(row.target_user_id),
    detail,
    request_id: asNullableString(row.request_id),
    created_at: asNumber(row.created_at),
  };
}

/** LIKE 通配符按字面匹配：用 | 作转义符。 */
function likePattern(query: string): string {
  return `%${query.replace(/[|%_]/gu, (character) => `|${character}`)}%`;
}

function txFor(db: MysqlDatabase): AdminTx {
  return {
    async lockUser(userId) {
      const row = await db.first<MysqlRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE id = ? FOR UPDATE`, [userId]);
      return row ? readUser(row) : null;
    },

    async insertEntitlement(row) {
      const result = await db.run(
        'INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, actor_user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.user_id, row.resource, row.quantity, row.starts_at, row.expires_at, row.source, row.source_ref, row.actor_user_id, row.note, row.created_at],
      );
      return result.insertId;
    },

    async findEntitlementForUpdate(id) {
      const row = await db.first<MysqlRow>(`SELECT ${ENTITLEMENT_COLUMNS} FROM ke_entitlements WHERE id = ? FOR UPDATE`, [id]);
      return row ? readEntitlement(row) : null;
    },

    async updateEntitlement(id, fields) {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (fields.expires_at !== undefined) { sets.push('expires_at = ?'); values.push(fields.expires_at); }
      if (fields.revoked_at !== undefined) { sets.push('revoked_at = ?'); values.push(fields.revoked_at); }
      if (sets.length === 0) return;
      await db.run(`UPDATE ke_entitlements SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    },

    async findGuestbookEntryForUpdate(id) {
      const row = await db.first<MysqlRow>(
        'SELECT id, user_id, category, item_id, is_zeny, contact, content, created_at, edited_at FROM guestbook_entries WHERE id = ? FOR UPDATE', [id]);
      return row ? readEntry(row) : null;
    },

    async listGuestbookReplies(entryId) {
      const rows = await db.all<MysqlRow>(
        'SELECT id, entry_id, user_id, content, created_at, edited_at FROM guestbook_replies WHERE entry_id = ? ORDER BY created_at, id', [entryId]);
      return rows.map(readReply);
    },

    async deleteGuestbookEntry(id) {
      // guestbook_replies 对 guestbook_entries 是 ON DELETE CASCADE，回复随之删除。
      await db.run('DELETE FROM guestbook_entries WHERE id = ?', [id]);
    },

    async findGuestbookReplyForUpdate(id) {
      const row = await db.first<MysqlRow>(
        'SELECT id, entry_id, user_id, content, created_at, edited_at FROM guestbook_replies WHERE id = ? FOR UPDATE', [id]);
      return row ? readReply(row) : null;
    },

    async deleteGuestbookReply(id) {
      await db.run('DELETE FROM guestbook_replies WHERE id = ?', [id]);
    },

    insertAudit: (entry) => insertAdminAudit(db, entry),
  };
}

export function createAdminRepository(database: MysqlDatabase): AdminRepository {
  return {
    async readActor(userId) {
      const row = await database.first<MysqlRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE id = ?`, [userId]);
      return row ? readUser(row) : null;
    },

    async findUser(userId) {
      const row = await database.first<MysqlRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE id = ?`, [userId]);
      return row ? readUser(row) : null;
    },

    async searchUsers(query, limit) {
      const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
      if (query === '') {
        return (await database.all<MysqlRow>(`SELECT ${USER_COLUMNS} FROM auth_users ORDER BY id DESC LIMIT ${size}`)).map(readUser);
      }
      const pattern = likePattern(query);
      const byId = /^\d{1,20}$/u.test(query);
      const rows = await database.all<MysqlRow>(
        `SELECT ${USER_COLUMNS} FROM auth_users
         WHERE ${byId ? 'id = ? OR ' : ''}email LIKE ? ESCAPE '|' OR display_name LIKE ? ESCAPE '|'
         ORDER BY id DESC LIMIT ${size}`,
        byId ? [query, pattern, pattern] : [pattern, pattern],
      );
      return rows.map(readUser);
    },

    async listEntitlements(userId) {
      const rows = await database.all<MysqlRow>(
        `SELECT ${ENTITLEMENT_COLUMNS} FROM ke_entitlements WHERE user_id = ? ORDER BY id DESC LIMIT ${ENTITLEMENT_LIST_LIMIT}`, [userId]);
      return rows.map(readEntitlement);
    },

    async listAudit(limit, beforeId) {
      const size = Math.min(Math.max(Math.trunc(limit), 1), 200);
      const rows = beforeId === null
        ? await database.all<MysqlRow>(`SELECT id, actor_user_id, action, target_user_id, detail, request_id, created_at FROM admin_audit_log ORDER BY id DESC LIMIT ${size}`)
        : await database.all<MysqlRow>(`SELECT id, actor_user_id, action, target_user_id, detail, request_id, created_at FROM admin_audit_log WHERE id < ? ORDER BY id DESC LIMIT ${size}`, [beforeId]);
      return rows.map(readAudit);
    },

    transaction: (work) => database.transaction((db) => work(txFor(db))),
  };
}
