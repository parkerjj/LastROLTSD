// 管理后台仓库层 SQL 的真实 MySQL 验证（迁移 017 / 018 + 留言板表）。与 auth 集成测试共用 withAuthTestDatabase：
// 需要 MYSQL_TEST_URL（库名以 _test 结尾、且不同于 MYSQL_URL）与 AUTH_TEST_DB_ALLOW_RESET=1，会清空并重建该库。
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { createAdminRepository } from '../../apps/worker/src/admin/repository';
import { createAdminService } from '../../apps/worker/src/admin/service';
import { createKeRepository } from '../../apps/worker/src/ke/repository';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;
const DAY_MS = 24 * 60 * 60 * 1000;

async function insertUser(database: MysqlDatabase, name: string, permissionLevel = 1): Promise<number> {
  const result = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, permission_level, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`${name}@example.test`, `${name}@example.test`, name, 'ACTIVE', permissionLevel, 1, 1, 1],
  );
  return result.insertId;
}

async function count(database: MysqlDatabase, sql: string, values: unknown[] = []): Promise<number> {
  const row = await database.first<{ n: number | string }>(sql, values);
  return Number(row?.n ?? 0);
}

describe.skipIf(!runMysqlTests)('Admin × MySQL', () => {
  it('权限、搜索、权益赠送 / 扣减 / 修改 / 撤销与审计（与 KE 读取口径一致）', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const root = await insertUser(database, 'root', 100);
      const alice = await insertUser(database, 'alice');
      const mallory = await insertUser(database, 'mallory', 99);
      await database.run("UPDATE auth_users SET status = 'DISABLED' WHERE id = ?", [mallory]);
      let nowMs = Date.now();
      const repository = createAdminRepository(database);
      const service = createAdminService(repository, () => nowMs);
      const keRepository = createKeRepository(database);
      const keRead = (userId: number) => keRepository.transaction((tx) => tx.readEntitlements(userId, nowMs));

      await expect(service.assertAdmin(root)).resolves.toBeUndefined();
      await expect(service.assertAdmin(alice)).rejects.toMatchObject({ code: 'ADMIN_NOT_FOUND' });
      await expect(service.assertAdmin(mallory)).rejects.toMatchObject({ code: 'ADMIN_NOT_FOUND' });

      // 搜索：按 id、邮箱片段、昵称；LIKE 通配符按字面匹配
      expect((await service.searchUsers(String(alice))).map((u) => u.id)).toEqual([alice]);
      expect((await service.searchUsers('alice@')).map((u) => u.id)).toEqual([alice]);
      expect((await service.searchUsers('MALLORY')).map((u) => u.id)).toEqual([mallory]);
      expect(await service.searchUsers('%')).toEqual([]);
      expect((await service.searchUsers('')).length).toBe(3);

      // 赠送 → 与 KE 的权益读取口径一致
      const granted = await service.adjustEntitlement(root, alice, { resource: 'slots', delta: 3, duration_days: 30, note: '活动奖励' }, 'req-1');
      await service.adjustEntitlement(root, alice, { resource: 'module:core', delta: 1, permanent: true }, 'req-2');
      const detail = await service.getUser(alice);
      expect(detail.effective).toEqual({ slots: 3, modules: ['core'] });
      const viaKe = await keRead(alice);
      expect({ slots: viaKe.slots, modules: [...viaKe.modules] }).toEqual({ slots: 3, modules: ['core'] });
      expect(detail.entitlements[0]).toMatchObject({ resource: 'module:core', source: 'admin', source_ref: 'req-2', actor_user_id: root });

      // 扣减（负数）与时间窗口：扣完钳到 0；30 天后到期的 +3 不再计入
      await service.adjustEntitlement(root, alice, { resource: 'slots', delta: -5, duration_days: 10, note: '违规处罚' }, 'req-3');
      expect((await service.getUser(alice)).effective.slots).toBe(0);
      expect((await keRead(alice)).slots).toBe(0);
      nowMs += 11 * DAY_MS;
      expect((await service.getUser(alice)).effective.slots).toBe(3);
      expect((await keRead(alice)).slots).toBe(3);
      nowMs += 20 * DAY_MS;
      expect((await keRead(alice)).slots).toBe(0);

      // 修改到期时间 / 撤销 / 恢复
      await service.editEntitlement(root, granted.id, { expires_at: nowMs + 5 * DAY_MS }, 'req-4');
      expect((await keRead(alice)).slots).toBe(3);
      await service.editEntitlement(root, granted.id, { revoked: true }, 'req-5');
      expect((await keRead(alice)).slots).toBe(0);
      await service.editEntitlement(root, granted.id, { revoked: false }, 'req-6');
      expect((await keRead(alice)).slots).toBe(3);

      // 审计：每次操作一行，修改记录前后值；request_id 与权益行 source_ref 对应
      const audit = await service.listAudit(null);
      expect(audit.map((entry) => entry.action)).toEqual([
        'ENTITLEMENT_EDIT', 'ENTITLEMENT_EDIT', 'ENTITLEMENT_EDIT', 'ENTITLEMENT_ADJUST', 'ENTITLEMENT_ADJUST', 'ENTITLEMENT_ADJUST',
      ]);
      expect(audit[0]).toMatchObject({ actor_user_id: root, target_user_id: alice, request_id: 'req-6' });
      expect(audit[1]!.detail).toMatchObject({ before: { revoked_at: null }, after: { revoked_at: nowMs } });
      const older = await service.listAudit(audit[2]!.id);
      expect(older).toHaveLength(3);

      // 目标账号不存在；同一个 request_id 不会重复发放（唯一键）
      await expect(service.adjustEntitlement(root, 999999, { resource: 'slots', delta: 1, permanent: true }, 'req-7')).rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND' });
      await expect(service.adjustEntitlement(root, alice, { resource: 'slots', delta: 1, permanent: true }, 'req-1')).rejects.toBeDefined();
      expect(await count(database, "SELECT COUNT(*) AS n FROM ke_entitlements WHERE user_id = ? AND source = 'admin'", [alice])).toBe(3);
    });
  }, 120_000);

  it('权益流水超过展示上限：列表只返回最近的记录并标记截断，生效值仍按完整数据汇总', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const nowMs = Date.now();
      const service = createAdminService(createAdminRepository(database), () => nowMs);
      const keRepository = createKeRepository(database);
      // 最早的两条仍然有效（验证邮箱赠送：1 个额度 + 核心模块）；之后又累积了 510 条已过期的流水，把它们挤出最近 500 条
      await database.run(
        "INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, created_at) VALUES (?, 'slots', 1, 1, ?, 'signup', 'old-slots', 1), (?, 'module:core', 1, 1, ?, 'signup', 'old-core', 1)",
        [alice, nowMs + DAY_MS, alice, nowMs + DAY_MS],
      );
      const placeholders = Array.from({ length: 510 }, () => "(?, 'slots', 1, 1, 2, 'admin', ?, 1)").join(', ');
      await database.run(
        `INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, created_at) VALUES ${placeholders}`,
        Array.from({ length: 510 }, (_, index) => [alice, `bulk-${index}`]).flat(),
      );

      const detail = await service.getUser(alice);
      expect(detail.entitlements).toHaveLength(500);
      expect(detail.entitlements_truncated).toBe(true);
      expect(detail.entitlements.some((row) => row.source_ref === 'old-core')).toBe(false);
      expect(detail.effective).toEqual({ slots: 1, modules: ['core'] });
      const viaKe = await keRepository.transaction((tx) => tx.readEntitlements(alice, nowMs));
      expect({ slots: viaKe.slots, modules: [...viaKe.modules] }).toEqual(detail.effective);
    });
  }, 120_000);

  it('事务原子性：审计写入失败时，业务变更一并回滚', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const service = createAdminService(createAdminRepository(database), () => Date.now());
      // 操作者 id 不存在 → 审计表外键失败 → 整个事务回滚
      await expect(service.adjustEntitlement(987654, alice, { resource: 'slots', delta: 1, permanent: true }, 'req-1')).rejects.toBeDefined();
      expect(await count(database, 'SELECT COUNT(*) AS n FROM ke_entitlements WHERE user_id = ?', [alice])).toBe(0);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM admin_audit_log')).toBe(0);
    });
  }, 120_000);

  it('删除留言板内容：留言连同回复级联删除并留下快照；单条回复；账号删除后审计仍保留', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const root = await insertUser(database, 'root', 100);
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      const entry = (await database.run(
        "INSERT INTO guestbook_entries (user_id, category, content, created_at) VALUES (?, 'suggestion', ?, ?)", [alice, '违规留言', 5],
      )).insertId;
      const replyA = (await database.run('INSERT INTO guestbook_replies (entry_id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [entry, bob, '回复甲', 6])).insertId;
      await database.run('INSERT INTO guestbook_replies (entry_id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [entry, alice, '回复乙', 7]);
      const other = (await database.run(
        "INSERT INTO guestbook_entries (user_id, category, content, created_at) VALUES (?, 'suggestion', ?, ?)", [bob, '正常留言', 8],
      )).insertId;
      const service = createAdminService(createAdminRepository(database), () => Date.now());

      await service.deleteGuestbookReply(root, replyA, 'req-1');
      expect(await count(database, 'SELECT COUNT(*) AS n FROM guestbook_replies WHERE entry_id = ?', [entry])).toBe(1);
      expect(await service.deleteGuestbookEntry(root, entry, 'req-2')).toEqual({ deleted_replies: 1 });
      expect(await count(database, 'SELECT COUNT(*) AS n FROM guestbook_entries')).toBe(1);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM guestbook_entries WHERE id = ?', [other])).toBe(1);
      await expect(service.deleteGuestbookEntry(root, entry, 'req-3')).rejects.toMatchObject({ code: 'ADMIN_GUESTBOOK_NOT_FOUND' });

      const audit = await service.listAudit(null);
      expect(audit.map((row) => row.action)).toEqual(['GUESTBOOK_DELETE_ENTRY', 'GUESTBOOK_DELETE_REPLY']);
      expect(audit[0]!.detail).toMatchObject({ entry: { id: entry, content: '违规留言', user_id: alice }, replies: [{ content: '回复乙' }] });
      expect(audit[1]!.detail).toMatchObject({ reply: { id: replyA, content: '回复甲', entry_id: entry } });

      // 目标账号被删除后，审计行仍在，target_user_id 置空
      await database.run('DELETE FROM guestbook_entries WHERE user_id = ?', [bob]);
      await database.run('DELETE FROM guestbook_replies WHERE user_id = ?', [alice]);
      await database.run('DELETE FROM guestbook_entries WHERE user_id = ?', [alice]);
      await database.run('DELETE FROM auth_users WHERE id = ?', [alice]);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM admin_audit_log')).toBe(2);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM admin_audit_log WHERE target_user_id IS NULL AND action = ?', ['GUESTBOOK_DELETE_ENTRY'])).toBe(1);
    });
  }, 120_000);
});
