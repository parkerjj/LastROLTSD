// KE 全部仓库层 SQL 的真实 MySQL 验证（迁移 009/012–015）。与 auth 集成测试共用 withAuthTestDatabase：
// 需要 MYSQL_TEST_URL（库名以 _test 结尾、且不同于 MYSQL_URL）与 AUTH_TEST_DB_ALLOW_RESET=1，会清空并重建该库。
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../../apps/worker/src/auth/types';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import type { AppEnv } from '../../apps/worker/src/env';
import { resolveKeConfig } from '../../apps/worker/src/ke/config';
import { createKeRepository } from '../../apps/worker/src/ke/repository';
import { createKeService } from '../../apps/worker/src/ke/service';
import { createProfileRepository } from '../../apps/worker/src/ke/profile-repository';
import { createProfileService } from '../../apps/worker/src/ke/profile-service';
import { createTokenRepository } from '../../apps/worker/src/ke/token-repository';
import { createTokenService } from '../../apps/worker/src/ke/token-service';
import { KE_TOKEN_MAX_PER_USER, KE_TOKEN_TTL_MS } from '../../apps/worker/src/ke/types';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;

const INST_A = '11111111-1111-4111-8111-111111111111';
const INST_B = '22222222-2222-4222-8222-222222222222';
const INST_BOB = '33333333-3333-4333-8333-333333333333';
const INST_ALICE_2 = '44444444-4444-4444-8444-444444444444';
const attestation = { ipHash: new Uint8Array(32).fill(1), uaHash: new Uint8Array(32).fill(2) };
const DAY_MS = 24 * 60 * 60 * 1000;

async function insertUser(database: MysqlDatabase, name: string): Promise<number> {
  const result = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`${name}@example.test`, `${name}@example.test`, name, 'ACTIVE', 1, 1, 1],
  );
  return result.insertId;
}

async function count(database: MysqlDatabase, sql: string, values: unknown[] = []): Promise<number> {
  const row = await database.first<{ n: number | string }>(sql, values);
  return Number(row?.n ?? 0);
}

describe.skipIf(!runMysqlTests)('KE × MySQL', () => {
  it('设备授权 + Bearer：全流程、重复 user_code、版本/禁用失效、封顶淘汰、撤销、cron 清理', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      let nowMs = Date.now();
      const repository = createTokenRepository(database);
      const service = createTokenService(repository, { siteUrl: 'https://t.example' }, () => nowMs);

      const code = await service.createDeviceCode({ label: '电脑 A', ...attestation });
      // user_code 撞号：唯一键冲突被识别为 false（调用方重试）
      expect(await repository.insertDeviceCode({
        digest: new Uint8Array(32).fill(9), userCode: code.user_code.replace('-', ''), label: 'x', ipHash: null, uaHash: null, now: nowMs, expiresAt: nowMs + 1000,
      })).toBe(false);

      expect(await service.poll(code.device_code, attestation)).toEqual({ status: 'pending', interval: 5 });
      expect((await service.lookup(code.user_code)).label).toBe('电脑 A');
      await service.decide(String(alice), code.user_code, true);
      await expect(service.decide(String(bob), code.user_code, true)).rejects.toMatchObject({ code: 'KE_DEVICE_NOT_FOUND' });

      nowMs += 6000;
      const approved = await service.poll(code.device_code, attestation);
      if (approved.status !== 'approved') throw new Error('expected approved');
      expect(await service.authenticate(`Bearer ${approved.access_token}`)).toMatchObject({ userId: String(alice) });
      await expect(service.poll(code.device_code, attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_EXPIRED' });

      // 滑动续期真正写库
      nowMs += 61 * 60 * 1000;
      await service.authenticate(`Bearer ${approved.access_token}`);
      const stored = await database.first<{ expires_at: number | string; last_used_at: number | string }>('SELECT expires_at, last_used_at FROM ke_tokens WHERE user_id = ? ORDER BY id LIMIT 1', [alice]);
      expect(Number(stored!.expires_at)).toBe(nowMs + KE_TOKEN_TTL_MS);
      expect(Number(stored!.last_used_at)).toBe(nowMs);

      // authVersion 变化（改密码/登出全部）与账号禁用：立即失效；还原后恢复
      await database.run('UPDATE auth_users SET auth_version = auth_version + 1 WHERE id = ?', [alice]);
      await expect(service.authenticate(`Bearer ${approved.access_token}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
      await database.run('UPDATE auth_users SET auth_version = auth_version - 1 WHERE id = ?', [alice]);
      await service.authenticate(`Bearer ${approved.access_token}`);
      await database.run("UPDATE auth_users SET status = 'DISABLED' WHERE id = ?", [alice]);
      await expect(service.authenticate(`Bearer ${approved.access_token}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
      await database.run("UPDATE auth_users SET status = 'ACTIVE' WHERE id = ?", [alice]);

      // 封顶淘汰：再登录 20 次，最久未用的被撤销，仍保持 20 个有效
      for (let i = 0; i < KE_TOKEN_MAX_PER_USER; i += 1) {
        nowMs += 1000;
        const next = await service.createDeviceCode({ label: `设备 ${i}`, ...attestation });
        await service.decide(String(alice), next.user_code, true);
        nowMs += 6000;
        expect((await service.poll(next.device_code, attestation)).status).toBe('approved');
      }
      const listed = await service.list(String(alice));
      expect(listed).toHaveLength(KE_TOKEN_MAX_PER_USER);
      await expect(service.authenticate(`Bearer ${approved.access_token}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });

      await expect(service.revoke(String(bob), listed[0]!.id)).rejects.toMatchObject({ code: 'KE_TOKEN_NOT_FOUND' });
      await service.revoke(String(alice), listed[0]!.id);
      expect(await service.list(String(alice))).toHaveLength(KE_TOKEN_MAX_PER_USER - 1);

      // 批准后账号被禁用：兑换失败，设备码被清掉
      const doomed = await service.createDeviceCode({ label: '将被拒', ...attestation });
      await service.decide(String(bob), doomed.user_code, true);
      await database.run("UPDATE auth_users SET status = 'DISABLED' WHERE id = ?", [bob]);
      nowMs += 6000;
      await expect(service.poll(doomed.device_code, attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_DENIED' });
      expect(await count(database, 'SELECT COUNT(*) AS n FROM ke_device_codes WHERE user_code = ?', [doomed.user_code.replace('-', '')])).toBe(0);

      // cron 清理：过期设备码；过期/撤销超 7 天的 token
      const stale = await service.createDeviceCode({ label: '过期', ...attestation });
      nowMs += 11 * 60 * 1000;
      await createKeRepository(database).cleanup(nowMs);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM ke_device_codes WHERE user_code = ?', [stale.user_code.replace('-', '')])).toBe(0);
      nowMs += KE_TOKEN_TTL_MS + 8 * DAY_MS;
      await createKeRepository(database).cleanup(nowMs);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM ke_tokens')).toBe(0);
    });
  }, 120_000);

  it('授权链路：bind / start / 踢人 / 心跳 / 陈旧复活 / 角色不匹配 / 无主角色 / stop', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      let nowMs = Date.now();
      const { generateKeSecrets } = await import(new URL('../../scripts/generate-ke-secrets.mjs', import.meta.url).href) as {
        generateKeSecrets(): { licensePrivateKey: string; coreKey: string };
      };
      const secrets = generateKeSecrets();
      const config = resolveKeConfig(
        { KE_LICENSE_PRIVATE_KEY_v1: secrets.licensePrivateKey, KE_CORE_KEY: secrets.coreKey } as unknown as AppEnv,
        { enabled: true } as AuthConfig,
      );
      const repository = createKeRepository(database);
      const service = createKeService(repository, config, () => nowMs);

      const report = (over: Record<string, unknown> = {}) => ({
        aid: 7001, cid: 7002, nid: 7003, char_name: '甲', base_level: 99, job_level: 50, job_id: 4008, map_name: 'prt_fild08', ...over,
      });
      const input = (instanceId: string, over: Record<string, unknown> = {}) => ({
        instanceId, report: report(over), needWasmKey: false, kePublicKey: null, buildId: null, buildHash: null, ...attestation,
      });
      const heartbeat = (userId: number, instanceId: string, over: Record<string, unknown> = {}) =>
        service.heartbeat(String(userId), instanceId, report(over), Math.floor(nowMs / 1000), { buildId: null, buildHash: null, ...attestation });

      await service.bind(String(alice), input(INST_A));
      await service.bind(String(alice), input(INST_A)); // 幂等重试
      await expect(service.bind(String(bob), input(INST_B))).rejects.toMatchObject({ code: 'KE_CHARACTER_BOUND' });
      await expect(service.start(String(alice), { ...input(INST_A, { cid: 9999 }), kickInstanceId: null })).rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });

      expect((await service.start(String(alice), { ...input(INST_A), kickInstanceId: null })).license.split('.')).toHaveLength(2);
      await heartbeat(alice, INST_A);
      await expect(heartbeat(alice, INST_A, { aid: 1 })).rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });

      // 满额 → 返回活跃列表 → 踢人
      const second = { cid: 8002, nid: 8003, char_name: '乙' };
      await service.bind(String(alice), input(INST_B, second));
      const quota = await service.start(String(alice), { ...input(INST_B, second), kickInstanceId: null }).catch((error: unknown) => error);
      expect(quota).toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      expect((quota as { details: { active_instances: unknown[] } }).details.active_instances).toHaveLength(1);
      await service.start(String(alice), { ...input(INST_B, second), kickInstanceId: INST_A });
      await expect(heartbeat(alice, INST_A)).rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED' });

      // 陈旧 ACTIVE 不得凭心跳复活：B 心跳超时后 A 重新占位，B 的心跳被视为被顶替
      nowMs += 11 * 60 * 1000;
      await service.start(String(alice), { ...input(INST_A), kickInstanceId: null });
      await expect(heartbeat(alice, INST_B, second)).rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED' });

      await service.stop(String(alice), INST_A);
      await expect(service.stop(String(alice), INST_A)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });

      // 心跳不得改写他人角色
      const bobChar = { aid: 5001, cid: 5002, nid: 5003 };
      await service.bind(String(bob), input(INST_BOB, { ...bobChar, char_name: 'Bob角色' }));
      await expect(heartbeat(alice, INST_B, { ...bobChar, char_name: '篡改' })).rejects.toBeDefined();
      const victim = await database.first<{ char_name: string }>('SELECT char_name FROM ke_characters WHERE aid = 5001 AND cid = 5002 AND nid = 5003');
      expect(victim!.char_name).toBe('Bob角色');

      // 无主角色（账号已删除 → user_id 置空）可被立即重新绑定
      await database.run('UPDATE ke_characters SET user_id = NULL WHERE aid = 5001 AND cid = 5002 AND nid = 5003');
      await service.bind(String(alice), input(INST_ALICE_2, { ...bobChar, char_name: '新主人' }));
      const owner = await database.first<{ user_id: number | string }>('SELECT user_id FROM ke_characters WHERE aid = 5001 AND cid = 5002 AND nid = 5003');
      expect(Number(owner!.user_id)).toBe(alice);

      // 同一窗口换角色：bind 换绑；运行中的实例置为 STOPPED（旧角色授权失效，验证 UPDATE 的 SET 求值顺序），新角色须重新 start
      const INST_SWITCH = '55555555-5555-4555-8555-555555555555';
      const before = { aid: 6001, cid: 6002, nid: 6003, char_name: '换绑前' };
      const after = { aid: 6001, cid: 6012, nid: 6003, char_name: '换绑后' };
      await service.bind(String(alice), input(INST_SWITCH, before));
      await service.start(String(alice), { ...input(INST_SWITCH, before), kickInstanceId: null });
      await service.bind(String(alice), input(INST_SWITCH, after));
      const rebound = await database.first<{ state: string; cid: number | string; char_name: string; stopped_at: number | string | null }>(
        'SELECT state, cid, char_name, stopped_at FROM ke_instances WHERE instance_id = ?', [INST_SWITCH]);
      expect(rebound).toMatchObject({ state: 'STOPPED', char_name: '换绑后' });
      expect(Number(rebound!.cid)).toBe(6012);
      expect(Number(rebound!.stopped_at)).toBe(nowMs);
      await expect(heartbeat(alice, INST_SWITCH, after)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });
      expect((await service.start(String(alice), { ...input(INST_SWITCH, after), kickInstanceId: null })).license.split('.')).toHaveLength(2);

      // manual（半自动）：需要授权但不占额度；auto↔manual 通过同一实例再次 start 切换（迁移 016 的 mode 列）
      const asBob = { ...bobChar, char_name: '新主人' };
      const modeOf = async (instanceId: string) =>
        (await database.first<{ mode: string }>('SELECT mode FROM ke_instances WHERE instance_id = ?', [instanceId]))!.mode;
      expect(await modeOf(INST_SWITCH)).toBe('auto');
      expect((await service.start(String(alice), { ...input(INST_ALICE_2, asBob), kickInstanceId: null, mode: 'manual' })).license.split('.')).toHaveLength(2);
      expect(await modeOf(INST_ALICE_2)).toBe('manual');
      await heartbeat(alice, INST_ALICE_2, asBob);
      const manualToAuto = await service.start(String(alice), { ...input(INST_ALICE_2, asBob), kickInstanceId: null, mode: 'auto' }).catch((error: unknown) => error);
      expect(manualToAuto).toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      expect((manualToAuto as { details: { active_instances: { instance_id: string }[] } }).details.active_instances.map((item) => item.instance_id)).toEqual([INST_SWITCH]);
      await service.start(String(alice), { ...input(INST_SWITCH, after), kickInstanceId: null, mode: 'manual' });
      expect(await modeOf(INST_SWITCH)).toBe('manual');
      await service.start(String(alice), { ...input(INST_ALICE_2, asBob), kickInstanceId: null, mode: 'auto' });
      expect(await modeOf(INST_ALICE_2)).toBe('auto');

      await repository.cleanup(nowMs + 8 * DAY_MS);
    });
  }, 120_000);

  it('Profile：归属校验、每角色上限、清 active 仅限本人、>64KB 的 control 文件可落库（迁移 014）', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      await database.run(
        'INSERT INTO ke_characters (aid, cid, nid, user_id, char_name, bound_at, last_seen_at, created_at, updated_at) VALUES (7001, 7002, 7003, ?, ?, 1, 1, 1, 1)',
        [alice, '甲'],
      );
      const service = createProfileService(createProfileRepository(database), () => Date.now());
      const input = (name: string, extra: Record<string, string | null> = {}) => ({
        name, config_text: 'attackAuto 2\n', mon_control: null, pickupitems: null, items_control: null, timeouts: null, ...extra,
      });

      await expect(service.create(String(bob), 7001, 7002, 7003, input('偷建'))).rejects.toMatchObject({ code: 'KE_CHARACTER_NOT_FOUND' });
      const first = await service.create(String(alice), 7001, 7002, 7003, input('方案一'));
      await expect(service.create(String(alice), 7001, 7002, 7003, input('方案一'))).rejects.toMatchObject({ code: 'KE_PROFILE_NAME_TAKEN' });
      const second = await service.create(String(alice), 7001, 7002, 7003, input('方案二'));
      await service.activate(String(alice), first.id);
      await service.activate(String(alice), second.id);
      expect((await service.fetchActive(String(alice), 7001, 7002, 7003)).profile_id).toBe(second.id);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM ke_profiles WHERE user_id = ? AND aid = 7001 AND is_active = 1', [alice])).toBe(1);

      // 其他账号在同一角色上的 active（例如转移后的遗留行）不被清除
      await database.run('INSERT INTO ke_profiles (user_id, aid, cid, nid, name, is_active, config_text, created_at, updated_at) VALUES (?, 7001, 7002, 7003, ?, 1, ?, 1, 1)', [bob, '遗留', 'x']);
      await service.activate(String(alice), first.id);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM ke_profiles WHERE user_id = ? AND aid = 7001 AND is_active = 1', [bob])).toBe(1);

      // 迁移 014：超过 64 KB 的 control 文件（中文 3 字节/字）
      const big = '物品 1\n'.repeat(15000);
      expect(new TextEncoder().encode(big).byteLength).toBeGreaterThan(65535);
      const large = await service.create(String(alice), 7001, 7002, 7003, input('大文件', { pickupitems: big, mon_control: big }));
      expect((await service.getById(String(alice), large.id)).pickupitems).toBe(big);

      // 每角色上限 20（已有 3 套）
      for (let i = 0; i < 17; i += 1) await service.create(String(alice), 7001, 7002, 7003, input(`填充${i}`));
      await expect(service.create(String(alice), 7001, 7002, 7003, input('第 21 套'))).rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });
    });
  }, 120_000);
});
