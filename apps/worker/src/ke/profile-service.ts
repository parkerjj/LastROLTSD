import type { ProfileInput, ProfileRepository, ProfileRow } from './profile-repository';
import { KeFailure } from './types';

const MAX_PROFILE_BYTES = 512 * 1024;
const MAX_NAME_CHARS = 64;
const MAX_PROFILES_PER_CHARACTER = 20;

export interface ProfileFiles {
  'config.txt': string;
  'mon_control.txt': string;
  'pickupitems.txt': string;
  'items_control.txt': string;
  'timeouts.txt': string;
}

export interface ActiveProfileResponse {
  profile_id: number;
  name: string;
  files: ProfileFiles;
}

export interface ProfileService {
  list(userId: string, aid: number, cid: number, nid: number): Promise<ProfileRow[]>;
  getById(userId: string, id: number): Promise<ProfileRow>;
  create(userId: string, aid: number, cid: number, nid: number, input: ProfileInput): Promise<{ id: number }>;
  update(userId: string, id: number, input: ProfileInput): Promise<void>;
  activate(userId: string, id: number): Promise<void>;
  remove(userId: string, id: number): Promise<void>;
  fetchActive(userId: string, aid: number, cid: number, nid: number): Promise<ActiveProfileResponse>;
}

function validateInput(input: ProfileInput): void {
  if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > MAX_NAME_CHARS) {
    throw new KeFailure('KE_BAD_REQUEST', 400, 'Profile 名称无效');
  }
  if (typeof input.config_text !== 'string' || input.config_text.length < 1 || input.config_text.length > MAX_PROFILE_BYTES) {
    throw new KeFailure('KE_BAD_REQUEST', 400, 'config.txt 无效');
  }
  const controls: readonly [string, string | null][] = [
    ['mon_control', input.mon_control],
    ['pickupitems', input.pickupitems],
    ['items_control', input.items_control],
    ['timeouts', input.timeouts],
  ];
  for (const [label, value] of controls) {
    if (value !== null && (typeof value !== 'string' || value.length > MAX_PROFILE_BYTES)) {
      throw new KeFailure('KE_BAD_REQUEST', 400, `${label} 无效`);
    }
  }
}

function filesOf(profile: ProfileRow): ProfileFiles {
  return {
    'config.txt': profile.config_text,
    'mon_control.txt': profile.mon_control ?? '',
    'pickupitems.txt': profile.pickupitems ?? '',
    'items_control.txt': profile.items_control ?? '',
    'timeouts.txt': profile.timeouts ?? '',
  };
}

export function createProfileService(repository: ProfileRepository, now: () => number = () => Date.now()): ProfileService {
  return {
    async list(userId, aid, cid, nid) {
      return repository.listForCharacter(Number(userId), aid, cid, nid);
    },

    async getById(userId, id) {
      const ownerId = Number(userId);
      const profile = await repository.findById(id);
      if (profile === null) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, 'Profile 不存在');
      if (profile.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, 'Profile 不属于当前账号');
      return profile;
    },

    async create(userId, aid, cid, nid, input) {
      validateInput(input);
      const ownerId = Number(userId);
      const timestamp = now();
      const id = await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        if (!await tx.ownsCharacter(ownerId, aid, cid, nid)) {
          throw new KeFailure('KE_CHARACTER_NOT_FOUND', 404, '角色不存在或不属于当前账号');
        }
        const existing = await tx.listForCharacter(ownerId, aid, cid, nid);
        if (existing.some((profile) => profile.name === input.name)) {
          throw new KeFailure('KE_PROFILE_NAME_TAKEN', 409, 'Profile 名称已存在');
        }
        if (existing.length >= MAX_PROFILES_PER_CHARACTER) {
          throw new KeFailure('KE_BAD_REQUEST', 400, `每个角色最多保存 ${MAX_PROFILES_PER_CHARACTER} 套方案`);
        }
        return await tx.insert(ownerId, aid, cid, nid, input, timestamp);
      });
      return { id };
    },

    async update(userId, id, input) {
      validateInput(input);
      const ownerId = Number(userId);
      const timestamp = now();
      await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        const profile = await tx.findById(id);
        if (profile === null) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, 'Profile 不存在');
        if (profile.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, 'Profile 不属于当前账号');
        const existing = await tx.listForCharacter(ownerId, profile.aid, profile.cid, profile.nid);
        if (existing.some((other) => other.id !== id && other.name === input.name)) {
          throw new KeFailure('KE_PROFILE_NAME_TAKEN', 409, 'Profile 名称已存在');
        }
        await tx.update(id, input, timestamp);
      });
    },

    async activate(userId, id) {
      const ownerId = Number(userId);
      const timestamp = now();
      await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        const profile = await tx.findById(id);
        if (profile === null) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, 'Profile 不存在');
        if (profile.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, 'Profile 不属于当前账号');
        await tx.clearActive(ownerId, profile.aid, profile.cid, profile.nid, timestamp);
        await tx.setActive(id, timestamp);
      });
    },

    async remove(userId, id) {
      const ownerId = Number(userId);
      await repository.transaction(async (tx) => {
        const profile = await tx.findById(id);
        if (profile === null) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, 'Profile 不存在');
        if (profile.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, 'Profile 不属于当前账号');
        await tx.remove(id);
      });
    },

    async fetchActive(userId, aid, cid, nid) {
      const active = await repository.findActive(Number(userId), aid, cid, nid);
      if (active === null) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, '无 active profile');
      return { profile_id: active.id, name: active.name, files: filesOf(active) };
    },
  };
}
