import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createMysqlDatabase, type MysqlDatabase } from '../src/db/mysql-client';
import { createBuildRegistry } from '../src/ke/build-registry';
import type { BuildRegistration } from '../src/ke/build-publisher';

const url = process.env.KE_BUILD_REGISTRY_TEST_MYSQL_URL;
const suite = url ? describe : describe.skip;
const registration: BuildRegistration = {
  build_id: 'aaaaaaa-202610232100-123-1', core_sha256: 'a'.repeat(64), commit_sha: 'a'.repeat(40),
  package_id: 'b'.repeat(64), engine_version: '0.1.0', release_tag: 'ke-' + 'a'.repeat(40) + '-123-1', core_key_version: 1,
};
const publisher = { runId: '123', runAttempt: '1', jti: 'test-jti' };

suite('构建登记真实 MySQL 事务', () => {
  let db: MysqlDatabase;
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/ke_registry_test') throw Error('isolated-test-database-required');
    db = createMysqlDatabase(url!);
    await db.run('DROP TABLE IF EXISTS ke_builds');
    await db.run('DROP TABLE IF EXISTS ke_build_policy');
    for (const migration of ['020_ke_build_registry.sql', '021_ke_standalone_modules.sql']) {
      const sql = await readFile(new URL(`../../../migrations/mysql/${migration}`, import.meta.url), 'utf8');
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.run(statement);
    }
  });
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.run('DELETE FROM ke_builds');
    await db.run('UPDATE ke_build_policy SET enforced = 0, enabled_at = NULL WHERE id = 1');
  });
  it('首次登记原子开启，重复登记幂等，未知和不匹配的构建拒绝', async () => {
    const registry = createBuildRegistry(db);
    expect(await registry.assertAllowed(null, null)).toBe(false);
    expect(await registry.register(registration, publisher, 1000)).toMatchObject({ registered: true, registry_enforced: true, ...registration });
    expect(await registry.assertAllowed(registration.build_id, registration.core_sha256)).toBe(true);
    await expect(registry.register(registration, publisher, 2000)).resolves.toMatchObject({ registered: true });
    await expect(registry.assertAllowed('unknown', registration.core_sha256)).rejects.toMatchObject({ code: 'KE_BUILD_REJECTED' });
    await expect(registry.assertAllowed(registration.build_id, 'c'.repeat(64))).rejects.toMatchObject({ code: 'KE_BUILD_REJECTED' });
    expect((await db.first('SELECT COUNT(*) AS total FROM ke_builds'))?.total).toBe(1);
  });
  it('同ID篡改、同run的另一构建和撤销后的重试全部拒绝', async () => {
    const registry = createBuildRegistry(db);
    await registry.register(registration, publisher, 1000);
    await expect(registry.register({ ...registration, core_sha256: 'c'.repeat(64) }, publisher, 2000)).rejects.toMatchObject({ status: 409 });
    await expect(registry.register({ ...registration, build_id: registration.build_id.replace('2100', '2101') }, publisher, 2000)).rejects.toMatchObject({ status: 409 });
    await db.run("UPDATE ke_builds SET status = 'REVOKED', revoked_at = 3000 WHERE build_id = ?", [registration.build_id]);
    await expect(registry.register(registration, publisher, 4000)).rejects.toMatchObject({ status: 409 });
    await expect(registry.assertAllowed(registration.build_id, registration.core_sha256)).rejects.toMatchObject({ code: 'KE_BUILD_REJECTED' });
  });
  it('并发相同登记只有一行，清空构建表也不能关闭校验', async () => {
    const registry = createBuildRegistry(db);
    await Promise.all([registry.register(registration, publisher, 1000), registry.register(registration, publisher, 1000)]);
    expect((await db.first('SELECT COUNT(*) AS total FROM ke_builds'))?.total).toBe(1);
    await db.run('DELETE FROM ke_builds');
    await expect(registry.assertAllowed(registration.build_id, registration.core_sha256)).rejects.toMatchObject({ code: 'KE_BUILD_REJECTED' });
    expect((await db.first('SELECT enforced FROM ke_build_policy WHERE id = 1'))?.enforced).toBe(1);
  });
  it('同一 run 可同时登记 web 与 standalone，旧 web 行保持 kind=web', async () => {
    const registry = createBuildRegistry(db);
    await registry.register(registration, publisher, 1000);
    const standalone = {
      ...registration,
      build_id: `${registration.build_id}-s`,
      core_sha256: 'd'.repeat(64),
      package_id: 'e'.repeat(64),
      network_sha256: 'f'.repeat(64),
      network_key_version: 1,
      standalone_package_id: 'e'.repeat(64),
    };
    await expect(registry.register(standalone, publisher, 2000)).resolves.toMatchObject({ registered: true });
    expect(await db.all('SELECT build_id, kind FROM ke_builds ORDER BY kind')).toEqual([
      { build_id: standalone.build_id, kind: 'standalone' },
      { build_id: registration.build_id, kind: 'web' },
    ]);
    expect(await registry.assertAllowed(standalone.build_id, standalone.core_sha256)).toBe(true);
  });
  it('缺少policy行必须失败，不能退回无白名单模式', async () => {
    const registry = createBuildRegistry(db);
    await db.run('DELETE FROM ke_build_policy');
    await expect(registry.assertAllowed(null, null)).rejects.toMatchObject({ code: 'KE_UNAVAILABLE' });
    await expect(registry.register(registration, publisher, 1000)).rejects.toMatchObject({ code: 'KE_UNAVAILABLE' });
    await db.run('INSERT INTO ke_build_policy (id, enforced) VALUES (1, 0)');
  });
});
