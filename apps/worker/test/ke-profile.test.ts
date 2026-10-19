import { describe, expect, it } from 'vitest';
import { createProfileService } from '../src/ke/profile-service';
import type { ProfileInput, ProfileRepository, ProfileRow, ProfileTx } from '../src/ke/profile-repository';

interface FakeProfileRepository extends ProfileRepository {
  profiles: Map<number, ProfileRow>;
  /** 「userId:aid:cid:nid」——模拟 ke_characters 中的归属关系。 */
  owners: Set<string>;
}

function makeFakeProfileRepository(): FakeProfileRepository {
  const profiles = new Map<number, ProfileRow>();
  const owners = new Set<string>();
  let nextId = 1;

  const tx: ProfileTx = {
    async lockUser() {
      // 无真实行锁。
    },
    async ownsCharacter(userId, aid, cid, nid) {
      return owners.has(`${userId}:${aid}:${cid}:${nid}`);
    },
    async findById(id) {
      return profiles.get(id) ?? null;
    },
    async findActive(userId, aid, cid, nid) {
      for (const profile of profiles.values()) {
        if (profile.user_id === userId && profile.aid === aid && profile.cid === cid && profile.nid === nid && profile.is_active) return profile;
      }
      return null;
    },
    async listForCharacter(userId, aid, cid, nid) {
      return [...profiles.values()].filter((profile) => profile.user_id === userId && profile.aid === aid && profile.cid === cid && profile.nid === nid);
    },
    async insert(userId, aid, cid, nid, input, _now) {
      const id = nextId;
      nextId += 1;
      profiles.set(id, {
        id, user_id: userId, aid, cid, nid, name: input.name, is_active: false,
        config_text: input.config_text, mon_control: input.mon_control, pickupitems: input.pickupitems, items_control: input.items_control, timeouts: input.timeouts,
      });
      return id;
    },
    async update(id, input, _now) {
      const profile = profiles.get(id);
      if (profile) Object.assign(profile, input);
    },
    async clearActive(userId, aid, cid, nid, _now) {
      for (const profile of profiles.values()) {
        if (profile.user_id === userId && profile.aid === aid && profile.cid === cid && profile.nid === nid) profile.is_active = false;
      }
    },
    async setActive(id, _now) {
      const profile = profiles.get(id);
      if (profile) profile.is_active = true;
    },
    async remove(id) {
      profiles.delete(id);
    },
  };

  return {
    profiles,
    owners,
    findById: (id) => tx.findById(id),
    findActive: (userId, aid, cid, nid) => tx.findActive(userId, aid, cid, nid),
    listForCharacter: (userId, aid, cid, nid) => tx.listForCharacter(userId, aid, cid, nid),
    transaction: (work) => work(tx),
  };
}

function profileInput(name: string): ProfileInput {
  return {
    name,
    config_text: `lockMap prt_fild08\nattackAuto 2\n`,
    mon_control: 'all 1 0 0 0',
    pickupitems: 'all 1',
    items_control: 'all 0 0 0',
    timeouts: 'ai_move_retry 0.4',
  };
}

describe('ke profile service', () => {
  it('create/list/activate/fetchActive 基本闭环', async () => {
    const repository = makeFakeProfileRepository();
    repository.owners.add('10000:1:2:3');
    const service = createProfileService(repository);

    const a = await service.create('10000', 1, 2, 3, profileInput('打波利'));
    const b = await service.create('10000', 1, 2, 3, profileInput('打海豹'));

    const list = await service.list('10000', 1, 2, 3);
    expect(list).toHaveLength(2);

    await service.activate('10000', a.id);
    const active = await service.fetchActive('10000', 1, 2, 3);
    expect(active.profile_id).toBe(a.id);
    expect(active.files['config.txt']).toContain('lockMap prt_fild08');

    await service.activate('10000', b.id);
    expect((await service.fetchActive('10000', 1, 2, 3)).profile_id).toBe(b.id);

    await service.remove('10000', a.id);
    await expect(service.fetchActive('10000', 1, 2, 3)).resolves.toMatchObject({ profile_id: b.id });
  });

  it('每角色仅一个 active；重名返回 KE_PROFILE_NAME_TAKEN', async () => {
    const repository = makeFakeProfileRepository();
    repository.owners.add('10000:1:2:3');
    const service = createProfileService(repository);

    const a = await service.create('10000', 1, 2, 3, profileInput('打波利'));
    await expect(service.create('10000', 1, 2, 3, profileInput('打波利'))).rejects.toMatchObject({ code: 'KE_PROFILE_NAME_TAKEN' });

    await service.activate('10000', a.id);
    const b = await service.create('10000', 1, 2, 3, profileInput('打海豹'));
    await service.activate('10000', b.id);
    const active = await repository.listForCharacter(10000, 1, 2, 3);
    expect(active.filter((profile) => profile.is_active)).toHaveLength(1);
  });

  it('跨账号隔离：其他账号不可见/不可激活', async () => {
    const repository = makeFakeProfileRepository();
    repository.owners.add('10000:1:2:3');
    const service = createProfileService(repository);

    const a = await service.create('10000', 1, 2, 3, profileInput('打波利'));
    await service.activate('10000', a.id);

    expect(await service.list('10001', 1, 2, 3)).toHaveLength(0);
    await expect(service.fetchActive('10001', 1, 2, 3)).rejects.toMatchObject({ code: 'KE_PROFILE_NOT_FOUND' });
    await expect(service.activate('10001', a.id)).rejects.toMatchObject({ code: 'KE_AUTH_FORBIDDEN' });
  });
  it('激活只清除本账号同角色的 active，不影响其他账号', async () => {
    const repository = makeFakeProfileRepository();
    repository.owners.add('10000:1:2:3');
    repository.owners.add('10001:1:2:3'); // 例如角色 30 天后转移、双方仍留有各自的方案
    const service = createProfileService(repository);

    const a = await service.create('10000', 1, 2, 3, profileInput('旧主人方案'));
    await service.activate('10000', a.id);
    const b = await service.create('10001', 1, 2, 3, profileInput('新主人方案'));
    await service.activate('10001', b.id);

    expect((await service.fetchActive('10000', 1, 2, 3)).profile_id).toBe(a.id);
    expect((await service.fetchActive('10001', 1, 2, 3)).profile_id).toBe(b.id);
  });

  it('不属于当前账号的角色不能建方案（KE_CHARACTER_NOT_FOUND）', async () => {
    const repository = makeFakeProfileRepository();
    repository.owners.add('10000:1:2:3');
    const service = createProfileService(repository);

    await expect(service.create('10001', 1, 2, 3, profileInput('偷偷建'))).rejects.toMatchObject({ code: 'KE_CHARACTER_NOT_FOUND' });
    await expect(service.create('10000', 9, 9, 9, profileInput('不存在'))).rejects.toMatchObject({ code: 'KE_CHARACTER_NOT_FOUND' });
  });

  it('每个角色最多 20 套方案', async () => {
    const repository = makeFakeProfileRepository();
    repository.owners.add('10000:1:2:3');
    const service = createProfileService(repository);

    for (let i = 0; i < 20; i += 1) await service.create('10000', 1, 2, 3, profileInput(`方案${i}`));
    await expect(service.create('10000', 1, 2, 3, profileInput('第21套'))).rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });
  });
});
