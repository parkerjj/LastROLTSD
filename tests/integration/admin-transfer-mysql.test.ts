// 后台角色转移的真实 MySQL 验证（迁移 012 / 013 / 019 / 022 + 018 审计表）。与 auth 集成测试共用 withAuthTestDatabase：
// 需要 MYSQL_TEST_URL（库名以 _test 结尾、且不同于 MYSQL_URL）与 AUTH_TEST_DB_ALLOW_RESET=1，会清空并重建该库。
import { describe, expect, it } from 'vitest';
import { createActivityRepository } from '../../apps/worker/src/activity/repository';
import { EMPTY_NETWORK, type ActivityEvent } from '../../apps/worker/src/activity/types';
import { createTransferRepository } from '../../apps/worker/src/admin/transfer-repository';
import { createTransferService } from '../../apps/worker/src/admin/transfer-service';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;

const AID = 2000001;
const CID = 150001;
const NID = 7;
const DEVICE = '0aa0aa0a-1111-4222-8333-444455556666';
const FINGERPRINT = 'f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4b5a69788';
const NOW = 1_800_000_000_000;

async function insertUser(database: MysqlDatabase, name: string, status = 'ACTIVE', verifiedAt: number | null = 1): Promise<number> {
  const result = await database.run(
    'INSERT INTO auth_users (email, email_normalized, display_name, status, permission_level, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`${name}@example.test`, `${name}@example.test`, name, status, 1, verifiedAt, 1, 1],
  );
  return result.insertId;
}

async function insertCharacter(database: MysqlDatabase, userId: number | null, aid = AID, cid = CID, nid = NID): Promise<void> {
  await database.run(
    'INSERT INTO ke_characters (aid, cid, nid, user_id, char_name, base_level, job_level, job_id, bound_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 99, 50, 4008, 100, 1, 1, 1)',
    [aid, cid, nid, userId, '测试骑士'],
  );
}

async function insertProfile(database: MysqlDatabase, userId: number, name: string, active: boolean): Promise<number> {
  const result = await database.run(
    'INSERT INTO ke_profiles (user_id, aid, cid, nid, name, is_active, config_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)',
    [userId, AID, CID, NID, name, active ? 1 : 0, 'cfg'],
  );
  return result.insertId;
}

async function insertShare(database: MysqlDatabase, authorId: number, profileId: number): Promise<number> {
  const result = await database.run(
    "INSERT INTO ke_shared_profiles (author_user_id, source_profile_id, share_code, title, description, config_text, status, created_at, updated_at) VALUES (?, ?, 'ABCD2345', '分享', '', 'cfg', 'PUBLISHED', 1, 1)",
    [authorId, profileId],
  );
  return result.insertId;
}

async function insertInstance(database: MysqlDatabase, userId: number): Promise<void> {
  await database.run(
    "INSERT INTO ke_instances (instance_id, user_id, aid, cid, nid, state, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', ?, ?, ?, ?, 'ACTIVE', 1, 1)",
    [userId, AID, CID, NID],
  );
}

async function logActivity(
  database: MysqlDatabase,
  userId: number,
  createdAt: number,
  overrides: { ip?: string; ip_net?: string; device_id?: string; fingerprint?: string; event?: ActivityEvent; aid?: number } = {},
): Promise<void> {
  await createActivityRepository(database).insert({
    ...EMPTY_NETWORK,
    user_id: userId,
    event: overrides.event ?? 'LOGIN',
    result: 'SUCCESS',
    ip: overrides.ip ?? '113.87.10.20',
    ip_net: overrides.ip_net ?? overrides.ip ?? '113.87.10.20',
    device_id: overrides.device_id ?? null,
    fingerprint: overrides.fingerprint ?? null,
    country: 'CN',
    city: '深圳',
    as_org: 'China Telecom',
    aid: overrides.aid ?? null,
    cid: null,
    nid: null,
    ref: null,
    source: 'live',
    request_id: null,
    created_at: createdAt,
  });
}

function build(database: MysqlDatabase) {
  return createTransferService(createTransferRepository(database), createActivityRepository(database), () => NOW);
}

async function count(database: MysqlDatabase, sql: string, values: unknown[] = []): Promise<number> {
  const row = await database.first<{ n: number | string }>(sql, values);
  return Number(row?.n ?? 0);
}

describe.skipIf(!runMysqlTests)('Admin 角色转移 × MySQL', () => {
  it('lists characters by id or email', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      await insertCharacter(database, alice);
      await insertCharacter(database, alice, AID + 1);
      await insertCharacter(database, null, AID + 2);
      const service = build(database);

      const byId = await service.listCharacters(String(alice));
      expect(byId.user.id).toBe(alice);
      expect(byId.characters.map((character) => character.aid)).toEqual([AID, AID + 1]);
      expect(byId.characters[0]).toMatchObject({ cid: CID, nid: NID, char_name: '测试骑士', base_level: 99, job_level: 50, job_id: 4008, bound_at: 100 });

      const byEmail = await service.listCharacters(' Alice@Example.TEST ');
      expect(byEmail.user.id).toBe(alice);
      expect(byEmail.characters).toHaveLength(2);

      await expect(service.listCharacters('999999')).rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND', status: 404 });
      await expect(service.listCharacters('nobody@example.test')).rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND' });
      await expect(service.listCharacters('not-an-account')).rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND' });
    });
  });

  it('preview analyses both accounts', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      await insertCharacter(database, alice);
      // 共同设备 + 同 IP 近时记录，且 B 的日志里出现过该角色的 aid。
      await logActivity(database, alice, 1_000_000, { device_id: DEVICE, fingerprint: FINGERPRINT });
      await logActivity(database, bob, 1_100_000, { device_id: DEVICE, fingerprint: FINGERPRINT, aid: AID });
      await logActivity(database, alice, 1_200_000);
      await logActivity(database, bob, 1_300_000);
      await logActivity(database, alice, 1_400_000);
      await logActivity(database, bob, 1_500_000);
      const service = build(database);

      const preview = await service.preview({ source: String(alice), target: 'bob@example.test', aid: AID, cid: CID, nid: NID });
      expect(preview.source.id).toBe(alice);
      expect(preview.target.id).toBe(bob);
      expect(preview.character).toMatchObject({ aid: AID, char_name: '测试骑士' });
      expect(preview.analysis.verdict).toBe('HIGH');
      expect(preview.timeline).toHaveLength(6);
      expect(preview.timeline.map((row) => row.created_at)).toEqual([1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000, 1_500_000]);
      expect(preview.timeline.map((row) => row.side)).toEqual(['source', 'target', 'source', 'target', 'source', 'target']);
      expect(preview.timeline[0]).toMatchObject({ ip: '113.87.10.20', country: 'CN', city: '深圳', is_hosting: false, event: 'LOGIN', source: 'live' });
      expect(preview.timeline[0]!.fingerprint_short).toBe(FINGERPRINT.slice(0, 4));
      expect(preview.timeline[0]!.fingerprint_short).toHaveLength(4);
      expect(preview.timeline[0]!.device_short).toBe(DEVICE.slice(0, 4));
      expect(preview.timeline[2]!.fingerprint_short).toBeNull();
      expect(preview.timeline[1]!.aid).toBe(AID);
    });
  });

  it('confirm moves character, profiles and detaches shares', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const root = await insertUser(database, 'root');
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      await insertCharacter(database, alice);
      const aActive = await insertProfile(database, alice, '主力', true);
      const aShared = await insertProfile(database, alice, '大厅版', false);
      await insertProfile(database, alice, '其他角色的配置', false);
      await database.run('UPDATE ke_profiles SET aid = ? WHERE name = ?', [AID + 9, '其他角色的配置']);
      const bProfile = await insertProfile(database, bob, '主力', true);
      const shareId = await insertShare(database, alice, aShared);
      await insertInstance(database, alice);
      await logActivity(database, alice, 1_000_000, { device_id: DEVICE, fingerprint: FINGERPRINT });
      await logActivity(database, bob, 1_100_000, { device_id: DEVICE, fingerprint: FINGERPRINT });
      const service = build(database);

      const result = await service.confirm(root, { source: String(alice), target: String(bob), aid: AID, cid: CID, nid: NID, note: '  玩家工单 #123  ' }, 'req-transfer-1');
      expect([...result.moved_profile_ids].sort()).toEqual([aActive, aShared].sort());
      expect(result.detached_share_ids).toEqual([shareId]);

      const character = await database.first<{ user_id: number | string; bound_at: number | string }>(
        'SELECT user_id, bound_at FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ?', [AID, CID, NID]);
      expect(Number(character?.user_id)).toBe(bob);
      expect(Number(character?.bound_at)).toBe(NOW);

      const profiles = await database.all<{ id: number | string; user_id: number | string; name: string; is_active: number | string; aid: number | string }>(
        'SELECT id, user_id, name, is_active, aid FROM ke_profiles ORDER BY id');
      const byId = new Map(profiles.map((row) => [Number(row.id), row]));
      expect(Number(byId.get(aActive)?.user_id)).toBe(bob);
      expect(byId.get(aActive)?.name).toBe('主力（转移）');
      expect(Number(byId.get(aShared)?.user_id)).toBe(bob);
      expect(byId.get(aShared)?.name).toBe('大厅版');
      expect(Number(byId.get(aActive)?.is_active)).toBe(0);
      expect(Number(byId.get(aShared)?.is_active)).toBe(0);
      expect(Number(byId.get(bProfile)?.is_active)).toBe(1);
      expect(profiles.find((row) => row.name === '其他角色的配置')).toMatchObject({ user_id: alice });

      const share = await database.first<{ author_user_id: number | string; status: string; source_profile_id: number | null }>(
        'SELECT author_user_id, status, source_profile_id FROM ke_shared_profiles WHERE id = ?', [shareId]);
      expect(Number(share?.author_user_id)).toBe(alice);
      expect(share?.status).toBe('PUBLISHED');
      expect(share?.source_profile_id).toBeNull();

      const audits = await database.all<{ action: string; actor_user_id: number | string; target_user_id: number | string; request_id: string; created_at: number | string; detail: unknown }>(
        'SELECT action, actor_user_id, target_user_id, request_id, created_at, detail FROM admin_audit_log');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'CHARACTER_TRANSFER', request_id: 'req-transfer-1' });
      expect(Number(audits[0]!.actor_user_id)).toBe(root);
      expect(Number(audits[0]!.target_user_id)).toBe(alice);
      const detailText = typeof audits[0]!.detail === 'string' ? audits[0]!.detail : JSON.stringify(audits[0]!.detail);
      const detail = JSON.parse(detailText);
      expect(detail).toMatchObject({
        from_user_id: alice, to_user_id: bob, aid: AID, cid: CID, nid: NID, char_name: '测试骑士', note: '玩家工单 #123',
      });
      expect([...detail.moved_profile_ids].sort()).toEqual([aActive, aShared].sort());
      expect(detail.detached_share_ids).toEqual([shareId]);
      expect(typeof detail.analysis.score).toBe('number');
      expect(detail.analysis.verdict).toBeTruthy();
      expect(detail.analysis.evidence.length).toBeGreaterThan(0);
      for (const item of detail.analysis.evidence) {
        expect(Object.keys(item).sort()).toEqual(['kind', 'points', 'rule', 'text']);
      }
      expect(detailText).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u);
      expect(detailText).not.toContain(DEVICE);
      expect(detailText).not.toContain(FINGERPRINT);

      for (const userId of [alice, bob]) {
        const rows = await database.all<{ ip: string | null; device_id: string | null; result: string; ref: string; aid: number | string }>(
          "SELECT ip, device_id, result, ref, aid FROM account_activity_log WHERE user_id = ? AND event = 'ADMIN_CHARACTER_TRANSFER'", [userId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ip: null, device_id: null, result: 'SUCCESS', ref: 'req-transfer-1' });
        expect(Number(rows[0]!.aid)).toBe(AID);
      }

      const instance = await database.first<{ user_id: number | string; state: string; updated_at: number | string }>(
        'SELECT user_id, state, updated_at FROM ke_instances');
      expect(Number(instance?.user_id)).toBe(alice);
      expect(instance?.state).toBe('ACTIVE');
      expect(Number(instance?.updated_at)).toBe(1);
    });
  });

  it('confirm renames within 64 code points', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const root = await insertUser(database, 'root');
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      await insertCharacter(database, alice);
      const longName = '配'.repeat(63);
      const full = '满'.repeat(64);
      await insertProfile(database, alice, longName, false);
      await insertProfile(database, alice, full, false);
      await insertProfile(database, bob, longName, false);
      await insertProfile(database, bob, full, false);
      const service = build(database);

      await service.confirm(root, { source: String(alice), target: String(bob), aid: AID, cid: CID, nid: NID, note: 'ok' }, 'req-long');
      const names = (await database.all<{ name: string }>('SELECT name FROM ke_profiles WHERE user_id = ?', [bob])).map((row) => row.name);
      expect(names).toHaveLength(4);
      expect(new Set(names).size).toBe(4);
      for (const name of names) expect([...name].length).toBeLessThanOrEqual(64);
      expect(names.filter((name) => name.endsWith('（转移）') || name.endsWith('（转移2）'))).toHaveLength(2);
    });
  });

  it('confirm rejects stale character', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const root = await insertUser(database, 'root');
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      const carol = await insertUser(database, 'carol');
      await insertCharacter(database, alice);
      const profile = await insertProfile(database, alice, '主力', true);
      const service = build(database);

      await service.preview({ source: String(alice), target: String(bob), aid: AID, cid: CID, nid: NID });
      await database.run('UPDATE ke_characters SET user_id = ? WHERE aid = ?', [carol, AID]);

      await expect(service.confirm(root, { source: String(alice), target: String(bob), aid: AID, cid: CID, nid: NID, note: 'x' }, 'req-stale'))
        .rejects.toMatchObject({ code: 'ADMIN_CHARACTER_NOT_FOUND', status: 404 });
      const row = await database.first<{ user_id: number | string }>('SELECT user_id FROM ke_profiles WHERE id = ?', [profile]);
      expect(Number(row?.user_id)).toBe(alice);
      expect(await count(database, 'SELECT COUNT(*) AS n FROM admin_audit_log')).toBe(0);
      expect(await count(database, "SELECT COUNT(*) AS n FROM account_activity_log WHERE event = 'ADMIN_CHARACTER_TRANSFER'")).toBe(0);
    });
  });

  it('confirm validates target, sameness and note', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const root = await insertUser(database, 'root');
      const alice = await insertUser(database, 'alice');
      const bob = await insertUser(database, 'bob');
      const pending = await insertUser(database, 'pending', 'PENDING_EMAIL', null);
      await insertCharacter(database, alice);
      const service = build(database);
      const base = { aid: AID, cid: CID, nid: NID, note: '备注' };

      await expect(service.confirm(root, { ...base, source: String(alice), target: String(pending) }, 'r1'))
        .rejects.toMatchObject({ code: 'ADMIN_BAD_REQUEST', status: 400, publicMessage: '目标账号必须是已验证邮箱的正常账号' });
      await expect(service.confirm(root, { ...base, source: String(alice), target: 'ALICE@example.test' }, 'r2'))
        .rejects.toMatchObject({ code: 'ADMIN_BAD_REQUEST', status: 400, publicMessage: '源账号和目标账号不能相同' });
      for (const note of ['   ', '', 'x'.repeat(201)]) {
        await expect(service.confirm(root, { ...base, note, source: String(alice), target: String(bob) }, 'r3'))
          .rejects.toMatchObject({ code: 'ADMIN_BAD_REQUEST', status: 400, publicMessage: '请填写审核备注（最多 200 字）' });
      }
      // 200 个码点（含非 BMP 字符）仍然合法
      await expect(service.confirm(root, { ...base, note: '𠮷'.repeat(200), source: String(alice), target: String(bob) }, 'r4')).resolves.toBeDefined();
      await expect(service.confirm(root, { ...base, source: String(alice), target: '999999' }, 'r5'))
        .rejects.toMatchObject({ code: 'ADMIN_USER_NOT_FOUND' });
    });
  });
});
