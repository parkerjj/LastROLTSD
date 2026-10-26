// 账号操作日志仓库的真实 MySQL 验证（迁移 022）。与 auth 集成测试共用 withAuthTestDatabase：
// 需要 MYSQL_TEST_URL（库名以 _test 结尾、且不同于 MYSQL_URL）与 AUTH_TEST_DB_ALLOW_RESET=1，会清空并重建该库。
import { describe, expect, it } from 'vitest';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { createActivityRepository } from '../../apps/worker/src/activity/repository';
import { EMPTY_NETWORK, type ActivityRow } from '../../apps/worker/src/activity/types';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;

async function insertUser(database: MysqlDatabase, name: string): Promise<number> {
  const result = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, permission_level, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`${name}@example.test`, `${name}@example.test`, name, 'ACTIVE', 1, 1, 1, 1],
  );
  return result.insertId;
}

function row(userId: number, createdAt: number, overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    ...EMPTY_NETWORK,
    user_id: userId,
    event: 'LOGIN',
    result: 'SUCCESS',
    aid: null,
    cid: null,
    nid: null,
    ref: null,
    source: 'live',
    request_id: null,
    created_at: createdAt,
    ...overrides,
  };
}

describe.skipIf(!runMysqlTests)('Activity log × MySQL', () => {
  it('insert 后 listForUser 按时间升序，数值 / 布尔列类型正确', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const user = await insertUser(database, 'alice');
      const repository = createActivityRepository(database);
      await repository.insert(
        row(user, 2000, {
          event: 'KE_BIND',
          ip: '113.87.1.2',
          ip_net: '113.87.1.2',
          country: 'CN',
          latitude: 22.5431,
          longitude: 114.0579,
          asn: 4134,
          as_org: 'Chinanet',
          is_hosting: true,
          aid: 11,
          cid: 22,
          nid: 33,
          ref: 'inst-1',
          request_id: 'req-1',
        }),
      );
      await repository.insert(row(user, 1000));

      const { records, truncated } = await repository.listForUser(user, 10);
      expect(truncated).toBe(false);
      expect(records.map((record) => record.created_at)).toEqual([1000, 2000]);
      const bind = records[1]!;
      expect(typeof bind.id).toBe('number');
      expect(typeof bind.user_id).toBe('number');
      expect(typeof bind.created_at).toBe('number');
      expect(bind).toMatchObject({ event: 'KE_BIND', result: 'SUCCESS', source: 'live', is_hosting: true, asn: 4134, aid: 11, cid: 22, nid: 33, ref: 'inst-1' });
      expect(bind.latitude).toBeCloseTo(22.5431, 4);
      expect(typeof bind.latitude).toBe('number');
      expect(typeof bind.longitude).toBe('number');
      expect(records[0]!.is_hosting).toBe(false);
      expect(records[0]!.latitude).toBeNull();
      expect(records[0]!.asn).toBeNull();
    });
  });

  it('listForUser 超出 limit 时返回最近的 limit 条并标记 truncated', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const user = await insertUser(database, 'alice');
      const repository = createActivityRepository(database);
      for (let index = 1; index <= 5; index += 1) await repository.insert(row(user, index * 100));
      const { records, truncated } = await repository.listForUser(user, 3);
      expect(truncated).toBe(true);
      expect(records.map((record) => record.created_at)).toEqual([300, 400, 500]);
    });
  });

  it('countUsers 按 ip_net / device_id / fingerprint 统计去重账号数', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      const repository = createActivityRepository(database);
      const device = '0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
      const fingerprint = 'a'.repeat(64);
      const shared = { ip_net: '113.87.1.2', device_id: device, fingerprint };
      await repository.insert(row(alice, 1, shared));
      await repository.insert(row(alice, 2, shared));
      await repository.insert(row(bob, 3, shared));
      expect(await repository.countUsers('ip_net', '113.87.1.2')).toBe(2);
      expect(await repository.countUsers('device_id', device)).toBe(2);
      expect(await repository.countUsers('fingerprint', fingerprint)).toBe(2);
      expect(await repository.countUsers('ip_net', '9.9.9.9')).toBe(0);
    });
  });

  it('latestIpNetForRef 返回该 ref 最近一条，无记录返回 null', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const user = await insertUser(database, 'alice');
      const repository = createActivityRepository(database);
      expect(await repository.latestIpNetForRef('inst-1')).toBeNull();
      await repository.insert(row(user, 100, { ref: 'inst-1', ip_net: '1.1.1.1' }));
      await repository.insert(row(user, 200, { ref: 'inst-1', ip_net: '2.2.2.2' }));
      await repository.insert(row(user, 300, { ref: 'inst-2', ip_net: '3.3.3.3' }));
      expect(await repository.latestIpNetForRef('inst-1')).toEqual({ ip_net: '2.2.2.2' });
    });
  });

  it('cleanup 只删 created_at < before 的行，单批不超过 batchSize', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const user = await insertUser(database, 'alice');
      const repository = createActivityRepository(database);
      for (const createdAt of [100, 200, 300, 1000, 2000]) await repository.insert(row(user, createdAt));
      expect(await repository.cleanup(1000, 2)).toBe(2);
      expect(await repository.cleanup(1000, 2)).toBe(1);
      expect(await repository.cleanup(1000, 2)).toBe(0);
      const { records } = await repository.listForUser(user, 10);
      expect(records.map((record) => record.created_at)).toEqual([1000, 2000]);
    });
  });
});
