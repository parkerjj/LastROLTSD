import type { KeEntitlements } from '../../src/ke/entitlements';
import type { CharacterRow, HostedRowLite, InstanceRow, KeRepository, KeTx } from '../../src/ke/repository';

/** KE 仓库的内存假实现：只验证串行化之后的业务分支，没有真实行锁。 */
export interface FakeRepository extends KeRepository {
  /** 同一份内存状态上的事务视图，供托管假仓库复用。 */
  tx: KeTx;
  characters: Map<string, CharacterRow>;
  instances: Map<string, InstanceRow>;
  /** 按用户覆盖权益；未设置的用户沿用默认（邮箱已验证：1 个额度 + core 模块）。 */
  entitlements: Map<number, KeEntitlements>;
  hostedRows: Map<string, HostedRowLite>;
  hostedIds: Set<string>;
  /** 每个用户的“非 signup 额外额度”之和与最晚到期时间。 */
  hostingModule: Map<number, number>;
  hostingExpiry: Map<number, number>;
  policyStops: string[];
  statuses: Map<string, string>;
}

export function makeFakeRepository(): FakeRepository {
  const characters = new Map<string, CharacterRow>();
  const instances = new Map<string, InstanceRow>();
  const entitlements = new Map<number, KeEntitlements>();
  const hostedRows = new Map<string, HostedRowLite>();
  const hostedIds = new Set<string>();
  const hostingModule = new Map<number, number>();
  const hostingExpiry = new Map<number, number>();
  const policyStops: string[] = [];
  const statuses = new Map<string, string>();
  const key = (aid: number, cid: number, nid: number): string => `${aid}:${cid}:${nid}`;

  const tx: KeTx = {
    async lockUser() {
      // 无真实行锁；测试只验证串行化后的业务分支。
    },
    async readEntitlements(userId) {
      return entitlements.get(userId) ?? { slots: 1, modules: new Set(['core']) };
    },
    async findCharacter(aid, cid, nid) {
      return characters.get(key(aid, cid, nid)) ?? null;
    },
    async insertCharacter(userId, r, now) {
      characters.set(key(r.aid, r.cid, r.nid), {
        aid: r.aid, cid: r.cid, nid: r.nid, user_id: userId,
        char_name: r.char_name, base_level: r.base_level, job_level: r.job_level, job_id: r.job_id,
        map_name: r.map_name, bound_at: now, last_seen_at: now,
      });
    },
    async updateCharacterReport(userId, r, now) {
      const character = characters.get(key(r.aid, r.cid, r.nid));
      if (character && character.user_id === userId) Object.assign(character, {
        char_name: r.char_name, base_level: r.base_level, job_level: r.job_level, job_id: r.job_id, map_name: r.map_name, last_seen_at: now,
      });
    },
    async transferCharacter(userId, r, now) {
      const character = characters.get(key(r.aid, r.cid, r.nid));
      if (character) Object.assign(character, {
        user_id: userId, bound_at: now, char_name: r.char_name, base_level: r.base_level, job_level: r.job_level, job_id: r.job_id, map_name: r.map_name, last_seen_at: now,
      });
    },
    async insertInstance(instanceId, userId, r, buildId, _ipHash, _uaHash, now) {
      instances.set(instanceId, {
        instance_id: instanceId, user_id: userId, aid: r.aid, cid: r.cid, nid: r.nid,
        char_name: r.char_name, map_name: r.map_name, state: 'IDLE', mode: 'auto', features: null, build_id: buildId,
        license_expires_at: null, last_heartbeat_at: null, started_at: null,
        kicked_at: null, kicked_by_instance_id: null, stopped_at: null, kick_reason: null, updated_at: now,
      });
    },
    async findInstance(instanceId) {
      return instances.get(instanceId) ?? null;
    },
    async rebindInstance(instanceId, r, buildId, _ipHash, _uaHash, now) {
      const instance = instances.get(instanceId);
      if (!instance) return;
      const wasActive = instance.state === 'ACTIVE';
      Object.assign(instance, {
        aid: r.aid, cid: r.cid, nid: r.nid, char_name: r.char_name, map_name: r.map_name, build_id: buildId,
        ...(wasActive ? { state: 'STOPPED', stopped_at: now } : {}),
      });
    },
    async updateInstanceReport(instanceId, r, licenseExpiresAt, _buildId, _ipHash, _uaHash, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, {
        char_name: r.char_name, map_name: r.map_name, last_heartbeat_at: now, license_expires_at: licenseExpiresAt,
      });
    },
    async activateInstance(instanceId, mode, featuresJson, buildId, _ipHash, _uaHash, licenseExpiresAt, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, {
        state: 'ACTIVE', mode, features: featuresJson, build_id: buildId,
        license_expires_at: licenseExpiresAt,
        started_at: instance.state === 'ACTIVE' && instance.started_at !== null ? instance.started_at : now,
        last_heartbeat_at: now, updated_at: now,
        kicked_at: null, kicked_by_instance_id: null, kick_reason: null, stopped_at: null,
      });
    },
    async markKicked(instanceId, kickedBy, now, reason) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, { state: 'KICKED', kicked_at: now, kicked_by_instance_id: kickedBy, kick_reason: reason, updated_at: now });
    },
    async markStopped(instanceId, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, { state: 'STOPPED', stopped_at: now });
    },
    async countActive(userId, excludeInstanceId, threshold) {
      let count = 0;
      for (const instance of instances.values()) {
        if (instance.user_id === userId && instance.state === 'ACTIVE' && instance.mode === 'auto' && instance.instance_id !== excludeInstanceId && (instance.last_heartbeat_at ?? 0) > threshold) count += 1;
      }
      return count;
    },
    async listActive(userId, threshold) {
      const active: { instance_id: string; char_name: string | null; map_name: string | null; last_heartbeat_at: number | null; hosted: boolean }[] = [];
      for (const instance of instances.values()) {
        if (instance.user_id === userId && instance.state === 'ACTIVE' && instance.mode === 'auto' && (instance.last_heartbeat_at ?? 0) > threshold) {
          const hosted = hostedIds.has(instance.instance_id);
          active.push({ instance_id: instance.instance_id, char_name: hosted ? `[托管] ${instance.char_name ?? ''}` : instance.char_name, map_name: instance.map_name, last_heartbeat_at: instance.last_heartbeat_at, hosted });
        }
      }
      return active;
    },
    async readHostingEntitlement(userId) {
      const base = entitlements.get(userId) ?? { slots: 1, modules: new Set(['core']) };
      // hostingModule：>= 1 表示该用户拥有有效的 module:hosting。
      const hasHosting = (hostingModule.get(userId) ?? 0) >= 1;
      return { slots: base.slots, hasHosting, hasCore: base.modules.has('core'), hostingExpiresAt: hasHosting ? hostingExpiry.get(userId) ?? null : null };
    },
    async listSameCharacter(userId, aid, cid, nid, excludeInstanceId) {
      return [...instances.values()]
        .filter((i) => i.user_id === userId && i.aid === aid && i.cid === cid && i.nid === nid && i.instance_id !== excludeInstanceId && (i.state === 'ACTIVE' || i.state === 'IDLE'))
        .map((i) => ({ instance_id: i.instance_id, state: i.state, last_heartbeat_at: i.last_heartbeat_at, updated_at: i.updated_at, hosted: hostedIds.has(i.instance_id) }));
    },
    async listActiveForConvergence(userId, threshold) {
      return [...instances.values()]
        .filter((i) => i.user_id === userId && i.state === 'ACTIVE' && i.mode === 'auto' && (i.last_heartbeat_at ?? 0) > threshold)
        .map((i) => ({ instance_id: i.instance_id, started_at: i.started_at ?? 0, hosted: hostedIds.has(i.instance_id) }));
    },
    async findHostedRow(instanceId) {
      return hostedRows.get(instanceId) ?? null;
    },
    async stopHostedByPolicy(instanceId) {
      const row = hostedRows.get(instanceId);
      if (row) row.desired = 'stopped';
      policyStops.push(instanceId);
    },
    async saveStatus(instanceId, statusJson) {
      statuses.set(instanceId, statusJson);
    },
  };

  return {
    tx,
    characters,
    instances,
    entitlements,
    hostedRows,
    hostedIds,
    hostingModule,
    hostingExpiry,
    policyStops,
    statuses,
    findCharacter: (aid, cid, nid) => tx.findCharacter(aid, cid, nid),
    findInstance: (instanceId) => tx.findInstance(instanceId),
    listCharacters: async (userId) => [...characters.values()].filter((character) => character.user_id === userId),
    transaction: (work) => work(tx),
    cleanup: async () => {},
  };
}

