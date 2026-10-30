import { describe, expect, it } from 'vitest';
import { createAdminService } from '../src/admin/service';
import type { AdminEntitlementChange } from '../src/commerce/projection';
import type {
  AdminAuditEntry,
  AdminRepository,
  AdminTx,
  AdminUserRow,
  EntitlementRow,
  GuestbookEntryRow,
  GuestbookReplyRow,
  NewEntitlement,
} from '../src/admin/types';
import { foldEntitlements, KE_PERMANENT_MS, type KeEntitlements } from '../src/ke/entitlements';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

interface FakeAdminRepository extends AdminRepository {
  users: Map<number, AdminUserRow>;
  entitlements: Map<number, EntitlementRow>;
  /** 覆盖「当前生效权益」的汇总结果（模拟 SQL 聚合独立于历史列表）。 */
  aggregate: KeEntitlements | null;
  entries: Map<number, GuestbookEntryRow>;
  replies: Map<number, GuestbookReplyRow>;
  audit: AdminAuditEntry[];
  txCalls: string[];
  commerceChanges: AdminEntitlementChange[];
}

function user(id: number, overrides: Partial<AdminUserRow> = {}): AdminUserRow {
  return {
    id, email: `u${id}@example.test`, display_name: `用户${id}`, status: 'ACTIVE', permission_level: 1,
    email_verified_at: 1, created_at: 1, ...overrides,
  };
}

function makeRepository(): FakeAdminRepository {
  const users = new Map<number, AdminUserRow>([[1, user(1, { permission_level: 100 })], [2, user(2)], [3, user(3, { permission_level: 99 })], [4, user(4, { permission_level: 100, status: 'DISABLED' })]]);
  const entitlements = new Map<number, EntitlementRow>();
  const entries = new Map<number, GuestbookEntryRow>();
  const replies = new Map<number, GuestbookReplyRow>();
  const audit: AdminAuditEntry[] = [];
  const txCalls: string[] = [];
  const commerceChanges: AdminEntitlementChange[] = [];
  let nextEntitlementId = 1;
  const state: { aggregate: KeEntitlements | null } = { aggregate: null };

  const tx: AdminTx = {
    async lockUser(id) { txCalls.push('lock-user'); return users.get(id) ?? null; },
    async readEntitlementOwner(id) { txCalls.push('read-entitlement-owner'); return entitlements.get(id)?.user_id ?? null; },
    async lockCommerceUnitForEntitlement() { txCalls.push('lock-commerce-unit'); },
    async recordCommerceEntitlementChange(change) { txCalls.push('record-commerce-change'); commerceChanges.push(change); },
    async insertEntitlement(row: NewEntitlement) {
      const id = nextEntitlementId++;
      entitlements.set(id, { id, ...row, revoked_at: null });
      return id;
    },
    async findEntitlementForUpdate(id) { txCalls.push('lock-entitlement'); return entitlements.get(id) ?? null; },
    async updateEntitlement(id, fields) {
      const row = entitlements.get(id)!;
      if (fields.expires_at !== undefined) row.expires_at = fields.expires_at;
      if (fields.revoked_at !== undefined) row.revoked_at = fields.revoked_at;
    },
    async findGuestbookEntryForUpdate(id) { return entries.get(id) ?? null; },
    async listGuestbookReplies(entryId) { return [...replies.values()].filter((reply) => reply.entry_id === entryId); },
    async deleteGuestbookEntry(id) {
      entries.delete(id);
      for (const [replyId, reply] of replies) if (reply.entry_id === id) replies.delete(replyId);
    },
    async findGuestbookReplyForUpdate(id) { return replies.get(id) ?? null; },
    async deleteGuestbookReply(id) { replies.delete(id); },
    async insertAudit(entry) { audit.push(entry); },
  };

  return {
    users, entitlements, entries, replies, audit, txCalls, commerceChanges,
    get aggregate() { return state.aggregate; },
    set aggregate(value) { state.aggregate = value; },
    async readEntitlements(userId, at) {
      if (state.aggregate) return state.aggregate;
      const totals = new Map<string, number>();
      for (const row of entitlements.values()) {
        if (row.user_id !== userId || row.revoked_at !== null || row.starts_at > at || row.expires_at <= at) continue;
        totals.set(row.resource, (totals.get(row.resource) ?? 0) + row.quantity);
      }
      return foldEntitlements([...totals].map(([resource, total]) => ({ resource, total })));
    },
    async readActor(id) { return users.get(id) ?? null; },
    async findUser(id) { return users.get(id) ?? null; },
    async searchUsers() { return [...users.values()]; },
    async listEntitlements(userId, limit) { return [...entitlements.values()].filter((row) => row.user_id === userId).sort((a, b) => b.id - a.id).slice(0, limit); },
    async listAudit() { return audit.map((entry, index) => ({ id: index + 1, ...entry })); },
    transaction: (work) => work(tx),
  };
}

function setup() {
  const repository = makeRepository();
  const service = createAdminService(repository, () => NOW);
  return { repository, service };
}

describe('admin service · 权限', () => {
  it('permission_level >= 100 且账号正常才是管理员，其余一律按「不存在」处理', async () => {
    const { service } = setup();
    await expect(service.assertAdmin(1)).resolves.toBeUndefined();
    for (const id of [2, 3, 4, 999]) {
      await expect(service.assertAdmin(id)).rejects.toMatchObject({ code: 'ADMIN_NOT_FOUND', status: 404 });
    }
  });
});

describe('admin service · 赠送 / 扣减权益', () => {
  it('赠送：写入 source=admin 的权益行（从现在开始、按天数到期），并在同一事务里记审计', async () => {
    const { repository, service } = setup();
    const result = await service.adjustEntitlement(1, 2, { resource: 'slots', delta: 3, duration_days: 30, note: '活动奖励' }, 'req-1');
    expect(result.id).toBe(1);
    expect(repository.entitlements.get(1)).toMatchObject({
      user_id: 2, resource: 'slots', quantity: 3, starts_at: NOW, expires_at: NOW + 30 * DAY_MS,
      source: 'admin', source_ref: 'req-1', actor_user_id: 1, note: '活动奖励', revoked_at: null,
    });
    expect(repository.audit).toEqual([expect.objectContaining({
      actor_user_id: 1, action: 'ENTITLEMENT_ADJUST', target_user_id: 2, request_id: 'req-1', created_at: NOW,
      detail: expect.objectContaining({ entitlement_id: 1, resource: 'slots', delta: 3, starts_at: NOW, expires_at: NOW + 30 * DAY_MS, note: '活动奖励' }),
    })]);
  });

  it('扣减：delta 为负数照样记为一行；永久 = 99 年；模块用 module: 前缀', async () => {
    const { repository, service } = setup();
    await service.adjustEntitlement(1, 2, { resource: 'slots', delta: -2, permanent: true }, 'req-2');
    await service.adjustEntitlement(1, 2, { resource: 'module:alpha', delta: 1, expires_at: NOW + DAY_MS }, 'req-3');
    expect(repository.entitlements.get(1)).toMatchObject({ quantity: -2, expires_at: NOW + KE_PERMANENT_MS, note: null });
    expect(repository.entitlements.get(2)).toMatchObject({ resource: 'module:alpha', quantity: 1, expires_at: NOW + DAY_MS });
  });

  it.each([
    ['delta 为 0', { resource: 'slots', delta: 0, permanent: true }],
    ['delta 不是整数', { resource: 'slots', delta: 1.5, permanent: true }],
    ['delta 超出上限', { resource: 'slots', delta: 1001, permanent: true }],
    ['resource 不合法', { resource: 'drop table', delta: 1, permanent: true }],
    ['缺少有效期', { resource: 'slots', delta: 1 }],
    ['同时给了多种有效期', { resource: 'slots', delta: 1, permanent: true, duration_days: 3 }],
    ['天数为 0', { resource: 'slots', delta: 1, duration_days: 0 }],
    ['到期时间已过', { resource: 'slots', delta: 1, expires_at: NOW - 1 }],
    ['到期时间超过 99 年', { resource: 'slots', delta: 1, expires_at: NOW + KE_PERMANENT_MS + 1 }],
    ['备注过长', { resource: 'slots', delta: 1, permanent: true, note: 'x'.repeat(201) }],
  ])('参数校验：%s → 400 且不写任何数据', async (_name, input) => {
    const { repository, service } = setup();
    await expect(service.adjustEntitlement(1, 2, input as never, 'req-x')).rejects.toMatchObject({ code: 'ADMIN_BAD_REQUEST', status: 400 });
    expect(repository.entitlements.size).toBe(0);
    expect(repository.audit).toHaveLength(0);
  });

  it('目标账号不存在 → 404，不写权益也不写审计', async () => {
    const { repository, service } = setup();
    await expect(service.adjustEntitlement(1, 999, { resource: 'slots', delta: 1, permanent: true }, 'req-4'))
      .rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND', status: 404 });
    expect(repository.entitlements.size).toBe(0);
    expect(repository.audit).toHaveLength(0);
  });
});

describe('admin service · 修改 / 撤销权益', () => {
  async function withEntitlement() {
    const ctx = setup();
    await ctx.service.adjustEntitlement(1, 2, { resource: 'slots', delta: 5, duration_days: 10 }, 'req-a');
    ctx.repository.audit.length = 0;
    return ctx;
  }

  it('修改到期时间：原地修改并把前后值记入审计', async () => {
    const { repository, service } = await withEntitlement();
    repository.txCalls.length = 0;
    await service.editEntitlement(1, 1, { expires_at: NOW + 20 * DAY_MS }, 'req-b');
    expect(repository.entitlements.get(1)!.expires_at).toBe(NOW + 20 * DAY_MS);
    expect(repository.audit).toEqual([expect.objectContaining({
      action: 'ENTITLEMENT_EDIT', target_user_id: 2, actor_user_id: 1,
      detail: expect.objectContaining({ entitlement_id: 1, before: { expires_at: NOW + 10 * DAY_MS, revoked_at: null }, after: { expires_at: NOW + 20 * DAY_MS, revoked_at: null } }),
    })]);
    expect(repository.txCalls).toEqual([
      'read-entitlement-owner', 'lock-user', 'lock-commerce-unit', 'lock-entitlement', 'record-commerce-change',
    ]);
    expect(repository.commerceChanges).toEqual([expect.objectContaining({
      userId: '2', entitlementId: '1', actorUserId: '1', requestId: 'req-b', occurredAt: BigInt(NOW),
      beforeExpiresAt: BigInt(NOW + 10 * DAY_MS), afterExpiresAt: BigInt(NOW + 20 * DAY_MS),
    })]);
  });

  it('撤销与恢复：revoked=true 记当前时间，revoked=false 清空', async () => {
    const { repository, service } = await withEntitlement();
    await service.editEntitlement(1, 1, { revoked: true }, 'req-c');
    expect(repository.entitlements.get(1)!.revoked_at).toBe(NOW);
    await service.editEntitlement(1, 1, { revoked: false }, 'req-d');
    expect(repository.entitlements.get(1)!.revoked_at).toBeNull();
    expect(repository.audit.map((entry) => entry.action)).toEqual(['ENTITLEMENT_EDIT', 'ENTITLEMENT_EDIT']);
  });

  it('新到期时间不晚于开始时间 → 400；空修改 → 400；不存在 → 404', async () => {
    const { repository, service } = await withEntitlement();
    await expect(service.editEntitlement(1, 1, { expires_at: NOW }, 'req-e')).rejects.toMatchObject({ code: 'ADMIN_BAD_REQUEST' });
    await expect(service.editEntitlement(1, 1, {}, 'req-f')).rejects.toMatchObject({ code: 'ADMIN_BAD_REQUEST' });
    await expect(service.editEntitlement(1, 99, { revoked: true }, 'req-g')).rejects.toMatchObject({ code: 'ADMIN_ENTITLEMENT_NOT_FOUND', status: 404 });
    expect(repository.entitlements.get(1)!.expires_at).toBe(NOW + 10 * DAY_MS);
    expect(repository.audit).toHaveLength(0);
  });
});

describe('admin service · 删除留言板内容', () => {
  function seed(repository: FakeAdminRepository) {
    repository.entries.set(10, { id: 10, user_id: 2, category: 'suggestion', item_id: null, is_zeny: 0, contact: null, content: '违规留言', created_at: 5, edited_at: null });
    repository.replies.set(20, { id: 20, entry_id: 10, user_id: 3, content: '回复甲', created_at: 6, edited_at: null });
    repository.replies.set(21, { id: 21, entry_id: 10, user_id: 2, content: '回复乙', created_at: 7, edited_at: null });
  }

  it('删除留言：连同回复一起删除，内容快照写进审计', async () => {
    const { repository, service } = setup();
    seed(repository);
    const result = await service.deleteGuestbookEntry(1, 10, 'req-h');
    expect(result).toEqual({ deleted_replies: 2 });
    expect(repository.entries.has(10)).toBe(false);
    expect(repository.replies.size).toBe(0);
    expect(repository.audit).toEqual([expect.objectContaining({
      action: 'GUESTBOOK_DELETE_ENTRY', target_user_id: 2, actor_user_id: 1,
      detail: expect.objectContaining({
        entry: expect.objectContaining({ id: 10, content: '违规留言', user_id: 2 }),
        replies: [expect.objectContaining({ id: 20, content: '回复甲' }), expect.objectContaining({ id: 21, content: '回复乙' })],
      }),
    })]);
  });

  it('删除单条回复：只删这一条，快照写进审计', async () => {
    const { repository, service } = setup();
    seed(repository);
    await service.deleteGuestbookReply(1, 20, 'req-i');
    expect([...repository.replies.keys()]).toEqual([21]);
    expect(repository.entries.has(10)).toBe(true);
    expect(repository.audit).toEqual([expect.objectContaining({
      action: 'GUESTBOOK_DELETE_REPLY', target_user_id: 3,
      detail: expect.objectContaining({ reply: expect.objectContaining({ id: 20, entry_id: 10, content: '回复甲' }) }),
    })]);
  });

  it('留言或回复不存在 → 404，不写审计', async () => {
    const { repository, service } = setup();
    await expect(service.deleteGuestbookEntry(1, 10, 'req-j')).rejects.toMatchObject({ code: 'ADMIN_GUESTBOOK_NOT_FOUND', status: 404 });
    await expect(service.deleteGuestbookReply(1, 20, 'req-k')).rejects.toMatchObject({ code: 'ADMIN_GUESTBOOK_NOT_FOUND', status: 404 });
    expect(repository.audit).toHaveLength(0);
  });
});

describe('admin service · 账号详情', () => {
  it('详情包含账号信息、当前生效的额度与模块、全部权益行', async () => {
    const { service } = setup();
    await service.adjustEntitlement(1, 2, { resource: 'slots', delta: 4, duration_days: 5 }, 'req-l');
    await service.adjustEntitlement(1, 2, { resource: 'module:core', delta: 1, permanent: true }, 'req-m');
    const detail = await service.getUser(2);
    expect(detail.user).toMatchObject({ id: 2, email: 'u2@example.test' });
    expect(detail.entitlements).toHaveLength(2);
    expect(detail.effective).toEqual({ slots: 4, modules: ['core'] });
  });

  it('账号不存在 → 404', async () => {
    const { service } = setup();
    await expect(service.getUser(999)).rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND', status: 404 });
  });

  it('当前生效的额度与模块来自独立的聚合查询，不依赖（可能被截断的）历史列表', async () => {
    const { repository, service } = setup();
    // 历史列表里只有一条，但聚合口径（包含更早、已不在列表里的有效权益）是 7 个额度 + core 与 alpha 两个模块
    await service.adjustEntitlement(1, 2, { resource: 'slots', delta: 1, duration_days: 5 }, 'req-n');
    repository.aggregate = { slots: 7, modules: new Set(['core', 'alpha']) };
    const detail = await service.getUser(2);
    expect(detail.entitlements).toHaveLength(1);
    expect(detail.effective).toEqual({ slots: 7, modules: ['alpha', 'core'] });
  });

  it('历史超过上限时只返回最近的记录，并明确标记已截断', async () => {
    const { repository, service } = setup();
    for (let id = 1; id <= 501; id += 1) {
      repository.entitlements.set(id, {
        id, user_id: 2, resource: 'slots', quantity: 1, starts_at: NOW - DAY_MS, expires_at: NOW + DAY_MS, source: 'admin', source_ref: `r${id}`,
        actor_user_id: 1, note: null, revoked_at: null, created_at: NOW,
      });
    }
    const truncated = await service.getUser(2);
    expect(truncated.entitlements).toHaveLength(500);
    expect(truncated.entitlements[0]!.id).toBe(501);
    expect(truncated.entitlements_truncated).toBe(true);
    expect(truncated.effective.slots).toBe(501);

    repository.entitlements.delete(501);
    expect((await service.getUser(2)).entitlements_truncated).toBe(false);
  });
});
