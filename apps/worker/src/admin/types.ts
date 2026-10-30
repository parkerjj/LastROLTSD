import type { KeEntitlements } from '../ke/entitlements';
import type { AdminEntitlementChange } from '../commerce/projection';

export class AdminFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AdminFailure';
  }
}

/** 管理员权限线：permission_level >= 100。 */
export const ADMIN_PERMISSION_LEVEL = 100;

export interface AdminUserRow {
  id: number;
  email: string;
  display_name: string;
  status: string;
  permission_level: number;
  email_verified_at: number | null;
  created_at: number;
}

export interface EntitlementRow {
  id: number;
  user_id: number;
  resource: string;
  quantity: number;
  starts_at: number;
  expires_at: number;
  source: string;
  source_ref: string;
  actor_user_id: number | null;
  note: string | null;
  revoked_at: number | null;
  created_at: number;
}

export type NewEntitlement = Omit<EntitlementRow, 'id' | 'revoked_at'>;

export interface GuestbookEntryRow {
  id: number;
  user_id: number | null;
  category: string;
  item_id: number | null;
  is_zeny: number;
  contact: string | null;
  content: string;
  created_at: number;
  edited_at: number | null;
}

export interface GuestbookReplyRow {
  id: number;
  entry_id: number;
  user_id: number;
  content: string;
  created_at: number;
  edited_at: number | null;
}

export interface AdminAuditEntry {
  actor_user_id: number;
  action: string;
  target_user_id: number | null;
  detail: Record<string, unknown> | null;
  request_id: string | null;
  created_at: number;
}

export interface AdminAuditRecord extends AdminAuditEntry {
  id: number;
}

/** 事务内的读写；一次管理操作的业务变更与审计必须在同一个事务里提交。 */
export interface AdminTx {
  lockUser(userId: number): Promise<AdminUserRow | null>;
  readEntitlementOwner(id: number): Promise<number | null>;
  lockCommerceUnitForEntitlement(userId: number, entitlementId: number): Promise<void>;
  recordCommerceEntitlementChange(change: AdminEntitlementChange): Promise<void>;
  insertEntitlement(row: NewEntitlement): Promise<number>;
  findEntitlementForUpdate(id: number): Promise<EntitlementRow | null>;
  updateEntitlement(id: number, fields: { expires_at?: number; revoked_at?: number | null }): Promise<void>;
  findGuestbookEntryForUpdate(id: number): Promise<GuestbookEntryRow | null>;
  listGuestbookReplies(entryId: number): Promise<GuestbookReplyRow[]>;
  deleteGuestbookEntry(id: number): Promise<void>;
  findGuestbookReplyForUpdate(id: number): Promise<GuestbookReplyRow | null>;
  deleteGuestbookReply(id: number): Promise<void>;
  insertAudit(entry: AdminAuditEntry): Promise<void>;
}

export interface AdminRepository {
  readActor(userId: number): Promise<AdminUserRow | null>;
  findUser(userId: number): Promise<AdminUserRow | null>;
  searchUsers(query: string, limit: number): Promise<AdminUserRow[]>;
  /** 当前生效的额度与模块（SQL 聚合，与 KE 授权同口径，不受历史列表截断影响）。 */
  readEntitlements(userId: number, now: number): Promise<KeEntitlements>;
  /** 最近的权益流水（按 id 倒序），最多 limit 条。 */
  listEntitlements(userId: number, limit: number): Promise<EntitlementRow[]>;
  listAudit(limit: number, beforeId: number | null): Promise<AdminAuditRecord[]>;
  transaction<T>(work: (tx: AdminTx) => Promise<T>): Promise<T>;
}
