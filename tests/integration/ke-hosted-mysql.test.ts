// 托管（离线挂机）全部 SQL 的真实 MySQL 验证（迁移 028）。与 ke-mysql 共用 withAuthTestDatabase：
// 需要 MYSQL_TEST_URL（库名以 _test 结尾、且不同于 MYSQL_URL）与 AUTH_TEST_DB_ALLOW_RESET=1，会清空并重建该库。
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { digestToken } from '../../apps/worker/src/auth/crypto';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import type { KeConfig } from '../../apps/worker/src/ke/config';
import { KE_PERMANENT_MS } from '../../apps/worker/src/ke/entitlements';
import { AGENT_LEASE_MS, AGENT_FAILOVER_MARGIN_MS } from '../../apps/worker/src/ke/hosted/policy';
import { createHostedRepository } from '../../apps/worker/src/ke/hosted/repository';
import { createHostedService } from '../../apps/worker/src/ke/hosted/service';
import { createKeRepository } from '../../apps/worker/src/ke/repository';
import { createKeService } from '../../apps/worker/src/ke/service';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;

const AGENT_A = 'agt_0000000000000000000000a1';
const AGENT_B = 'agt_0000000000000000000000b2';

function config(): KeConfig {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    enabled: true, licensePrivateKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })), licenseKeyVersion: '1',
    coreKey: new Uint8Array(32).fill(9), coreKeyVersion: '3', networkKey: new Uint8Array(32).fill(8), networkKeyVersion: '2',
    buildManifest: null, hostedCredentialKey: new Uint8Array(32).fill(5), hostedCredentialKeyVersion: 1,
  };
}

async function insertUser(database: MysqlDatabase, name: string, extraSlots: number): Promise<number> {
  const result = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`${name}@example.test`, `${name}@example.test`, name, 'ACTIVE', 1, 1, 1],
  );
  const grant = (resource: string, quantity: number, source: string, ref: string, expiresAt = 1 + KE_PERMANENT_MS) =>
    database.run(
      'INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      [result.insertId, resource, quantity, 1, expiresAt, source, ref, 1],
    );
  await grant('slots', 1, 'signup', 'email-verified:slots');
  await grant('module:core', 1, 'signup', 'email-verified:module:core');
  if (extraSlots > 0) await grant('slots', extraSlots, 'admin', 'test-extra', Date.now() + 40 * 24 * 3600 * 1000);
  return result.insertId;
}

async function insertAgent(database: MysqlDatabase, id: string, maxInstances: number, lastSeen: number): Promise<void> {
  await database.run(
    "INSERT INTO ke_agents (agent_id, name, pubkey, max_instances, status, accepting, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, 'online', 1, ?, 1, 1)",
    [id, `vps-${id.slice(-2)}`, Buffer.alloc(32, 1), maxInstances, lastSeen],
  );
}

const create = (service: ReturnType<typeof createHostedService>, userId: number, aid = 1000001) =>
  service.create(String(userId), { nid: 3, aid, cid: 2000002, charName: `Char${aid}`, gameAccount: `acct${aid}`, gamePassword: `pw-${aid}` });

describe.skipIf(!runMysqlTests)('托管 × MySQL（迁移 028）', () => {
  it('迁移：既有 manual 行变成 auto，新表与唯一键就位', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const tables = await database.all<{ table_name: string }>(
        "SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_NAME LIKE 'ke\\_%'",
      );
      const names = tables.map((row) => row.table_name);
      for (const table of ['ke_agents', 'ke_agent_nonces', 'ke_hosted_credentials', 'ke_hosted_instances', 'ke_hosted_tokens', 'ke_instance_status']) {
        expect(names).toContain(table);
      }
      const column = await database.first<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND TABLE_NAME = 'ke_instances' AND COLUMN_NAME = 'kick_reason'",
      );
      expect(Number(column!.n)).toBe(1);
    });
  }, 120_000);

  it('创建→启动→调度→launch→租约→停止→回执：每条 SQL 在真实 MySQL 上都通', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const alice = await insertUser(database, 'alice', 1);
      await insertAgent(database, AGENT_A, 5, now);
      const repository = createHostedRepository(database);
      const service = createHostedService(repository, config(), () => now);

      const { id } = await create(service, alice);
      const blob = await database.first<{ game_password_enc: Buffer }>('SELECT game_password_enc FROM ke_hosted_credentials WHERE user_id = ?', [alice]);
      expect(Buffer.from(blob!.game_password_enc).toString('utf8')).not.toContain('pw-1000001');
      await expect(create(service, alice)).rejects.toMatchObject({ code: 'KE_HOSTED_EXISTS' });

      expect((await service.start(String(alice), id)).notify).toEqual([AGENT_A]);
      const row = await database.first<{ assigned_agent: string; epoch: number | string; active_char_key: string }>(
        'SELECT assigned_agent, epoch, active_char_key FROM ke_hosted_instances WHERE instance_id = ?', [id],
      );
      expect(row).toMatchObject({ assigned_agent: AGENT_A, active_char_key: '3:1000001:2000002' });
      expect(Number(row!.epoch)).toBe(1);
      expect(Number((await database.first<{ reserved: number | string }>('SELECT reserved FROM ke_agents WHERE agent_id = ?', [AGENT_A]))!.reserved)).toBe(1);

      const agent = (await repository.findAgent(AGENT_A))!;
      const lease = await service.lease(agent, { version: '1', packageId: 'pkg', memAvailableMb: 900, cleanSlate: false, instances: [] });
      expect(lease.instances).toEqual([expect.objectContaining({ id, epoch: 1, desired: 'running' })]);

      const launched = await service.launch(agent, id, 1);
      expect(launched).toMatchObject({ game_account: 'acct1000001', game_password: 'pw-1000001', launch_seq: 1 });
      const token = await repository.readHostedBearer(await digestToken(launched.ltsd_token.slice(4)), now);
      expect(token).toMatchObject({ instanceId: id, epoch: 1, launchSeq: 1, userId: alice });
      const instance = await database.first<{ state: string; mode: string }>('SELECT state, mode FROM ke_instances WHERE instance_id = ?', [id]);
      expect(instance).toMatchObject({ state: 'ACTIVE', mode: 'auto' });

      // 通过真实 KE 服务走 bind/start/heartbeat（托管主体），并保存状态快照。
      const keService = createKeService(createKeRepository(database), config(), () => now);
      const report = { aid: 1000001, cid: 2000002, nid: 3, char_name: 'Char1000001', base_level: 99, job_level: 50, job_id: 4008, map_name: 'prt_fild08' };
      const input = { instanceId: id, report, needWasmKey: false, kePublicKey: null, buildId: null, buildHash: null, ipHash: null, uaHash: null, hosted: { instanceId: id, epoch: 1, launchSeq: 1 } };
      await keService.bind(String(alice), input);
      await keService.start(String(alice), { ...input, kickInstanceId: null });
      await keService.heartbeat(String(alice), id, report, Math.floor(now / 1000), { buildId: null, buildHash: null, ipHash: null, uaHash: null }, { hosted: input.hosted, status: { v: 1, ai: 'auto' } });
      const status = await repository.transaction((tx) => tx.readStatus(id));
      expect(JSON.parse(status!.statusJson)).toEqual({ v: 1, ai: 'auto' });
      const listed = await repository.transaction((tx) => tx.listHostedByUser(alice));
      expect(listed[0]).toMatchObject({ charName: 'Char1000001', agentName: 'vps-a1' });

      await service.stop(String(alice), id);
      await service.report(agent, id, { epoch: 1, phase: 'stopped', retryAt: null });
      expect(await database.first('SELECT 1 AS x FROM ke_hosted_instances WHERE instance_id = ? AND assigned_agent IS NULL AND desired = ?', [id, 'stopped'])).not.toBeNull();
      expect(Number((await database.first<{ reserved: number | string }>('SELECT reserved FROM ke_agents WHERE agent_id = ?', [AGENT_A]))!.reserved)).toBe(0);
      expect((await database.first<{ revoked_at: number | null }>('SELECT revoked_at FROM ke_hosted_tokens WHERE instance_id = ? ORDER BY id LIMIT 1', [id]))!.revoked_at).not.toBeNull();
      await service.remove(String(alice), id);
      expect(Number((await database.first<{ n: number | string }>('SELECT COUNT(*) AS n FROM ke_hosted_credentials'))!.n)).toBe(0);
    });
  }, 120_000);

  it('同一角色同时只有一个运行中的托管记录（唯一索引）；agent 名额计数器不会超卖', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const alice = await insertUser(database, 'alice', 1);
      const bob = await insertUser(database, 'bob', 1);
      await insertAgent(database, AGENT_A, 1, now);
      const service = createHostedService(createHostedRepository(database), config(), () => now);
      const mine = await create(service, alice);
      const theirs = await create(service, bob);
      await service.start(String(alice), mine.id);
      await expect(service.start(String(bob), theirs.id)).rejects.toMatchObject({ code: 'KE_HOSTED_CHARACTER_BUSY' });

      // 容量 1 的 agent 已满：第二个角色排队，不超卖。
      const second = await create(service, alice, 1000009);
      expect((await service.start(String(alice), second.id)).notify).toEqual([]);
      const rows = await database.all<{ phase: string; assigned_agent: string | null }>('SELECT phase, assigned_agent FROM ke_hosted_instances WHERE instance_id = ?', [second.id]);
      expect(rows[0]).toMatchObject({ phase: 'queued', assigned_agent: null });
    });
  }, 120_000);

  it('资格到期后租约对账与 Cron 都会停止所有托管实例', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const alice = await insertUser(database, 'alice', 1);
      await insertAgent(database, AGENT_A, 5, now);
      const repository = createHostedRepository(database);
      let clock = now;
      const service = createHostedService(repository, config(), () => clock);
      const a = await create(service, alice, 1);
      const b = await create(service, alice, 2);
      await service.start(String(alice), a.id);
      await service.start(String(alice), b.id);
      // 额外额度（40 天后到期）过期：把时间拨到之后；免费额度是 99 年的。
      clock = now + 41 * 24 * 3600 * 1000;
      await database.run('UPDATE ke_agents SET last_seen = ? WHERE agent_id = ?', [clock, AGENT_A]);
      const summary = await service.tick();
      expect(summary.enforced).toBe(2);
      const states = await database.all<{ desired: string; stop_reason: string; active_char_key: string | null }>('SELECT desired, stop_reason, active_char_key FROM ke_hosted_instances ORDER BY aid');
      expect(states).toEqual([
        { desired: 'stopped', stop_reason: 'no-hosting-entitlement', active_char_key: null },
        { desired: 'stopped', stop_reason: 'no-hosting-entitlement', active_char_key: null },
      ]);
    });
  }, 120_000);

  it('故障转移：agent 过期（且另一台健康）后实例改派，epoch+1，旧 token 被吊销；Cron 重复执行是幂等的', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const alice = await insertUser(database, 'alice', 1);
      await insertAgent(database, AGENT_A, 5, now);
      await insertAgent(database, AGENT_B, 5, now);
      await database.run('UPDATE ke_agents SET reserved = 4 WHERE agent_id = ?', [AGENT_B]); // 让第一次分配落在 A
      const repository = createHostedRepository(database);
      let clock = now;
      const service = createHostedService(repository, config(), () => clock);
      const { id } = await create(service, alice);
      await service.start(String(alice), id);
      await service.launch((await repository.findAgent(AGENT_A))!, id, 1);
      await database.run('UPDATE ke_agents SET reserved = 0 WHERE agent_id = ?', [AGENT_B]);

      clock = now + AGENT_LEASE_MS + AGENT_FAILOVER_MARGIN_MS + 5000;
      await database.run('UPDATE ke_agents SET last_seen = ? WHERE agent_id = ?', [clock - 10_000, AGENT_B]);
      const first = await service.tick();
      expect(first.failedOver).toEqual([AGENT_A]);
      const moved = await database.first<{ assigned_agent: string; epoch: number | string; desired: string }>('SELECT assigned_agent, epoch, desired FROM ke_hosted_instances WHERE instance_id = ?', [id]);
      expect(moved).toMatchObject({ assigned_agent: AGENT_B, desired: 'running' });
      expect(Number(moved!.epoch)).toBe(2);
      const live = await database.first<{ n: number | string }>('SELECT COUNT(*) AS n FROM ke_hosted_tokens WHERE instance_id = ? AND revoked_at IS NULL', [id]);
      expect(Number(live!.n)).toBe(0);
      const second = await service.tick();
      expect(second.failedOver).toEqual([]);
    });
  }, 120_000);

  it('半自动同样占额度、同角色续连接管、托管实例出现在踢人列表里（真实 SQL）', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const now = Date.now();
      const alice = await insertUser(database, 'alice', 0);
      const keService = createKeService(createKeRepository(database), config(), () => now);
      const attestation = { buildId: null, buildHash: null, ipHash: null, uaHash: null };
      const base = (instanceId: string, aid: number) => ({
        instanceId, report: { aid, cid: 2, nid: 3, char_name: `C${aid}`, base_level: null, job_level: null, job_id: null, map_name: null },
        needWasmKey: false, kePublicKey: null, ...attestation,
      });
      const A = '11111111-1111-4111-8111-111111111111';
      const B = '22222222-2222-4222-8222-222222222222';
      const C = '33333333-3333-4333-8333-333333333333';
      await keService.bind(String(alice), base(A, 1));
      await keService.start(String(alice), { ...base(A, 1), kickInstanceId: null, mode: 'manual' });
      expect((await database.first<{ mode: string }>('SELECT mode FROM ke_instances WHERE instance_id = ?', [A]))!.mode).toBe('auto');
      // 额度 1 已被占：另一个角色的 manual 也要被拦下。
      await keService.bind(String(alice), base(B, 2));
      await expect(keService.start(String(alice), { ...base(B, 2), kickInstanceId: null, mode: 'manual' })).rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      // 同角色用新 instance_id 重新开启：直接接管，旧实例带 reason。
      await keService.bind(String(alice), base(C, 1));
      await keService.start(String(alice), { ...base(C, 1), kickInstanceId: null });
      const kicked = await database.first<{ state: string; kick_reason: string }>('SELECT state, kick_reason FROM ke_instances WHERE instance_id = ?', [A]);
      expect(kicked).toMatchObject({ state: 'KICKED', kick_reason: 'character_takeover' });
      // started_at 是首次进入 ACTIVE 的时间：幂等续期不改变它。
      const first = Number((await database.first<{ started_at: number | string }>('SELECT started_at FROM ke_instances WHERE instance_id = ?', [C]))!.started_at);
      const later = createKeService(createKeRepository(database), config(), () => now + 60_000);
      await later.start(String(alice), { ...base(C, 1), kickInstanceId: null });
      expect(Number((await database.first<{ started_at: number | string }>('SELECT started_at FROM ke_instances WHERE instance_id = ?', [C]))!.started_at)).toBe(first);
    });
  }, 120_000);
});
