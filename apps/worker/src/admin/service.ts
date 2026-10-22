import { foldEntitlements, KE_PERMANENT_MS } from '../ke/entitlements';
import { parseAdjustInput, parseEditInput } from './input';
import {
  ADMIN_PERMISSION_LEVEL,
  AdminFailure,
  type AdminAuditRecord,
  type AdminRepository,
  type AdminUserRow,
  type EntitlementRow,
} from './types';

const SEARCH_LIMIT = 20;
const AUDIT_PAGE_LIMIT = 50;

export interface AdminUserDetail {
  user: AdminUserRow;
  effective: { slots: number; modules: string[] };
  entitlements: EntitlementRow[];
}

function notFound(code: string, message: string): AdminFailure {
  return new AdminFailure(code, 404, message);
}

function effectiveAt(rows: readonly EntitlementRow[], now: number): AdminUserDetail['effective'] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.revoked_at !== null || row.starts_at > now || row.expires_at <= now) continue;
    totals.set(row.resource, (totals.get(row.resource) ?? 0) + row.quantity);
  }
  const folded = foldEntitlements([...totals].map(([resource, total]) => ({ resource, total })));
  return { slots: folded.slots, modules: [...folded.modules].sort() };
}

export function createAdminService(repository: AdminRepository, now: () => number = () => Date.now()) {
  return {
    /** 管理员 = 账号正常且 permission_level >= 100；其余一律当作「不存在」，不暴露后台的存在。 */
    async assertAdmin(userId: number): Promise<void> {
      const actor = await repository.readActor(userId);
      if (!actor || actor.status !== 'ACTIVE' || actor.permission_level < ADMIN_PERMISSION_LEVEL) {
        throw notFound('ADMIN_NOT_FOUND', 'Not found');
      }
    },

    async searchUsers(query: string): Promise<AdminUserRow[]> {
      const trimmed = query.trim();
      if ([...trimmed].length > 64) throw new AdminFailure('ADMIN_BAD_REQUEST', 400, '搜索词过长');
      return repository.searchUsers(trimmed, SEARCH_LIMIT);
    },

    async getUser(userId: number): Promise<AdminUserDetail> {
      const user = await repository.findUser(userId);
      if (!user) throw notFound('ADMIN_USER_NOT_FOUND', '账号不存在');
      const entitlements = await repository.listEntitlements(userId);
      return { user, effective: effectiveAt(entitlements, now()), entitlements };
    },

    async adjustEntitlement(actorId: number, targetId: number, rawInput: unknown, requestId: string): Promise<{ id: number }> {
      const at = now();
      const input = parseAdjustInput(rawInput, at);
      return repository.transaction(async (tx) => {
        if (!await tx.lockUser(targetId)) throw notFound('ADMIN_USER_NOT_FOUND', '账号不存在');
        const id = await tx.insertEntitlement({
          user_id: targetId, resource: input.resource, quantity: input.delta, starts_at: at, expires_at: input.expiresAt,
          source: 'admin', source_ref: requestId, actor_user_id: actorId, note: input.note, created_at: at,
        });
        await tx.insertAudit({
          actor_user_id: actorId, action: 'ENTITLEMENT_ADJUST', target_user_id: targetId, request_id: requestId, created_at: at,
          detail: { entitlement_id: id, resource: input.resource, delta: input.delta, starts_at: at, expires_at: input.expiresAt, note: input.note },
        });
        return { id };
      });
    },

    async editEntitlement(actorId: number, entitlementId: number, rawInput: unknown, requestId: string): Promise<void> {
      const at = now();
      const input = parseEditInput(rawInput);
      await repository.transaction(async (tx) => {
        const row = await tx.findEntitlementForUpdate(entitlementId);
        if (!row) throw notFound('ADMIN_ENTITLEMENT_NOT_FOUND', '权益记录不存在');
        const nextExpiresAt = input.expiresAt ?? row.expires_at;
        if (nextExpiresAt <= row.starts_at || nextExpiresAt > at + KE_PERMANENT_MS) {
          throw new AdminFailure('ADMIN_BAD_REQUEST', 400, '到期时间必须晚于开始时间，且不超过 99 年');
        }
        const nextRevokedAt = input.revoked === undefined ? row.revoked_at : input.revoked ? (row.revoked_at ?? at) : null;
        const before = { expires_at: row.expires_at, revoked_at: row.revoked_at };
        await tx.updateEntitlement(entitlementId, { expires_at: nextExpiresAt, revoked_at: nextRevokedAt });
        await tx.insertAudit({
          actor_user_id: actorId, action: 'ENTITLEMENT_EDIT', target_user_id: row.user_id, request_id: requestId, created_at: at,
          detail: {
            entitlement_id: entitlementId,
            before,
            after: { expires_at: nextExpiresAt, revoked_at: nextRevokedAt },
          },
        });
      });
    },

    async deleteGuestbookEntry(actorId: number, entryId: number, requestId: string): Promise<{ deleted_replies: number }> {
      const at = now();
      return repository.transaction(async (tx) => {
        const entry = await tx.findGuestbookEntryForUpdate(entryId);
        if (!entry) throw notFound('ADMIN_GUESTBOOK_NOT_FOUND', '留言不存在');
        const replies = await tx.listGuestbookReplies(entryId);
        await tx.deleteGuestbookEntry(entryId);
        await tx.insertAudit({
          actor_user_id: actorId, action: 'GUESTBOOK_DELETE_ENTRY', target_user_id: entry.user_id, request_id: requestId, created_at: at,
          detail: { entry, replies },
        });
        return { deleted_replies: replies.length };
      });
    },

    async deleteGuestbookReply(actorId: number, replyId: number, requestId: string): Promise<void> {
      const at = now();
      await repository.transaction(async (tx) => {
        const reply = await tx.findGuestbookReplyForUpdate(replyId);
        if (!reply) throw notFound('ADMIN_GUESTBOOK_NOT_FOUND', '回复不存在');
        await tx.deleteGuestbookReply(replyId);
        await tx.insertAudit({
          actor_user_id: actorId, action: 'GUESTBOOK_DELETE_REPLY', target_user_id: reply.user_id, request_id: requestId, created_at: at,
          detail: { reply },
        });
      });
    },

    async listAudit(beforeId: number | null): Promise<AdminAuditRecord[]> {
      return repository.listAudit(AUDIT_PAGE_LIMIT, beforeId);
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
