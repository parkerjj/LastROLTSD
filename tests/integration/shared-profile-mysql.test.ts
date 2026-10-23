import { describe, expect, it, vi } from 'vitest';
import { createProfileRepository } from '../../apps/worker/src/ke/profile-repository';
import { createProfileService } from '../../apps/worker/src/ke/profile-service';
import type { ProfileInput } from '../../apps/worker/src/ke/profile-repository';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const run = Boolean(process.env.MYSQL_TEST_URL) || process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const input = (name = '原方案', sharing = true): ProfileInput & { sharing: { enabled: boolean; description?: string } } => ({
  name, config_text: 'config\r\n原文  ', mon_control: null, pickupitems: '', items_control: '  control\n', timeouts: '0',
  sharing: { enabled: sharing, description: '说明\r\n第二行' },
});
async function setup(database: MysqlDatabase) {
  const ids: number[] = [];
  for (const name of ['author', 'reader', 'third']) {
    const { insertId } = await database.run('INSERT INTO auth_users (email, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', [`${name}@example.test`, `${name}@example.test`, name, 'PENDING_EMAIL']);
    ids.push(insertId);
    await database.run('INSERT INTO ke_characters (aid, cid, nid, user_id, char_name, job_id, bound_at, last_seen_at, created_at, updated_at) VALUES (?, 2, 3, ?, ?, ?, 1, 1, 1, 1)', [insertId, insertId, name, name === 'author' ? null : 4001]);
  }
  return { author: String(ids[0]), reader: String(ids[1]), third: String(ids[2]), profiles: createProfileService(createProfileRepository(database), () => 10) };
}
function failingWrites(database: MysqlDatabase, pattern: RegExp): MysqlDatabase {
  return { ...database,
    async run(sql, values) { if (pattern.test(sql)) throw new Error('injected write failure'); return database.run(sql, values); },
    transaction: (work) => database.transaction((tx) => work(failingWrites(tx, pattern))),
  };
}
async function hall(database: MysqlDatabase) {
  const { createSharedProfileRepository } = await import('../../apps/worker/src/ke/shared-profile-repository');
  const { createSharedProfileService } = await import('../../apps/worker/src/ke/shared-profile-service');
  return createSharedProfileService(createSharedProfileRepository(database), () => 20);
}
const request = (reader: string, request_id = '11111111-1111-4111-8111-111111111111') => ({ aid: Number(reader), cid: 2, nid: 3, request_id });

describe.skipIf(!run)('Shared profiles × isolated MySQL', () => {
  it('publishes an owned source profile after its character is unbound without inventing a job snapshot', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const { author, profiles } = await setup(database);
      const source = await profiles.create(author, Number(author), 2, 3, input('原方案', false));
      await database.run('UPDATE ke_characters SET user_id = NULL WHERE aid = ? AND cid = 2 AND nid = 3', [Number(author)]);

      await profiles.update(author, source.id, input('已共享'));

      const personal = await profiles.getById(author, source.id);
      expect(personal.sharing).toMatchObject({ status: 'PUBLISHED' });
      const shared = await (await hall(database)).getById(author, personal.sharing!.id);
      expect(shared.job_id).toBeNull();
      expect(shared.title).toBe('已共享');

      await database.run('DELETE FROM ke_characters WHERE aid = ? AND cid = 2 AND nid = 3', [Number(author)]);
      await profiles.update(author, source.id, input('角色记录缺失'));
      const missingCharacterShare = await (await hall(database)).getById(author, personal.sharing!.id);
      expect(missingCharacterShare.job_id).toBeNull();
      expect(missingCharacterShare.title).toBe('角色记录缺失');
    });
  }, 120000);

  it('publishes atomically, mirrors text/null, preserves identity/statistics on update/recover and withdraws on source deletion', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const { author, reader, profiles } = await setup(database);
      const source = await profiles.create(author, Number(author), 2, 3, input());
      const personal = await profiles.getById(author, source.id);
      expect(personal).toHaveProperty('sharing.share_code', expect.stringMatching(/^[A-Z]{3}-[0-9]{4}$/u));
      const insertShared = "INSERT INTO ke_shared_profiles (author_user_id, source_profile_id, share_code, title, description, config_text, status, created_at, updated_at) VALUES (?, ?, ?, 'x', '', 'x', 'PUBLISHED', 1, 1)";
      await expect(database.run(insertShared, [Number(author), source.id, 'ZZZ-9999'])).rejects.toMatchObject({ errno: 1062 });
      await expect(database.run(insertShared, [Number(author), null, personal.sharing!.share_code])).rejects.toMatchObject({ errno: 1062 });
      await expect(database.run(insertShared, [99999999, null, 'ZZZ-9999'])).rejects.toMatchObject({ errno: 1452 });
      await expect(database.run('UPDATE ke_shared_profiles SET like_count = -1 WHERE id = ?', [personal.sharing!.id])).rejects.toBeDefined();
      const indexes = await database.all<{ INDEX_NAME: string }>("SELECT DISTINCT INDEX_NAME FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ke_shared_profiles'");
      expect(indexes.map((row) => row.INDEX_NAME)).toEqual(expect.arrayContaining(['idx_ke_shared_newest', 'idx_ke_shared_uses', 'idx_ke_shared_likes', 'idx_ke_shared_job_newest', 'idx_ke_shared_job_uses', 'idx_ke_shared_job_likes']));
      const service = await hall(database);
      expect((await service.list(reader, { sort: 'newest', page: 1 })).items[0]).not.toHaveProperty('config_text');
      expect((await service.list(reader, { sort: 'uses', page: 1, job_id: 4001 })).total).toBe(0);
      expect((await service.list(reader, { sort: 'likes', page: 2 })).items).toEqual([]);
      const original = await service.getByCode(reader, personal.sharing!.share_code.toLowerCase().replace('-', ''));
      expect(original).toMatchObject({ config_text: 'config\r\n原文  ', mon_control: null, pickupitems: '', items_control: '  control\n', timeouts: '0', job_id: null, description: '说明\n第二行', author: { id: author, display_name: 'author' } });
      expect(original).not.toHaveProperty('source_profile_id');
      await service.setLike(reader, original.id, true);
      await profiles.update(author, source.id, { ...input('仅个人'), sharing: { enabled: false } });
      expect((await service.getById(reader, original.id)).title).toBe('原方案');
      await service.withdraw(author, source.id);
      await expect(service.getById(reader, original.id)).rejects.toMatchObject({ status: 404 });
      expect((await profiles.getById(author, source.id)).sharing).toMatchObject({ status: 'WITHDRAWN', description: '说明\n第二行' });
      await profiles.update(author, source.id, { ...input('恢复'), sharing: { enabled: true } });
      expect(await service.getById(reader, original.id)).toMatchObject({ id: original.id, share_code: original.share_code, title: '恢复', description: original.description, like_count: 1, created_at: original.created_at });
      await profiles.update(author, source.id, { ...input('恢复'), sharing: { enabled: true, description: '' } });
      expect((await service.getById(reader, original.id)).description).toBe('');
      const copied = await service.copy(reader, original.id, request(reader));
      await profiles.remove(author, source.id);
      await expect(service.getById(reader, original.id)).rejects.toMatchObject({ status: 404 });
      expect((await profiles.getById(reader, copied.profile_id)).config_text).toBe(original.config_text);
      expect(await database.first('SELECT source_profile_id, status FROM ke_shared_profiles WHERE id = ?', [original.id])).toMatchObject({ source_profile_id: null, status: 'WITHDRAWN' });
    });
  }, 120000);

  it('uses unique account likes/copies, prevents self-like and enforces idempotency, collation-aware Unicode names and 20 slots', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const { author, reader, profiles } = await setup(database); const service = await hall(database);
      const source = await profiles.create(author, Number(author), 2, 3, input('é'.repeat(62) + '😀'));
      const shared = (await profiles.getById(author, source.id)).sharing!;
      await expect(service.setLike(author, shared.id, true)).rejects.toMatchObject({ status: 403 });
      expect(await service.setLike(reader, shared.id, true)).toEqual({ liked: true, like_count: 1 });
      expect(await service.setLike(reader, shared.id, true)).toEqual({ liked: true, like_count: 1 });
      expect(await service.setLike(reader, shared.id, false)).toEqual({ liked: false, like_count: 0 });
      expect(await service.setLike(reader, shared.id, false)).toEqual({ liked: false, like_count: 0 });
      await profiles.create(reader, Number(reader), 2, 3, input('e'.repeat(62) + '😀', false));
      const first = await service.copy(reader, shared.id, request(reader));
      expect(first).toMatchObject({ name: 'é'.repeat(60) + ' (2)', use_count: 1, duplicate: false });
      const copy = await profiles.getById(reader, first.profile_id);
      expect(copy).toMatchObject({ user_id: Number(reader), aid: Number(reader), is_active: false, mon_control: null, pickupitems: '', sharing: null });
      expect(await service.copy(reader, shared.id, request(reader))).toEqual({ ...first, duplicate: true });
      await expect(service.copy(reader, shared.id, { ...request(reader), cid: 4 })).rejects.toMatchObject({ status: 409 });
      const second = await service.copy(reader, shared.id, request(reader, '22222222-2222-4222-8222-222222222222'));
      expect(second.use_count).toBe(1);
      await profiles.remove(reader, first.profile_id);
      await expect(service.copy(reader, shared.id, request(reader))).rejects.toMatchObject({ status: 409 });
      expect((await service.copy(author, shared.id, request(author))).use_count).toBe(1);
      const current = await profiles.list(reader, Number(reader), 2, 3);
      for (let i = current.length; i < 20; i++) await profiles.create(reader, Number(reader), 2, 3, input(`填充${i}`, false));
      await expect(service.copy(reader, shared.id, request(reader, '33333333-3333-4333-8333-333333333333'))).rejects.toMatchObject({ status: 409 });
    });
  }, 120000);

  it('rolls back personal saves on eight code collisions or shared write failures and rejects transferred source ownership', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const { author, reader, profiles } = await setup(database);
      let randomCalls = 0;
      const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => { (array as Uint8Array).fill(randomCalls++ === 0 ? 255 : 0); return array; });
      try {
        const first = await profiles.create(author, Number(author), 2, 3, input('first'));
        await expect(profiles.create(author, Number(author), 2, 3, input('collision'))).rejects.toMatchObject({ status: 503 });
        expect(await profiles.list(author, Number(author), 2, 3)).toHaveLength(1);
        expect((await profiles.getById(author, first.id)).sharing!.share_code).toBe('AAA-0000');
        expect(randomCalls).toBe(64); // One rejected byte, seven accepted symbols, then eight seven-symbol collision attempts.
        const failedSave = createProfileService(createProfileRepository(failingWrites(database, /^UPDATE ke_shared_profiles/u)));
        await expect(failedSave.update(author, first.id, input('must rollback'))).rejects.toThrow('injected write failure');
        expect((await profiles.getById(author, first.id)).name).toBe('first');
        const shared = (await profiles.getById(author, first.id)).sharing!;
        const failedCopy = await hall(failingWrites(database, /^INSERT INTO ke_shared_profile_copies/u));
        await expect(failedCopy.copy(reader, shared.id, request(reader))).rejects.toThrow('injected write failure');
        expect(await profiles.list(reader, Number(reader), 2, 3)).toHaveLength(0);
        expect(await database.first('SELECT use_count FROM ke_shared_profiles WHERE id = ?', [shared.id])).toMatchObject({ use_count: 0 });
        expect(await database.first('SELECT COUNT(*) AS n FROM ke_shared_profile_uses')).toMatchObject({ n: 0 });
        expect(await database.first('SELECT COUNT(*) AS n FROM ke_shared_profile_copies')).toMatchObject({ n: 0 });
        await database.run('UPDATE ke_characters SET user_id = ? WHERE aid = ?', [Number(reader), Number(author)]);
        await expect(profiles.update(author, first.id, input('transferred'))).rejects.toMatchObject({ status: 404 });
      } finally { random.mockRestore(); }
    });
  }, 120000);

  it('serializes concurrent UUID replay/likes and copies one whole version during update or withdrawal', async () => {
    await withAuthTestDatabase(async ({ database, createDatabase }) => {
      const { author, reader, third, profiles } = await setup(database);
      const otherDb = createDatabase(); const a = await hall(database); const b = await hall(otherDb);
      const source = await profiles.create(author, Number(author), 2, 3, input()); const shared = (await profiles.getById(author, source.id)).sharing!;
      const copies = await Promise.all([a.copy(reader, shared.id, request(reader)), b.copy(reader, shared.id, request(reader))]);
      expect(new Set(copies.map((x) => x.profile_id)).size).toBe(1); expect(copies.filter((x) => x.duplicate)).toHaveLength(1);
      await Promise.all([a.setLike(reader, shared.id, true), b.setLike(reader, shared.id, true), b.setLike(third, shared.id, true)]);
      expect((await a.getById(reader, shared.id)).like_count).toBe(2);
      const newer = { ...input('new'), config_text: 'new config', mon_control: 'new mon', pickupitems: 'new pickup', items_control: 'new items', timeouts: 'new timeouts' };
      const [, copied] = await Promise.all([profiles.update(author, source.id, newer), b.copy(third, shared.id, request(third))]);
      const version = await profiles.getById(third, copied.profile_id);
      expect([['config\r\n原文  ', null, '', '  control\n', '0'], ['new config', 'new mon', 'new pickup', 'new items', 'new timeouts']]).toContainEqual([version.config_text, version.mon_control, version.pickupitems, version.items_control, version.timeouts]);
      const outcomes = await Promise.allSettled([a.withdraw(author, source.id), b.copy(third, shared.id, request(third, '44444444-4444-4444-8444-444444444444'))]);
      expect(outcomes[0].status).toBe('fulfilled');
      if (outcomes[1].status === 'rejected') expect(outcomes[1].reason).toMatchObject({ status: 404 });
      await expect(a.getById(reader, shared.id)).rejects.toMatchObject({ status: 404 });
      expect(await database.first('SELECT COUNT(*) AS n FROM ke_shared_profile_uses WHERE shared_profile_id = ?', [shared.id])).toMatchObject({ n: 2 });
    });
  }, 120000);
});
