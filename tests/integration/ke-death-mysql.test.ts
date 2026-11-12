// 死亡报告 SQL 的真实 MySQL 验证（迁移 032）。与 ke-hosted-mysql 一样需要 MYSQL_TEST_URL（库名以 _test 结尾）与 AUTH_TEST_DB_ALLOW_RESET=1。
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import type { KeConfig } from '../../apps/worker/src/ke/config';
import { createDeathRepository, MAX_REPORTS_PER_CHARACTER, RETENTION_MS, type NewDeathRow } from '../../apps/worker/src/ke/death/repository';
import { createHostedRepository } from '../../apps/worker/src/ke/hosted/repository';
import { createHostedService } from '../../apps/worker/src/ke/hosted/service';
import { KE_PERMANENT_MS } from '../../apps/worker/src/ke/entitlements';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;

function config(): KeConfig {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    enabled: true, licensePrivateKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })), licenseKeyVersion: '1',
    coreKey: new Uint8Array(32).fill(9), coreKeyVersion: '3', networkKey: new Uint8Array(32).fill(8), networkKeyVersion: '2',
    buildManifest: null, hostedCredentialKey: new Uint8Array(32).fill(5), hostedCredentialKeyVersion: 1,
  };
}

async function hostedInstance(database: MysqlDatabase): Promise<{ userId: number; instanceId: string }> {
  const user = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['d@example.test', 'd@example.test', 'd', 'ACTIVE', 1, 1, 1],
  );
  const soon = Date.now() + 40 * 24 * 3600 * 1000;
  for (const [resource, quantity, expires] of [['slots', 2, soon], ['module:core', 1, 1 + KE_PERMANENT_MS], ['module:hosting', 1, soon]] as const) {
    await database.run(
      'INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, revoked_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, 1)',
      [user.insertId, resource, quantity, expires, 'admin', `t-${resource}`],
    );
  }
  const service = createHostedService(createHostedRepository(database), config(), () => Date.now());
  const { id } = await service.create(String(user.insertId), { nid: 3, aid: 1, cid: 2, charName: 'Char', gameAccount: 'acct', gamePassword: 'pw' });
  return { userId: user.insertId, instanceId: id };
}

const row = (userId: number, instanceId: string, key: string, diedAt: number): NewDeathRow => ({
  userId, instanceId, nid: 3, aid: 1, cid: 2, reportKey: key, diedAt, map: 'pay_dun03', killerMobId: 1016, killerSkillId: 7,
  killerName: '骷髅弓箭手', skillName: '二连矢', cause: 'teleport_no_item', causeLabel: '瞬移失败', fixesTotal: 1, reportJson: '{"reportVersion":1}',
});

describe.skipIf(!runMysqlTests)('死亡报告 × MySQL（迁移 032）', () => {
  it('插入幂等、列表新→旧、应用状态与统计', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const { userId, instanceId } = await hostedInstance(database);
      const repo = createDeathRepository(database);
      expect(await repo.insert(row(userId, instanceId, 'a-1', now - 2000), now)).toBe(true);
      expect(await repo.insert(row(userId, instanceId, 'a-1', now - 2000), now)).toBe(false);
      await repo.insert(row(userId, instanceId, 'a-2', now - 1000), now);
      const list = await repo.list(instanceId, 10);
      expect(list.map((r) => r.reportKey)).toEqual(['a-2', 'a-1']);
      await repo.setFixesState(list[0]!.id, '{"f1":{"status":"applied"}}', 1);
      expect((await repo.get(instanceId, 'a-2'))!.fixesApplied).toBe(1);
      const stats = await repo.stats(now - 7 * 24 * 3600 * 1000);
      expect(stats).toMatchObject({ total: 2, characters: 1, topCause: '瞬移失败' });
      expect(stats.rows[0]).toMatchObject({ map: 'pay_dun03', mobName: '骷髅弓箭手', skillName: '二连矢', deaths: 2, characters: 1 });
    });
  }, 120_000);

  it('清理：每角色只留最近 100 条，并删除超过 90 天的', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const { userId, instanceId } = await hostedInstance(database);
      const repo = createDeathRepository(database);
      for (let i = 0; i < MAX_REPORTS_PER_CHARACTER + 5; i += 1) await repo.insert(row(userId, instanceId, `k-${i}`, now - 1000 * (i + 1)), now);
      await repo.insert(row(userId, instanceId, 'old', now - RETENTION_MS - 1000), now);
      await repo.prune(now);
      const left = await repo.list(instanceId, 500);
      expect(left).toHaveLength(MAX_REPORTS_PER_CHARACTER);
      expect(left.some((r) => r.reportKey === 'old')).toBe(false);
      expect(left[0]!.reportKey).toBe('k-0');
    });
  }, 120_000);
});
