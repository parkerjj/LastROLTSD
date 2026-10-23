import { describe, expect, it } from 'vitest';
import { createSharedProfileService } from '../src/ke/shared-profile-service';
import type { SharedProfileRepository, SharedProfileTx } from '../src/ke/shared-profile-repository';
import type { SharedProfileDetail } from '../src/ke/shared-profile-types';
import { createProfileService } from '../src/ke/profile-service';
import type { ProfileInput, ProfileRepository, ProfileRow, ProfileTx } from '../src/ke/profile-repository';

function fixture() {
  let saved: ProfileRow | null = null;
  let snapshot: ProfileInput | null = null;
  let withdrawn = false;
  const tx: ProfileTx & {
    publishSharing(userId: number, id: number, input: ProfileInput, now: number): Promise<void>;
    withdrawSharing(userId: number, id: number, now: number): Promise<void>;
  } = {
    async lockUser() {}, async ownsCharacter() { return true; },
    async findById() { return saved; }, async findActive() { return null; },
    async listForCharacter() { return saved ? [saved] : []; },
    async insert(userId, aid, cid, nid, input) {
      const { sharing: _sharing, ...profile } = input;
      saved = { id: 1, user_id: userId, aid, cid, nid, is_active: false, sharing: null, ...profile }; return 1;
    },
    async update(_id, input) { const { sharing: _sharing, ...profile } = input; saved = { ...saved!, ...profile }; },
    async clearActive() {}, async setActive() {}, async remove() { saved = null; },
    async publishSharing(_userId, _id, input) { snapshot = { ...input }; },
    async withdrawSharing() { withdrawn = true; },
  };
  const repository: ProfileRepository = {
    findById: tx.findById, findActive: tx.findActive, listForCharacter: tx.listForCharacter,
    transaction: async (work) => work(tx),
  };
  return { service: createProfileService(repository, () => 123), snapshot: () => snapshot, withdrawn: () => withdrawn };
}
const input = (enabled?: boolean): ProfileInput & { sharing?: { enabled: boolean; description?: string } } => ({
  name: '方案', config_text: '原文\r\n', mon_control: null, pickupitems: '', items_control: '  ', timeouts: null,
  ...(enabled === undefined ? {} : { sharing: { enabled, description: '说明' } }),
});

describe('profile sharing transaction integration', () => {
  it('saves the complete original snapshot when sharing is requested', async () => {
    const f = fixture(); await f.service.create('1', 1, 2, 3, input(true));
    expect(f.snapshot()).toMatchObject({ config_text: '原文\r\n', mon_control: null, pickupitems: '', items_control: '  ', timeouts: null });
  });
  it('does not publish old clients or unchecked saves', async () => {
    const f = fixture(); await f.service.create('1', 1, 2, 3, input());
    await f.service.update('1', 1, input(false)); expect(f.snapshot()).toBeNull();
  });
  it('withdraws sharing before deleting its source', async () => {
    const f = fixture(); await f.service.create('1', 1, 2, 3, input()); await f.service.remove('1', 1);
    expect(f.withdrawn()).toBe(true);
  });
});

function sharedFixture() {
  const data: SharedProfileDetail = { id: 10, title: '方案', description: '', job_id: null, author: { id: '1', display_name: '作者' }, share_code: 'ABC-0001',
    like_count: 0, use_count: 0, liked_by_me: false, used_by_me: false, is_mine: false, created_at: 1, updated_at: 1,
    config_text: '原文', mon_control: null, pickupitems: '', items_control: ' ', timeouts: null };
  let published = true;
  let owns = true;
  let count = 0;
  let inTransaction = false;
  const copies = new Map<number, { name: string; owner: number }>();
  const receipts = new Map<string, { request_hash: string; result_profile_id: number; result_name: string; result_owner_id: number | null; use_count: number }>();
  const likes = new Set<number>(); const uses = new Set<number>();
  const tx: SharedProfileTx = {
    async lockUser() {}, async ownsCharacter() { return owns; },
    async findSource() { return { user_id: 1, aid: 1, cid: 2, nid: 3 }; },
    async countProfiles() { return count; }, async nameExists(_user, _input, name) { return [...copies.values()].some((copy) => copy.name === name); },
    async findReceipt(user, id) { const receipt = receipts.get(`${user}:${id}`); return receipt ? { ...receipt, result_owner_id: copies.get(receipt.result_profile_id)?.owner ?? null, use_count: data.use_count } : null; },
    async lockShared(id) { return id === data.id ? { ...data, author_user_id: 1, status: published ? 'PUBLISHED' : 'WITHDRAWN' } : null; },
    async changeLike(user, _id, liked) { if (liked) likes.add(user); else likes.delete(user); data.like_count = likes.size; return data.like_count; },
    async insertProfile(user, _input, _shared, name) { const id = copies.size + 1; copies.set(id, { owner: user, name }); count++; return id; },
    async addUse(user) { if (uses.has(user)) return 0; uses.add(user); data.use_count++; return 1; },
    async insertReceipt(user, _id, request, hash, profileId, name) { receipts.set(`${user}:${request.request_id}`, { request_hash: hash, result_profile_id: profileId, result_name: name, result_owner_id: user, use_count: data.use_count }); },
    async withdrawShared() { published = false; },
    async withdrawSource() { published = false; },
  };
  const repository: SharedProfileRepository = {
    async list(_user, query) { return { items: published ? [data] : [], total: published ? 1 : 0, page: query.page, page_size: 20 }; },
    async findById(_user, id) { return published && id === data.id ? data : null; },
    async findByCode(_user, code) { return published && code === data.share_code ? data : null; },
    async transaction(work) { if (inTransaction) throw new Error('nested transaction'); inTransaction = true; try { return await work(tx); } finally { inTransaction = false; } },
  };
  return { service: createSharedProfileService(repository, () => 12), data, copies, setPublished(value: boolean) { published = value; },
    setOwns(value: boolean) { owns = value; }, setCount(value: number) { count = value; } };
}
const copyRequest = { aid: 2, cid: 2, nid: 3, request_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' };

describe('shared profile service', () => {
  it('normalizes exact share codes and rejects malformed codes or withdrawn records', async () => {
    const f = sharedFixture(); expect((await f.service.getByCode('2', 'abc0001')).id).toBe(10);
    await expect(f.service.getByCode('2', 'abc00012')).rejects.toMatchObject({ status: 400 });
    f.setPublished(false); await expect(f.service.getById('2', 10)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects invalid page/sort/job and invalid copy UUID or character ids', async () => {
    const f = sharedFixture();
    for (const query of [{ sort: 'newest', page: 0 }, { sort: 'bad', page: 1 }, { sort: 'likes', page: 1, job_id: -1 }]) {
      await expect(f.service.list('2', query as Parameters<typeof f.service.list>[1])).rejects.toMatchObject({ status: 400 });
    }
    for (const request of [{ ...copyRequest, aid: -1 }, { ...copyRequest, request_id: 'bad' }]) await expect(f.service.copy('2', 10, request)).rejects.toMatchObject({ status: 400 });
  });
  it('accepts bounded family job IDs and rejects malformed lists', async () => {
    const f = sharedFixture();
    await expect(f.service.list('2', { sort: 'newest', page: 1, job_ids: [1, 7, 13, 4252] })).resolves.toMatchObject({ total: 1 });
    for (const job_ids of [[], [-1], [4294967296], [1, 1], Array.from({ length: 65 }, (_, index) => index)]) {
      await expect(f.service.list('2', { sort: 'newest', page: 1, job_ids })).rejects.toMatchObject({ status: 400 });
    }
    await expect(f.service.list('2', { sort: 'newest', page: 1, job_id: 1, job_ids: [1, 7] })).rejects.toMatchObject({ status: 400 });
  });
  it('likes are idempotent per account and authors cannot self-like', async () => {
    const f = sharedFixture(); await expect(f.service.setLike('1', 10, true)).rejects.toMatchObject({ status: 403 });
    expect(await f.service.setLike('2', 10, true)).toEqual({ liked: true, like_count: 1 });
    expect(await f.service.setLike('2', 10, true)).toEqual({ liked: true, like_count: 1 });
    expect(await f.service.setLike('2', 10, false)).toEqual({ liked: false, like_count: 0 });
    f.setPublished(false); await expect(f.service.setLike('2', 10, true)).rejects.toMatchObject({ status: 404 });
  });
  it('replays canonical UUID receipts, rejects conflicting reuse and deleted results', async () => {
    const f = sharedFixture(); const first = await f.service.copy('2', 10, copyRequest);
    expect(first).toMatchObject({ profile_id: 1, name: '方案', use_count: 1, duplicate: false });
    expect(await f.service.copy('2', 10, { ...copyRequest, request_id: copyRequest.request_id.toLowerCase() })).toEqual({ ...first, duplicate: true });
    await expect(f.service.copy('2', 10, { ...copyRequest, cid: 4 })).rejects.toMatchObject({ status: 409 });
    f.copies.delete(1); await expect(f.service.copy('2', 10, copyRequest)).rejects.toMatchObject({ status: 409 });
  });
  it('author copies do not count usage, cross-job copies work and each account counts once', async () => {
    const f = sharedFixture(); expect((await f.service.copy('1', 10, copyRequest)).use_count).toBe(0);
    expect((await f.service.copy('2', 10, copyRequest)).use_count).toBe(1);
    const again = await f.service.copy('2', 10, { ...copyRequest, request_id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB' });
    expect(again).toMatchObject({ use_count: 1, name: '方案 (3)' });
  });
  it('reserves the existing 64-unit name limit without splitting Unicode characters when appending a suffix', async () => {
    const f = sharedFixture(); f.data.title = '😀'.repeat(32);
    await f.service.copy('2', 10, copyRequest);
    const result = await f.service.copy('2', 10, { ...copyRequest, request_id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB' });
    expect(result.name).toBe('😀'.repeat(30) + ' (2)');
    expect(result.name.length).toBe(64);
  });
  it('rejects unowned characters, full characters and withdrawn snapshots without making a copy', async () => {
    const f = sharedFixture(); f.setOwns(false); await expect(f.service.copy('2', 10, copyRequest)).rejects.toMatchObject({ status: 404 });
    f.setOwns(true); f.setCount(20); await expect(f.service.copy('2', 10, copyRequest)).rejects.toMatchObject({ status: 409 });
    f.setCount(0); f.setPublished(false); await expect(f.service.copy('2', 10, copyRequest)).rejects.toMatchObject({ status: 404 }); expect(f.copies.size).toBe(0);
  });
  it('withdrawal checks source ownership and preserves private source management', async () => {
    const f = sharedFixture(); await expect(f.service.withdraw('2', 1)).rejects.toMatchObject({ status: 403 });
    await f.service.withdraw('1', 1); await f.service.withdraw('1', 1);
    expect((await f.service.list('1', { sort: 'newest', page: 1 })).items).toEqual([]);
  });
});
