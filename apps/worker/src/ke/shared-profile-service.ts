import type { SharedProfileRepository } from './shared-profile-repository';
import type { SharedProfileCopyInput, SharedProfileCopyResult, SharedProfileDetail, SharedProfilePage, SharedProfileQuery } from './shared-profile-types';
import { KeFailure } from './types';

export interface SharedProfileService {
  list(userId: string, query: SharedProfileQuery): Promise<SharedProfilePage>;
  getById(userId: string, id: number): Promise<SharedProfileDetail>;
  getByCode(userId: string, code: string): Promise<SharedProfileDetail>;
  setLike(userId: string, id: number, liked: boolean): Promise<{ liked: boolean; like_count: number }>;
  copy(userId: string, id: number, input: SharedProfileCopyInput): Promise<SharedProfileCopyResult>;
  withdrawById(userId: string, sharedProfileId: number): Promise<void>;
  withdraw(userId: string, sourceProfileId: number): Promise<void>;
}
function notFound(): never { throw new KeFailure('KE_SHARED_PROFILE_NOT_FOUND', 404, '共享配置不存在'); }
function conflict(): never { throw new KeFailure('KE_COPY_REQUEST_CONFLICT', 409, '复制请求已使用或结果已删除，请重新发起复制'); }
function integer(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
async function fingerprint(id: number, input: SharedProfileCopyInput): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([id, input.aid, input.cid, input.nid])));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function createSharedProfileService(repository: SharedProfileRepository, now: () => number = () => Date.now()): SharedProfileService {
  return {
    async list(userId, query) {
      if (!['newest', 'uses', 'likes'].includes(query.sort) || !Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger((query.page - 1) * 20)
        || (query.job_id !== undefined && !integer(query.job_id))) throw new KeFailure('KE_BAD_REQUEST', 400, '大厅查询参数无效');
      return repository.list(Number(userId), query);
    },
    async getById(userId, id) { return await repository.findById(Number(userId), id) ?? notFound(); },
    async getByCode(userId, code) {
      const normalized = code.toUpperCase().replace('-', '');
      if (!/^[A-Z]{3}[0-9]{4}$/u.test(normalized)) throw new KeFailure('KE_BAD_REQUEST', 400, '分享码无效');
      return await repository.findByCode(Number(userId), normalized.slice(0, 3) + '-' + normalized.slice(3)) ?? notFound();
    },
    async setLike(userId, id, liked) {
      const owner = Number(userId);
      return repository.transaction(async (tx) => {
        await tx.lockUser(owner);
        const shared = await tx.lockShared(id);
        if (!shared || shared.status !== 'PUBLISHED') notFound();
        if (shared.author_user_id === owner) throw new KeFailure('KE_SHARED_SELF_LIKE', 403, '不能给自己的共享配置点赞');
        return { liked, like_count: await tx.changeLike(owner, id, liked, now()) };
      });
    },
    async copy(userId, id, input) {
      if (![input.aid, input.cid, input.nid].every(integer) || typeof input.request_id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.request_id)) throw new KeFailure('KE_BAD_REQUEST', 400, '复制请求参数无效');
      const canonical = { ...input, request_id: input.request_id.toLowerCase() };
      const owner = Number(userId); const hash = await fingerprint(id, canonical);
      return repository.transaction(async (tx) => {
        await tx.lockUser(owner);
        const receipt = await tx.findReceipt(owner, canonical.request_id);
        if (receipt) {
          if (receipt.request_hash !== hash || receipt.result_owner_id !== owner) conflict();
          return { profile_id: receipt.result_profile_id, name: receipt.result_name, use_count: receipt.use_count, duplicate: true };
        }
        if (!await tx.ownsCharacter(owner, canonical)) throw new KeFailure('KE_CHARACTER_NOT_FOUND', 404, '角色不存在或不属于当前账号');
        if (await tx.countProfiles(owner, canonical) >= 20) throw new KeFailure('KE_PROFILE_LIMIT_REACHED', 409, '每个角色最多保存 20 套方案');
        const shared = await tx.lockShared(id);
        if (!shared || shared.status !== 'PUBLISHED') notFound();
        let name = shared.title;
        for (let suffix = 2; await tx.nameExists(owner, canonical, name); suffix++) {
          const tail = ` (${suffix})`;
          let prefix = '';
          for (const character of shared.title) {
            if (prefix.length + character.length > 64 - tail.length) break;
            prefix += character;
          }
          name = prefix + tail;
        }
        const timestamp = now();
        const profileId = await tx.insertProfile(owner, canonical, shared, name, timestamp);
        const increment = shared.author_user_id === owner ? 0 : await tx.addUse(owner, id, timestamp);
        await tx.insertReceipt(owner, id, canonical, hash, profileId, name, timestamp);
        return { profile_id: profileId, name, use_count: shared.use_count + increment, duplicate: false };
      });
    },
    async withdrawById(userId, id) {
      const owner = Number(userId);
      await repository.transaction(async (tx) => {
        await tx.lockUser(owner);
        const shared = await tx.lockShared(id);
        if (!shared) notFound();
        if (shared.author_user_id !== owner) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '共享配置不属于当前账号');
        await tx.withdrawShared(owner, id, now());
      });
    },
    async withdraw(userId, sourceProfileId) {
      const owner = Number(userId);
      await repository.transaction(async (tx) => {
        await tx.lockUser(owner);
        const profile = await tx.findSource(sourceProfileId);
        if (!profile) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, 'Profile 不存在');
        if (profile.user_id !== owner) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, 'Profile 不属于当前账号');
        await tx.withdrawSource(owner, sourceProfileId, now());
      });
    },
  };
}
