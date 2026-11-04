import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../../db/mysql-client';
import { txFor, type KeTx } from '../repository';
import type { SchedulableAgent } from './policy';

const ER_DUP_ENTRY = 1062;

export interface AgentRow extends SchedulableAgent {
  name: string;
  pubkey: Uint8Array;
  version: string | null;
  packageId: string | null;
}

export interface HostedRow {
  instanceId: string;
  userId: number;
  credentialId: number;
  nid: number;
  aid: number;
  cid: number;
  desired: 'running' | 'stopped';
  phase: string;
  assignedAgent: string | null;
  epoch: number;
  launchSeq: number;
  /** 用户点“同步并重载配置”的累计次数；agent 据此通知子进程重新拉配置。 */
  configSyncSeq: number;
  stopReason: string | null;
  retryAt: number | null;
  launchCommands: string[];
  lastReportAt: number | null;
  migratingSince: number | null;
  createdAt: number;
}

export interface CredentialRow {
  id: number;
  userId: number;
  nid: number;
  aid: number;
  cid: number;
  charName: string;
  gameAccount: string;
  gamePasswordEnc: Uint8Array;
  keyVersion: number;
}

export interface HostedListItem extends HostedRow {
  charName: string;
  agentName: string | null;
  statusJson: string | null;
  statusAt: number | null;
}

export interface NewHostedToken {
  digest: Uint8Array;
  instanceId: string;
  userId: number;
  epoch: number;
  launchSeq: number;
  credentialVersion: number;
  authVersion: number;
  now: number;
  expiresAt: number;
}

export interface HostedBearerRecord {
  tokenId: number;
  userId: number;
  instanceId: string;
  epoch: number;
  launchSeq: number;
}

export type AgentPatch = Partial<{
  lastSeen: number;
  memAvailableMb: number | null;
  version: string | null;
  packageId: string | null;
  status: 'online' | 'down' | 'draining';
  rejectUntil: number | null;
  reserved: number;
}>;

/** 托管事务：既能用 KeTx 的额度/实例读写（launch 预占名额需要），也有托管自己的表。所有操作都在同一事务里。 */
export interface HostedTx {
  ke: KeTx;
  lockAgent(agentId: string): Promise<AgentRow | null>;
  listAgents(): Promise<AgentRow[]>;
  patchAgent(agentId: string, patch: AgentPatch, now: number): Promise<void>;
  /** 服务端自己计算已预留名额：agent 上报的数字只用于告警，不能反过来改计数。 */
  recomputeReserved(agentId: string, now: number): Promise<number>;
  /** 条件抢占名额；false 表示满了/不在线。 */
  reserveAgentSlot(agentId: string): Promise<boolean>;
  insertNonce(agentId: string, nonce: string, now: number): Promise<boolean>;

  readUserVersions(userId: number): Promise<{ credentialVersion: number; authVersion: number } | null>;
  countCredentials(userId: number): Promise<number>;
  countHostedRecords(userId: number): Promise<number>;
  insertCredential(row: Omit<CredentialRow, 'id'>, now: number): Promise<number>;
  findCredential(credentialId: number): Promise<CredentialRow | null>;
  insertHosted(row: { instanceId: string; userId: number; credentialId: number; nid: number; aid: number; cid: number }, now: number): Promise<void>;
  findHosted(instanceId: string): Promise<HostedRow | null>;
  listHostedByUser(userId: number): Promise<HostedListItem[]>;
  listHostedByAgent(agentId: string): Promise<HostedRow[]>;
  listQueued(limit: number): Promise<HostedRow[]>;
  listRunningUserIds(limit: number): Promise<number[]>;
  deleteHosted(instanceId: string): Promise<void>;
  /** 置为运行：设置唯一的 active_char_key；同一角色已有运行中的托管记录则返回 false。 */
  markRunning(instanceId: string, now: number): Promise<boolean>;
  markStopped(instanceId: string, reason: string, now: number): Promise<void>;
  /** 请求“同步并重载配置”：序号加 1。只对已分配到 agent 且 desired=running 的实例生效，返回是否生效。 */
  requestConfigSync(instanceId: string, now: number): Promise<boolean>;
  /** 条件分配：仅当仍未分配且 desired=running；epoch 加 1，launch_seq 归零。 */
  assign(instanceId: string, agentId: string, now: number): Promise<boolean>;
  /** 释放归属；toQueue=true 回到 queued（desired 仍是 running），否则落到 stopped。返回原归属。 */
  release(instanceId: string, toQueue: boolean, reason: string | null, now: number): Promise<string | null>;
  bumpLaunchSeq(instanceId: string, now: number): Promise<number>;
  applyReport(instanceId: string, epoch: number, phase: string, retryAt: number | null, now: number): Promise<boolean>;
  markMigrating(instanceId: string, now: number): Promise<void>;
  revokeTokens(instanceId: string, now: number): Promise<void>;
  insertToken(token: NewHostedToken): Promise<void>;
  readStatus(instanceId: string): Promise<{ statusJson: string; statusAt: number } | null>;
  /** 最近一次实例心跳时间（任何实例）：Cron 判断 Worker 是否正常的证据。 */
  lastHealthEvidence(): Promise<number | null>;
}

export interface HostedRepository {
  transaction<T>(work: (tx: HostedTx) => Promise<T>): Promise<T>;
  /** 签名校验前取公钥：不进事务、不加锁。 */
  findAgent(agentId: string): Promise<AgentRow | null>;
  readHostedBearer(digest: Uint8Array, now: number): Promise<HostedBearerRecord | null>;
  cleanup(now: number): Promise<void>;
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

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return new Uint8Array(0);
}

function readAgent(row: MysqlRow): AgentRow {
  return {
    agentId: String(row.agent_id),
    name: String(row.name),
    pubkey: bytes(row.pubkey),
    status: String(row.status),
    accepting: asNumber(row.accepting) === 1,
    reserved: asNumber(row.reserved),
    maxInstances: asNumber(row.max_instances),
    memAvailableMb: asNullableNumber(row.mem_available_mb),
    lastSeen: asNullableNumber(row.last_seen),
    rejectUntil: asNullableNumber(row.reject_until),
    version: asNullableString(row.version),
    packageId: asNullableString(row.package_id),
  };
}

const AGENT_COLUMNS = 'agent_id, name, pubkey, status, accepting, reserved, max_instances, mem_available_mb, last_seen, reject_until, version, package_id';

function parseCommands(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed as string[];
  } catch {
    // fall through
  }
  return ['ai auto'];
}

const HOSTED_COLUMNS = 'instance_id, user_id, credential_id, nid, aid, cid, desired, phase, assigned_agent, epoch, launch_seq, config_sync_seq, stop_reason, retry_at, launch_commands, last_report_at, migrating_since, created_at';

function readHosted(row: MysqlRow): HostedRow {
  return {
    instanceId: String(row.instance_id),
    userId: asNumber(row.user_id),
    credentialId: asNumber(row.credential_id),
    nid: asNumber(row.nid),
    aid: asNumber(row.aid),
    cid: asNumber(row.cid),
    desired: row.desired === 'running' ? 'running' : 'stopped',
    phase: String(row.phase),
    assignedAgent: asNullableString(row.assigned_agent),
    epoch: asNumber(row.epoch),
    launchSeq: asNumber(row.launch_seq),
    configSyncSeq: asNumber(row.config_sync_seq),
    stopReason: asNullableString(row.stop_reason),
    retryAt: asNullableNumber(row.retry_at),
    launchCommands: parseCommands(row.launch_commands),
    lastReportAt: asNullableNumber(row.last_report_at),
    migratingSince: asNullableNumber(row.migrating_since),
    createdAt: asNumber(row.created_at),
  };
}

function activeCharKey(row: { nid: number; aid: number; cid: number }): string {
  return `${row.nid}:${row.aid}:${row.cid}`;
}

function hostedTxFor(db: MysqlDatabase): HostedTx {
  return {
    ke: txFor(db),

    async lockAgent(agentId) {
      const rows = await db.all<MysqlRow>(`SELECT ${AGENT_COLUMNS} FROM ke_agents WHERE agent_id = ? FOR UPDATE`, [agentId]);
      return rows.length > 0 ? readAgent(rows[0]!) : null;
    },

    async listAgents() {
      return (await db.all<MysqlRow>(`SELECT ${AGENT_COLUMNS} FROM ke_agents ORDER BY agent_id`, [])).map(readAgent);
    },

    async patchAgent(agentId, patch, now) {
      const sets: string[] = [];
      const values: unknown[] = [];
      const map: Record<string, string> = {
        lastSeen: 'last_seen', memAvailableMb: 'mem_available_mb', version: 'version', packageId: 'package_id',
        status: 'status', rejectUntil: 'reject_until', reserved: 'reserved',
      };
      for (const [key, column] of Object.entries(map)) {
        if (key in patch) {
          sets.push(`${column} = ?`);
          values.push((patch as Record<string, unknown>)[key]);
        }
      }
      if (sets.length === 0) return;
      await db.run(`UPDATE ke_agents SET ${sets.join(', ')}, updated_at = ? WHERE agent_id = ?`, [...values, now, agentId]);
    },

    async recomputeReserved(agentId, now) {
      // 先锁 agent 行：并发的 reserveAgentSlot（+1）与随后的 assign 在提交前持有同一把锁，
      // 拿到锁之后再用当前读统计，才不会拿一份过期快照覆盖掉别人刚提交的预留。
      await db.all<MysqlRow>('SELECT agent_id FROM ke_agents WHERE agent_id = ? FOR UPDATE', [agentId]);
      const row = await db.first<MysqlRow>(
        "SELECT COUNT(*) AS n FROM ke_hosted_instances WHERE assigned_agent = ? AND desired = 'running' LOCK IN SHARE MODE",
        [agentId],
      );
      const stopping = await db.first<MysqlRow>(
        "SELECT COUNT(*) AS n FROM ke_hosted_instances WHERE assigned_agent = ? AND desired = 'stopped' LOCK IN SHARE MODE",
        [agentId],
      );
      const total = asNumber(row?.n ?? 0) + asNumber(stopping?.n ?? 0);
      await db.run('UPDATE ke_agents SET reserved = ?, updated_at = ? WHERE agent_id = ?', [total, now, agentId]);
      return total;
    },

    async reserveAgentSlot(agentId) {
      const result = await db.run(
        "UPDATE ke_agents SET reserved = reserved + 1 WHERE agent_id = ? AND status = 'online' AND accepting = 1 AND reserved < max_instances",
        [agentId],
      );
      return result.affectedRows === 1;
    },

    async insertNonce(agentId, nonce, now) {
      try {
        await db.run('INSERT INTO ke_agent_nonces (agent_id, nonce, seen_at) VALUES (?, ?, ?)', [agentId, nonce, now]);
        return true;
      } catch (error) {
        if (error instanceof MysqlDatabaseError && error.errno === ER_DUP_ENTRY) return false;
        throw error;
      }
    },

    async readUserVersions(userId) {
      const row = await db.first<MysqlRow>('SELECT credential_version, auth_version FROM auth_users WHERE id = ?', [userId]);
      return row === null ? null : { credentialVersion: asNumber(row.credential_version), authVersion: asNumber(row.auth_version) };
    },

    async countCredentials(userId) {
      const row = await db.first<MysqlRow>('SELECT COUNT(*) AS n FROM ke_hosted_credentials WHERE user_id = ?', [userId]);
      return asNumber(row?.n ?? 0);
    },

    async countHostedRecords(userId) {
      const row = await db.first<MysqlRow>(
        "SELECT COUNT(*) AS n FROM ke_hosted_instances WHERE user_id = ? AND (desired = 'running' OR assigned_agent IS NOT NULL)",
        [userId],
      );
      return asNumber(row?.n ?? 0);
    },

    async insertCredential(row, now) {
      const result = await db.run(
        'INSERT INTO ke_hosted_credentials (user_id, nid, aid, cid, char_name, game_account, game_password_enc, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.userId, row.nid, row.aid, row.cid, row.charName, row.gameAccount, row.gamePasswordEnc, row.keyVersion, now, now],
      );
      return result.insertId;
    },

    async findCredential(credentialId) {
      const row = await db.first<MysqlRow>(
        'SELECT id, user_id, nid, aid, cid, char_name, game_account, game_password_enc, key_version FROM ke_hosted_credentials WHERE id = ?',
        [credentialId],
      );
      return row === null ? null : {
        id: asNumber(row.id), userId: asNumber(row.user_id), nid: asNumber(row.nid), aid: asNumber(row.aid), cid: asNumber(row.cid),
        charName: String(row.char_name), gameAccount: String(row.game_account), gamePasswordEnc: bytes(row.game_password_enc), keyVersion: asNumber(row.key_version),
      };
    },

    async insertHosted(row, now) {
      await db.run(
        "INSERT INTO ke_hosted_instances (instance_id, user_id, credential_id, nid, aid, cid, desired, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'stopped', 'stopped', ?, ?)",
        [row.instanceId, row.userId, row.credentialId, row.nid, row.aid, row.cid, now, now],
      );
    },

    async findHosted(instanceId) {
      const row = await db.first<MysqlRow>(`SELECT ${HOSTED_COLUMNS} FROM ke_hosted_instances WHERE instance_id = ?`, [instanceId]);
      return row === null ? null : readHosted(row);
    },

    async listHostedByUser(userId) {
      const rows = await db.all<MysqlRow>(
        `SELECT h.${HOSTED_COLUMNS.split(', ').join(', h.')}, c.char_name, a.name AS agent_name, s.status_json, s.status_at
         FROM ke_hosted_instances AS h
         INNER JOIN ke_hosted_credentials AS c ON c.id = h.credential_id
         LEFT JOIN ke_agents AS a ON a.agent_id = h.assigned_agent
         LEFT JOIN ke_instance_status AS s ON s.instance_id = h.instance_id
         WHERE h.user_id = ? ORDER BY h.created_at, h.instance_id`,
        [userId],
      );
      return rows.map((row) => ({
        ...readHosted(row),
        charName: String(row.char_name),
        agentName: asNullableString(row.agent_name),
        statusJson: asNullableString(row.status_json),
        statusAt: asNullableNumber(row.status_at),
      }));
    },

    async listHostedByAgent(agentId) {
      return (await db.all<MysqlRow>(`SELECT ${HOSTED_COLUMNS} FROM ke_hosted_instances WHERE assigned_agent = ? ORDER BY created_at, instance_id`, [agentId])).map(readHosted);
    },

    async listQueued(limit) {
      return (await db.all<MysqlRow>(
        `SELECT ${HOSTED_COLUMNS} FROM ke_hosted_instances WHERE desired = 'running' AND assigned_agent IS NULL ORDER BY created_at, instance_id LIMIT ?`,
        [limit],
      )).map(readHosted);
    },

    async listRunningUserIds(limit) {
      return (await db.all<MysqlRow>(
        "SELECT DISTINCT user_id FROM ke_hosted_instances WHERE desired = 'running' ORDER BY user_id LIMIT ?",
        [limit],
      )).map((row) => asNumber(row.user_id));
    },

    async deleteHosted(instanceId) {
      await db.run('DELETE FROM ke_hosted_credentials WHERE id = (SELECT credential_id FROM ke_hosted_instances WHERE instance_id = ?)', [instanceId]);
    },

    async markRunning(instanceId, now) {
      const hosted = await db.first<MysqlRow>('SELECT nid, aid, cid FROM ke_hosted_instances WHERE instance_id = ?', [instanceId]);
      if (hosted === null) return false;
      try {
        const result = await db.run(
          "UPDATE ke_hosted_instances SET desired = 'running', phase = 'queued', active_char_key = ?, stop_reason = NULL, retry_at = NULL, assigned_agent = NULL, updated_at = ? WHERE instance_id = ? AND desired = 'stopped' AND assigned_agent IS NULL",
          [activeCharKey({ nid: asNumber(hosted.nid), aid: asNumber(hosted.aid), cid: asNumber(hosted.cid) }), now, instanceId],
        );
        return result.affectedRows === 1;
      } catch (error) {
        if (error instanceof MysqlDatabaseError && error.errno === ER_DUP_ENTRY) return false;
        throw error;
      }
    },

    async markStopped(instanceId, reason, now) {
      await db.run(
        "UPDATE ke_hosted_instances SET desired = 'stopped', active_char_key = NULL, phase = CASE WHEN assigned_agent IS NULL THEN 'stopped' ELSE 'stopping' END, stop_reason = ?, retry_at = NULL, updated_at = ? WHERE instance_id = ?",
        [reason, now, instanceId],
      );
      await db.run('UPDATE ke_hosted_tokens SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL', [now, instanceId]);
    },

    async requestConfigSync(instanceId, now) {
      const result = await db.run(
        "UPDATE ke_hosted_instances SET config_sync_seq = config_sync_seq + 1, updated_at = ? WHERE instance_id = ? AND desired = 'running' AND assigned_agent IS NOT NULL",
        [now, instanceId],
      );
      return result.affectedRows === 1;
    },

    async assign(instanceId, agentId, now) {
      const result = await db.run(
        "UPDATE ke_hosted_instances SET assigned_agent = ?, epoch = epoch + 1, launch_seq = 0, phase = 'assigned', retry_at = NULL, migrating_since = NULL, updated_at = ? WHERE instance_id = ? AND assigned_agent IS NULL AND desired = 'running'",
        [agentId, now, instanceId],
      );
      return result.affectedRows === 1;
    },

    async release(instanceId, toQueue, reason, now) {
      const row = await db.first<MysqlRow>('SELECT assigned_agent FROM ke_hosted_instances WHERE instance_id = ?', [instanceId]);
      const previous = row === null ? null : asNullableString(row.assigned_agent);
      await db.run(
        "UPDATE ke_hosted_instances SET assigned_agent = NULL, phase = ?, retry_at = NULL, migrating_since = NULL, stop_reason = COALESCE(?, stop_reason), updated_at = ? WHERE instance_id = ?",
        [toQueue ? 'queued' : 'stopped', reason, now, instanceId],
      );
      await db.run('UPDATE ke_hosted_tokens SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL', [now, instanceId]);
      return previous;
    },

    async bumpLaunchSeq(instanceId, now) {
      await db.run('UPDATE ke_hosted_instances SET launch_seq = launch_seq + 1, updated_at = ? WHERE instance_id = ?', [now, instanceId]);
      const row = await db.first<MysqlRow>('SELECT launch_seq FROM ke_hosted_instances WHERE instance_id = ?', [instanceId]);
      return asNumber(row?.launch_seq ?? 0);
    },

    async applyReport(instanceId, epoch, phase, retryAt, now) {
      const result = await db.run(
        'UPDATE ke_hosted_instances SET phase = ?, retry_at = ?, last_report_at = ?, updated_at = ? WHERE instance_id = ? AND epoch = ? AND assigned_agent IS NOT NULL',
        [phase, retryAt, now, now, instanceId, epoch],
      );
      return result.affectedRows === 1;
    },

    async markMigrating(instanceId, now) {
      await db.run("UPDATE ke_hosted_instances SET phase = 'migrating', migrating_since = ?, updated_at = ? WHERE instance_id = ?", [now, now, instanceId]);
    },

    async revokeTokens(instanceId, now) {
      await db.run('UPDATE ke_hosted_tokens SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL', [now, instanceId]);
    },

    async insertToken(token) {
      await db.run(
        'INSERT INTO ke_hosted_tokens (token_digest, instance_id, user_id, epoch, launch_seq, credential_version, auth_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [token.digest, token.instanceId, token.userId, token.epoch, token.launchSeq, token.credentialVersion, token.authVersion, token.now, token.expiresAt],
      );
    },

    async readStatus(instanceId) {
      const row = await db.first<MysqlRow>('SELECT status_json, status_at FROM ke_instance_status WHERE instance_id = ?', [instanceId]);
      return row === null ? null : { statusJson: String(row.status_json), statusAt: asNumber(row.status_at) };
    },

    async lastHealthEvidence() {
      const row = await db.first<MysqlRow>('SELECT MAX(last_heartbeat_at) AS latest FROM ke_instances WHERE last_heartbeat_at IS NOT NULL', []);
      return asNullableNumber(row?.latest);
    },
  };
}

export function createHostedRepository(database: MysqlDatabase): HostedRepository {
  return {
    transaction: (work) => database.transaction((db) => work(hostedTxFor(db))),

    async findAgent(agentId) {
      const rows = await database.all<MysqlRow>(`SELECT ${AGENT_COLUMNS} FROM ke_agents WHERE agent_id = ?`, [agentId]);
      return rows.length > 0 ? readAgent(rows[0]!) : null;
    },

    async readHostedBearer(digest, now) {
      const row = await database.first<MysqlRow>(
        `SELECT t.id, t.user_id, t.instance_id, t.epoch, t.launch_seq
         FROM ke_hosted_tokens AS t
         INNER JOIN auth_users AS u ON u.id = t.user_id
         WHERE t.token_digest = ?
           AND t.revoked_at IS NULL
           AND t.expires_at > ?
           AND t.credential_version = u.credential_version
           AND t.auth_version = u.auth_version
           AND u.status <> 'DISABLED'
           AND (u.status <> 'ACTIVE' OR u.email_verified_at IS NOT NULL)
         LIMIT 1`,
        [digest, now],
      );
      return row === null ? null : {
        tokenId: asNumber(row.id), userId: asNumber(row.user_id), instanceId: String(row.instance_id),
        epoch: asNumber(row.epoch), launchSeq: asNumber(row.launch_seq),
      };
    },

    async cleanup(now) {
      await database.run('DELETE FROM ke_agent_nonces WHERE seen_at < ?', [now - 10 * 60 * 1000]);
      await database.run('DELETE FROM ke_hosted_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [now - 24 * 60 * 60 * 1000, now - 24 * 60 * 60 * 1000]);
    },
  };
}
