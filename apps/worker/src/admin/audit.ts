import type { MysqlDatabase } from '../db/mysql-client';
import type { AdminAuditEntry } from './types';

export async function insertAdminAudit(db: MysqlDatabase, entry: AdminAuditEntry): Promise<void> {
  await db.run(
    'INSERT INTO admin_audit_log (actor_user_id, action, target_user_id, detail, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [entry.actor_user_id, entry.action, entry.target_user_id, entry.detail === null ? null : JSON.stringify(entry.detail), entry.request_id, entry.created_at],
  );
}
