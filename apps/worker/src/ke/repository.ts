import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import { queryEntitlements, queryHostingEntitlement, type HostingEntitlementView, type KeEntitlements } from './entitlements';
import type { ActiveInstanceInfo, CharacterReport, KeLicenseMode } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 踢人列表里托管实例的名字前缀（旧版客户端没有 hosted 字段，也能从名字上认出来）。 */
export const HOSTED_LABEL = '[托管] ';

export interface CharacterRow {
  aid: number;
  cid: number;
  nid: number;
  user_id: number | null;
  char_name: string;
  base_level: number | null;
  job_level: number | null;
  job_id: number | null;
  map_name: string | null;
  bound_at: number | null;
  last_seen_at: number;
}

export interface InstanceRow {
  instance_id: string;
  user_id: number;
  aid: number;
  cid: number;
  nid: number;
  char_name: string | null;
  map_name: string | null;
  state: string;
  mode: KeLicenseMode;
  features: string | null;
  build_id: string | null;
  license_expires_at: number | null;
  last_heartbeat_at: number | null;
  started_at: number | null;
  kicked_at: number | null;
  kicked_by_instance_id: string | null;
  stopped_at: number | null;
  kick_reason: string | null;
  updated_at: number;
}

/** 同一角色下仍有效（ACTIVE/IDLE）的其他实例；hosted 标记它是否为托管实例。 */
export interface SameCharacterRow {
  instance_id: string;
  state: string;
  last_heartbeat_at: number | null;
  updated_at: number;
  hosted: boolean;
}

/** 超额收敛用：占槽的 ACTIVE auto 实例及其首次进入 ACTIVE 的时间。 */
export interface ConvergenceRow {
  instance_id: string;
  started_at: number;
  hosted: boolean;
}

/** 托管记录的最小视图：供 bind/start/heartbeat 校验 epoch 与登记的角色身份。 */
export interface HostedRowLite {
  instance_id: string;
  user_id: number;
  nid: number;
  aid: number;
  cid: number;
  desired: string;
  assigned_agent: string | null;
  epoch: number;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readCharacter(row: MysqlRow): CharacterRow {
  return {
    aid: asNumber(row.aid),
    cid: asNumber(row.cid),
    nid: asNumber(row.nid),
    user_id: asNullableNumber(row.user_id),
    char_name: typeof row.char_name === 'string' ? row.char_name : '',
    base_level: asNullableNumber(row.base_level),
    job_level: asNullableNumber(row.job_level),
    job_id: asNullableNumber(row.job_id),
    map_name: asNullableString(row.map_name),
    bound_at: asNullableNumber(row.bound_at),
    last_seen_at: asNumber(row.last_seen_at),
  };
}

function readInstance(row: MysqlRow): InstanceRow {
  return {
    instance_id: String(row.instance_id),
    user_id: asNumber(row.user_id),
    aid: asNumber(row.aid),
    cid: asNumber(row.cid),
    nid: asNumber(row.nid),
    char_name: asNullableString(row.char_name),
    map_name: asNullableString(row.map_name),
    state: String(row.state),
    mode: row.mode === 'manual' ? 'manual' : 'auto',
    features: asNullableString(row.features),
    build_id: asNullableString(row.build_id),
    license_expires_at: asNullableNumber(row.license_expires_at),
    last_heartbeat_at: asNullableNumber(row.last_heartbeat_at),
    started_at: asNullableNumber(row.started_at),
    kicked_at: asNullableNumber(row.kicked_at),
    kicked_by_instance_id: asNullableString(row.kicked_by_instance_id),
    stopped_at: asNullableNumber(row.stopped_at),
    kick_reason: asNullableString(row.kick_reason),
    updated_at: asNumber(row.updated_at ?? 0),
  };
}

/** 事务作用域内的细分读写；由 createKeRepository 绑定到事务连接。 */
export interface KeTx {
  /** 串行化同一账号的所有 KE 写操作（SELECT ... FOR UPDATE），消除额度判定的 TOCTOU 竞态。 */
  lockUser(userId: number): Promise<void>;
  /** 账号在 now 时刻生效的额度与模块（流水按时间窗口求和，过期 / 已撤销的不计）。 */
  readEntitlements(userId: number, now: number): Promise<KeEntitlements>;
  findCharacter(aid: number, cid: number, nid: number): Promise<CharacterRow | null>;
  insertCharacter(userId: number, report: CharacterReport, now: number): Promise<void>;
  /** 仅更新归属 userId 的角色行：KE 上报的 aid/cid/nid 不可信，不能借此改写他人角色。 */
  updateCharacterReport(userId: number, report: CharacterReport, now: number): Promise<void>;
  transferCharacter(userId: number, report: CharacterReport, now: number): Promise<void>;
  insertInstance(instanceId: string, userId: number, report: CharacterReport, buildId: string | null, ipHash: Uint8Array | null, uaHash: Uint8Array | null, now: number): Promise<void>;
  findInstance(instanceId: string): Promise<InstanceRow | null>;
  /** 把已有实例换绑到另一个角色；ACTIVE 的实例同时置为 STOPPED（旧角色的授权不再有效）。 */
  rebindInstance(instanceId: string, report: CharacterReport, buildId: string | null, ipHash: Uint8Array | null, uaHash: Uint8Array | null, now: number): Promise<void>;
  updateInstanceReport(instanceId: string, report: CharacterReport, licenseExpiresAt: number, buildId: string | null, ipHash: Uint8Array | null, uaHash: Uint8Array | null, now: number): Promise<void>;
  activateInstance(instanceId: string, mode: KeLicenseMode, featuresJson: string, buildId: string | null, ipHash: Uint8Array | null, uaHash: Uint8Array | null, licenseExpiresAt: number, now: number): Promise<void>;
  markKicked(instanceId: string, kickedBy: string, now: number, reason: string): Promise<void>;
  markStopped(instanceId: string, now: number): Promise<void>;
  /** 只统计占额度的 auto 实例；manual（半自动）实例不计入。 */
  countActive(userId: number, excludeInstanceId: string, threshold: number): Promise<number>;
  listActive(userId: number, threshold: number): Promise<ActiveInstanceInfo[]>;
  /** 托管资格视图（离线挂机权益、总额度、最晚到期时间）；与 readEntitlements 同源流水。 */
  readHostingEntitlement(userId: number, now: number): Promise<HostingEntitlementView>;
  /** 同一用户同一角色下仍有效（ACTIVE/IDLE）的其他实例（续连接管 / 托管互斥判断）。 */
  listSameCharacter(userId: number, aid: number, cid: number, nid: number, excludeInstanceId: string): Promise<SameCharacterRow[]>;
  /** 占槽的 ACTIVE auto 实例（超额收敛用）。 */
  listActiveForConvergence(userId: number, threshold: number): Promise<ConvergenceRow[]>;
  /** 托管记录最小视图；非托管实例返回 null。 */
  findHostedRow(instanceId: string): Promise<HostedRowLite | null>;
  /** 因资格/额度策略停止托管实例：desired=stopped 并吊销其 token；已停止的不重复处理。 */
  stopHostedByPolicy(instanceId: string, reason: string, now: number): Promise<void>;
  /** 监控台展示用的最新状态快照（覆盖写）。 */
  saveStatus(instanceId: string, statusJson: string, now: number): Promise<void>;
}

export interface KeRepository {
  findCharacter(aid: number, cid: number, nid: number): Promise<CharacterRow | null>;
  findInstance(instanceId: string): Promise<InstanceRow | null>;
  listCharacters(userId: number): Promise<CharacterRow[]>;
  transaction<T>(work: (tx: KeTx) => Promise<T>): Promise<T>;
  /** 定时清理：过期 ACTIVE 置 STOPPED，回收超龄 IDLE/KICKED/STOPPED 行。 */
  cleanup(now: number): Promise<void>;
}

export function txFor(db: MysqlDatabase): KeTx {
  return {
    async lockUser(userId) {
      await db.all('SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [userId]);
    },

    readEntitlements: (userId, now) => queryEntitlements(db, userId, now),

    async findCharacter(aid, cid, nid) {
      const rows = await db.all<MysqlRow>(
        'SELECT aid, cid, nid, user_id, char_name, base_level, job_level, job_id, map_name, bound_at, last_seen_at FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ?',
        [aid, cid, nid],
      );
      return rows.length > 0 ? readCharacter(rows[0]!) : null;
    },

    async insertCharacter(userId, report, now) {
      await db.run(
        'INSERT INTO ke_characters (aid, cid, nid, user_id, char_name, base_level, job_level, job_id, map_name, bound_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [report.aid, report.cid, report.nid, userId, report.char_name, report.base_level, report.job_level, report.job_id, report.map_name, now, now, now, now],
      );
    },

    async updateCharacterReport(userId, report, now) {
      await db.run(
        'UPDATE ke_characters SET char_name = ?, base_level = ?, job_level = ?, job_id = ?, map_name = ?, last_seen_at = ?, updated_at = ? WHERE aid = ? AND cid = ? AND nid = ? AND user_id = ?',
        [report.char_name, report.base_level, report.job_level, report.job_id, report.map_name, now, now, report.aid, report.cid, report.nid, userId],
      );
    },

    async transferCharacter(userId, report, now) {
      await db.run(
        'UPDATE ke_characters SET user_id = ?, bound_at = ?, char_name = ?, base_level = ?, job_level = ?, job_id = ?, map_name = ?, last_seen_at = ?, updated_at = ? WHERE aid = ? AND cid = ? AND nid = ?',
        [userId, now, report.char_name, report.base_level, report.job_level, report.job_id, report.map_name, now, now, report.aid, report.cid, report.nid],
      );
    },

    async insertInstance(instanceId, userId, report, buildId, ipHash, uaHash, now) {
      await db.run(
        'INSERT INTO ke_instances (instance_id, user_id, aid, cid, nid, char_name, map_name, state, build_id, ip_hash, ua_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [instanceId, userId, report.aid, report.cid, report.nid, report.char_name, report.map_name, 'IDLE', buildId, ipHash, uaHash, now, now],
      );
    },

    async findInstance(instanceId) {
      const rows = await db.all<MysqlRow>(
        'SELECT instance_id, user_id, aid, cid, nid, char_name, map_name, state, mode, features, build_id, license_expires_at, last_heartbeat_at, started_at, kicked_at, kicked_by_instance_id, stopped_at, kick_reason, updated_at FROM ke_instances WHERE instance_id = ?',
        [instanceId],
      );
      return rows.length > 0 ? readInstance(rows[0]!) : null;
    },

    async rebindInstance(instanceId, report, buildId, ipHash, uaHash, now) {
      // MySQL 的 SET 从左到右求值，后面的列会读到前面已更新的值：stopped_at 必须排在 state 之前。
      await db.run(
        "UPDATE ke_instances SET aid = ?, cid = ?, nid = ?, char_name = ?, map_name = ?, build_id = ?, ip_hash = ?, ua_hash = ?, stopped_at = CASE WHEN state = 'ACTIVE' THEN ? ELSE stopped_at END, state = CASE WHEN state = 'ACTIVE' THEN 'STOPPED' ELSE state END, updated_at = ? WHERE instance_id = ?",
        [report.aid, report.cid, report.nid, report.char_name, report.map_name, buildId, ipHash, uaHash, now, now, instanceId],
      );
    },

    async updateInstanceReport(instanceId, report, licenseExpiresAt, buildId, ipHash, uaHash, now) {
      await db.run(
        'UPDATE ke_instances SET char_name = ?, map_name = ?, build_id = ?, ip_hash = ?, ua_hash = ?, last_heartbeat_at = ?, license_expires_at = ?, updated_at = ? WHERE instance_id = ?',
        [report.char_name, report.map_name, buildId, ipHash, uaHash, now, licenseExpiresAt, now, instanceId],
      );
    },

    async activateInstance(instanceId, mode, featuresJson, buildId, ipHash, uaHash, licenseExpiresAt, now) {
      // started_at 是“首次进入 ACTIVE 的时间”，超额收敛按它排序：已经 ACTIVE 的幂等续期不改变它。
      // MySQL 的 SET 从左到右求值：started_at 必须排在 state 之前，才能读到更新前的 state。
      await db.run(
        'UPDATE ke_instances SET started_at = CASE WHEN state = ? AND started_at IS NOT NULL THEN started_at ELSE ? END, state = ?, mode = ?, features = ?, build_id = ?, ip_hash = ?, ua_hash = ?, license_expires_at = ?, last_heartbeat_at = ?, kicked_at = NULL, kicked_by_instance_id = NULL, kick_reason = NULL, stopped_at = NULL, updated_at = ? WHERE instance_id = ?',
        ['ACTIVE', now, 'ACTIVE', mode, featuresJson, buildId, ipHash, uaHash, licenseExpiresAt, now, now, instanceId],
      );
    },

    async markKicked(instanceId, kickedBy, now, reason) {
      await db.run(
        'UPDATE ke_instances SET state = ?, kicked_at = ?, kicked_by_instance_id = ?, kick_reason = ?, updated_at = ? WHERE instance_id = ?',
        ['KICKED', now, kickedBy, reason, now, instanceId],
      );
    },

    async markStopped(instanceId, now) {
      await db.run(
        'UPDATE ke_instances SET state = ?, stopped_at = ?, updated_at = ? WHERE instance_id = ?',
        ['STOPPED', now, now, instanceId],
      );
    },

    async countActive(userId, excludeInstanceId, threshold) {
      const rows = await db.all<MysqlRow>(
        'SELECT COUNT(*) AS cnt FROM ke_instances WHERE user_id = ? AND state = ? AND mode = ? AND instance_id != ? AND last_heartbeat_at > ?',
        [userId, 'ACTIVE', 'auto', excludeInstanceId, threshold],
      );
      return rows.length > 0 ? asNumber(rows[0]!.cnt) : 0;
    },

    async listActive(userId, threshold) {
      const rows = await db.all<MysqlRow>(
        `SELECT i.instance_id, i.char_name, i.map_name, i.last_heartbeat_at, (h.instance_id IS NOT NULL) AS hosted
         FROM ke_instances AS i
         LEFT JOIN ke_hosted_instances AS h ON h.instance_id = i.instance_id
         WHERE i.user_id = ? AND i.state = ? AND i.mode = ? AND i.last_heartbeat_at > ?`,
        [userId, 'ACTIVE', 'auto', threshold],
      );
      return rows.map((row) => {
        const hosted = asNumber(row.hosted) === 1;
        const name = asNullableString(row.char_name);
        return {
          instance_id: String(row.instance_id),
          char_name: hosted ? `${HOSTED_LABEL}${name ?? ''}` : name,
          map_name: asNullableString(row.map_name),
          last_heartbeat_at: asNullableNumber(row.last_heartbeat_at),
          hosted,
        };
      });
    },

    readHostingEntitlement: (userId, now) => queryHostingEntitlement(db, userId, now),

    async listSameCharacter(userId, aid, cid, nid, excludeInstanceId) {
      const rows = await db.all<MysqlRow>(
        `SELECT i.instance_id, i.state, i.last_heartbeat_at, i.updated_at, (h.instance_id IS NOT NULL) AS hosted
         FROM ke_instances AS i
         LEFT JOIN ke_hosted_instances AS h ON h.instance_id = i.instance_id
         WHERE i.user_id = ? AND i.aid = ? AND i.cid = ? AND i.nid = ? AND i.instance_id <> ? AND i.state IN ('ACTIVE', 'IDLE')`,
        [userId, aid, cid, nid, excludeInstanceId],
      );
      return rows.map((row) => ({
        instance_id: String(row.instance_id),
        state: String(row.state),
        last_heartbeat_at: asNullableNumber(row.last_heartbeat_at),
        updated_at: asNumber(row.updated_at),
        hosted: asNumber(row.hosted) === 1,
      }));
    },

    async listActiveForConvergence(userId, threshold) {
      const rows = await db.all<MysqlRow>(
        `SELECT i.instance_id, i.started_at, (h.instance_id IS NOT NULL) AS hosted
         FROM ke_instances AS i
         LEFT JOIN ke_hosted_instances AS h ON h.instance_id = i.instance_id
         WHERE i.user_id = ? AND i.state = 'ACTIVE' AND i.mode = 'auto' AND i.last_heartbeat_at > ?`,
        [userId, threshold],
      );
      return rows.map((row) => ({
        instance_id: String(row.instance_id),
        started_at: asNumber(row.started_at ?? 0),
        hosted: asNumber(row.hosted) === 1,
      }));
    },

    async findHostedRow(instanceId) {
      const row = await db.first<MysqlRow>(
        'SELECT instance_id, user_id, nid, aid, cid, desired, assigned_agent, epoch FROM ke_hosted_instances WHERE instance_id = ?',
        [instanceId],
      );
      return row === null ? null : {
        instance_id: String(row.instance_id),
        user_id: asNumber(row.user_id),
        nid: asNumber(row.nid),
        aid: asNumber(row.aid),
        cid: asNumber(row.cid),
        desired: String(row.desired),
        assigned_agent: asNullableString(row.assigned_agent),
        epoch: asNumber(row.epoch),
      };
    },

    async stopHostedByPolicy(instanceId, reason, now) {
      await db.run(
        "UPDATE ke_hosted_instances SET desired = 'stopped', active_char_key = NULL, phase = CASE WHEN assigned_agent IS NULL THEN 'stopped' ELSE 'stopping' END, stop_reason = ?, updated_at = ? WHERE instance_id = ? AND desired = 'running'",
        [reason, now, instanceId],
      );
      await db.run('UPDATE ke_hosted_tokens SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL', [now, instanceId]);
    },

    async saveStatus(instanceId, statusJson, now) {
      await db.run(
        'INSERT INTO ke_instance_status (instance_id, status_json, status_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status_json = VALUES(status_json), status_at = VALUES(status_at)',
        [instanceId, statusJson, now],
      );
    },
  };
}

export function createKeRepository(database: MysqlDatabase): KeRepository {
  return {
    findCharacter: (aid, cid, nid) => txFor(database).findCharacter(aid, cid, nid),
    findInstance: (instanceId) => txFor(database).findInstance(instanceId),
    async listCharacters(userId) {
      const rows = await database.all<MysqlRow>(
        'SELECT aid, cid, nid, user_id, char_name, base_level, job_level, job_id, map_name, bound_at, last_seen_at FROM ke_characters WHERE user_id = ? ORDER BY last_seen_at DESC',
        [userId],
      );
      return rows.map(readCharacter);
    },
    transaction: (work) => database.transaction((db) => work(txFor(db))),
    async cleanup(now) {
      await database.run(
        'UPDATE ke_instances SET state = ?, stopped_at = ?, updated_at = ? WHERE state = ? AND license_expires_at < ?',
        ['STOPPED', now, now, 'ACTIVE', now],
      );
      await database.run('DELETE FROM ke_instances WHERE state IN (?, ?) AND updated_at < ?', ['KICKED', 'STOPPED', now - 7 * DAY_MS]);
      await database.run('DELETE FROM ke_instances WHERE state = ? AND updated_at < ?', ['IDLE', now - DAY_MS]);
      // 设备授权：过期的设备码即刻可删（轮询方拿到 expired 后会重新发起）；token 过期/撤销后保留 7 天再清理。
      await database.run('DELETE FROM ke_device_codes WHERE expires_at < ?', [now]);
      await database.run('DELETE FROM ke_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [now - 7 * DAY_MS, now - 7 * DAY_MS]);
    },
  };
}
