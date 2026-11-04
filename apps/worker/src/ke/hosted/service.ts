/**
 * 托管（离线挂机）业务逻辑：面板操作、agent 租约/launch/上报、Cron 故障转移与资格扫描。
 * 设计与不变量见 KoreEngine 仓库 docs/linux-hosting-design.md（第 5、6、6A、7、10、11 节）。
 *
 * 锁顺序约定（避免死锁）：先 `lockUser`，再 `lockAgent`；Cron 的故障转移把“标记 agent down”与
 * “逐个释放实例”拆成不同事务，后者逐个先锁用户。
 */
import { createOpaqueToken, digestToken } from '../../auth/crypto';
import { wrapChunkKey } from '../crypto';
import type { KeConfig } from '../config';
import { KE_LIVENESS_WINDOW_MS, KE_LICENSE_LEASE_MS, KE_BINDING_EXCLUSIVE_MS, KE_TOKEN_PREFIX, KeFailure, type WrappedKeyBundle } from '../types';
import { decryptGamePassword, encryptGamePassword } from './credential-crypto';
import {
  AGENT_LEASE_MS,
  cappedLicenseExpiry,
  decideFailover,
  hostedCap,
  hostingEligible,
  planConvergence,
  rankAgents,
} from './policy';
import type { AgentRow, HostedListItem, HostedRepository, HostedRow, HostedTx } from './repository';
import {
  AgentSignatureError,
  parseSignedHeaders,
  verifyAgentSignature,
} from './signature';

export const HOSTED_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CREDENTIALS_PER_USER = 20;
export const HOSTED_LAUNCH_COMMANDS = ['ai auto'] as const;
export const QUEUE_SCAN_LIMIT = 200;
export const ENTITLEMENT_SWEEP_LIMIT = 500;

export interface CreateHostedInput {
  nid: number;
  aid: number;
  cid: number;
  charName: string;
  gameAccount: string;
  gamePassword: string;
}

export interface LeaseInput {
  version: string | null;
  packageId: string | null;
  memAvailableMb: number | null;
  /** agent 重启后声明“本机没有遗留实例”，允许从 down 恢复为 online。 */
  cleanSlate: boolean;
  instances: { id: string; epoch: number; phase: string; retryAt: number | null }[];
}

export interface LeaseResponse {
  fenced: boolean;
  server_time_ms: number;
  lease_ms: number;
  max_instances: number;
  instances: { id: string; epoch: number; desired: 'running' | 'stopped'; phase: string; char_name: string | null }[];
}

export interface LaunchPackage {
  instance_id: string;
  epoch: number;
  launch_seq: number;
  user_id: string;
  ltsd_token: string;
  ltsd_token_expires_at: number;
  game_account: string;
  game_password: string;
  nid: number;
  aid: number;
  cid: number;
  char_name: string;
  profile: string;
  commands: string[];
}

export interface ReportInput {
  epoch: number;
  phase: 'starting' | 'running' | 'backoff' | 'stopping' | 'stopped' | 'error';
  retryAt: number | null;
}

export interface HostedItemView {
  id: string;
  char_name: string;
  nid: number;
  aid: number;
  cid: number;
  desired: string;
  phase: string;
  stop_reason: string | null;
  retry_at: number | null;
  agent: string | null;
  status: unknown;
  status_at: number | null;
}

export interface TickSummary {
  frozen: string;
  failedOver: string[];
  scheduled: number;
  enforced: number;
}

export interface HostedService {
  eligibility(userId: string): Promise<{ eligible: boolean; slots: number; has_hosting: boolean; hosting_expires_at: number | null; cap: number; hosted_count: number }>;
  list(userId: string): Promise<HostedItemView[]>;
  create(userId: string, input: CreateHostedInput): Promise<{ id: string }>;
  remove(userId: string, instanceId: string): Promise<void>;
  start(userId: string, instanceId: string): Promise<{ notify: string[] }>;
  stop(userId: string, instanceId: string): Promise<{ notify: string[] }>;

  authenticateAgent(input: { headers: Headers; method: string; pathAndQuery: string; body: Uint8Array }): Promise<AgentRow>;
  lease(agent: AgentRow, input: LeaseInput): Promise<LeaseResponse>;
  launch(agent: AgentRow, instanceId: string, epoch: number): Promise<LaunchPackage>;
  refreshToken(agent: AgentRow, instanceId: string, epoch: number): Promise<{ ltsd_token: string; ltsd_token_expires_at: number }>;
  report(agent: AgentRow, instanceId: string, input: ReportInput): Promise<{ notify: string[] }>;
  moduleKeys(agent: AgentRow, input: { modules: readonly string[]; kePublicKey: Uint8Array }): Promise<{ key_bundles: Record<string, WrappedKeyBundle>; key_versions: Record<string, number> }>;

  tick(): Promise<TickSummary>;
}

type Denied = { denied: KeFailure };

function isDenied(value: unknown): value is Denied {
  return typeof value === 'object' && value !== null && 'denied' in value;
}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { errno?: unknown }).errno === 1062;
}

function notFound(): KeFailure {
  return new KeFailure('KE_INSTANCE_NOT_FOUND', 404, '托管实例不存在');
}

function unavailable(): KeFailure {
  return new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
}

function newInstanceId(): string {
  return crypto.randomUUID();
}

function toSchedulable(agent: AgentRow) {
  return agent;
}

export function createHostedService(
  repository: HostedRepository,
  config: KeConfig,
  now: () => number = () => Date.now(),
  log: (event: string, detail: Record<string, unknown>) => void = () => {},
): HostedService {
  async function schedule(tx: HostedTx, row: HostedRow, timestamp: number): Promise<string | null> {
    const agents = await tx.listAgents();
    for (const candidate of rankAgents(agents.map(toSchedulable), timestamp, AGENT_LEASE_MS)) {
      if (!await tx.reserveAgentSlot(candidate.agentId)) continue;
      if (await tx.assign(row.instanceId, candidate.agentId, timestamp)) return candidate.agentId;
      await tx.recomputeReserved(candidate.agentId, timestamp);
      return null;
    }
    return null;
  }

  /** I1/I6：一个用户的托管资格与上限；失去资格或超出上限的托管实例立即停止（真正断开由 agent 完成）。 */
  /** 释放某台 agent 名下的实例：逐个先锁用户（与其他路径同一加锁顺序），再整体重算它的预留计数。 */
  async function releaseInstances(
    agentId: string,
    instances: ReadonlyArray<{ instanceId: string; userId: number }>,
    timestamp: number,
  ): Promise<void> {
    for (const instance of instances) {
      await repository.transaction(async (tx) => {
        await tx.ke.lockUser(instance.userId);
        const current = await tx.findHosted(instance.instanceId);
        if (current === null || current.assignedAgent !== agentId) return;
        await tx.release(instance.instanceId, current.desired === 'running', current.desired === 'running' ? 'agent-down' : null, timestamp);
      });
    }
    await repository.transaction((tx) => tx.recomputeReserved(agentId, timestamp));
  }

  async function enforceUser(userId: number): Promise<number> {
    return repository.transaction(async (tx) => {
      const timestamp = now();
      await tx.ke.lockUser(userId);
      const hosting = await tx.ke.readHostingEntitlement(userId, timestamp);
      const running = (await tx.listHostedByUser(userId)).filter((row) => row.desired === 'running');
      if (running.length === 0) return 0;
      const verdicts = planConvergence({
        eligible: hostingEligible(hosting),
        slots: hosting.slots,
        instances: running.map((row) => ({ instanceId: row.instanceId, hosted: true, startedAt: row.createdAt })),
      });
      let stopped = 0;
      for (const verdict of verdicts) {
        if (verdict.action === 'kick_quota_shrunk') continue;
        await tx.markStopped(verdict.instanceId, verdict.action === 'stop_over_cap' ? 'over-hosting-cap' : 'no-hosting-entitlement', timestamp);
        stopped += 1;
      }
      return stopped;
    });
  }

  function assertOnline(agent: AgentRow): void {
    if (agent.status === 'down') throw new KeFailure('KE_AGENT_FENCED', 409, 'agent 已被围栏，请清场后重新注册');
  }

  async function issueToken(tx: HostedTx, row: HostedRow, userId: number, launchSeq: number, timestamp: number, capMs: number | null): Promise<{ token: string; expiresAt: number }> {
    const versions = await tx.readUserVersions(userId);
    if (versions === null) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
    const opaque = createOpaqueToken();
    const expiresAt = cappedLicenseExpiry(timestamp, HOSTED_TOKEN_TTL_MS, capMs);
    await tx.insertToken({
      digest: await digestToken(opaque),
      instanceId: row.instanceId,
      userId,
      epoch: row.epoch,
      launchSeq,
      credentialVersion: versions.credentialVersion,
      authVersion: versions.authVersion,
      now: timestamp,
      expiresAt,
    });
    return { token: `${KE_TOKEN_PREFIX}${opaque}`, expiresAt };
  }

  return {
    async eligibility(userId) {
      const owner = Number(userId);
      return repository.transaction(async (tx) => {
        const hosting = await tx.ke.readHostingEntitlement(owner, now());
        return {
          eligible: hostingEligible(hosting),
          slots: hosting.slots,
          has_hosting: hosting.hasHosting,
          hosting_expires_at: hosting.hostingExpiresAt,
          cap: hostedCap(hosting),
          hosted_count: await tx.countHostedRecords(owner),
        };
      });
    },

    async list(userId) {
      const owner = Number(userId);
      const items: HostedListItem[] = await repository.transaction((tx) => tx.listHostedByUser(owner));
      return items.map((item) => {
        let status: unknown = null;
        if (item.statusJson !== null) {
          try {
            status = JSON.parse(item.statusJson);
          } catch {
            status = null;
          }
        }
        return {
          id: item.instanceId, char_name: item.charName, nid: item.nid, aid: item.aid, cid: item.cid,
          desired: item.desired, phase: item.phase, stop_reason: item.stopReason, retry_at: item.retryAt,
          agent: item.agentName, status, status_at: item.statusAt,
        };
      });
    },

    async create(userId, input) {
      if (config.hostedCredentialKey === null) throw unavailable();
      const owner = Number(userId);
      const timestamp = now();
      const instanceId = newInstanceId();
      try {
        await repository.transaction(async (tx) => {
          await tx.ke.lockUser(owner);
          const hosting = await tx.ke.readHostingEntitlement(owner, timestamp);
          if (!hostingEligible(hosting)) throw new KeFailure('KE_HOSTING_ENTITLEMENT_REQUIRED', 403, '账号没有离线挂机资格');
          if (await tx.countCredentials(owner) >= MAX_CREDENTIALS_PER_USER) {
            throw new KeFailure('KE_HOSTED_LIMIT', 409, '托管角色数量已达上限');
          }
          // 已被其他账号在 30 天内绑定的角色不能登记；返回通用错误，不泄露是谁在占用。
          const existing = await tx.ke.findCharacter(input.aid, input.cid, input.nid);
          if (existing !== null && existing.user_id !== null && existing.user_id !== owner
            && existing.bound_at !== null && timestamp - existing.bound_at < KE_BINDING_EXCLUSIVE_MS) {
            throw new KeFailure('KE_HOSTED_CHARACTER_UNAVAILABLE', 409, '该角色暂时无法托管');
          }
          const binding = { userId: owner, nid: input.nid, aid: input.aid, cid: input.cid, keyVersion: config.hostedCredentialKeyVersion };
          const enc = await encryptGamePassword(config.hostedCredentialKey!, binding, input.gamePassword);
          const credentialId = await tx.insertCredential({
            userId: owner, nid: input.nid, aid: input.aid, cid: input.cid, charName: input.charName,
            gameAccount: input.gameAccount, gamePasswordEnc: enc, keyVersion: config.hostedCredentialKeyVersion,
          }, timestamp);
          await tx.insertHosted({ instanceId, userId: owner, credentialId, nid: input.nid, aid: input.aid, cid: input.cid }, timestamp);
        });
      } catch (error) {
        if (isDuplicate(error)) throw new KeFailure('KE_HOSTED_EXISTS', 409, '该角色已经登记过托管');
        throw error;
      }
      return { id: instanceId };
    },

    async remove(userId, instanceId) {
      const owner = Number(userId);
      await repository.transaction(async (tx) => {
        await tx.ke.lockUser(owner);
        const row = await tx.findHosted(instanceId);
        if (row === null || row.userId !== owner) throw notFound();
        if (row.desired !== 'stopped' || row.assignedAgent !== null) {
          throw new KeFailure('KE_HOSTED_NOT_STOPPED', 409, '请先停止托管实例');
        }
        await tx.deleteHosted(instanceId);
      });
    },

    async start(userId, instanceId) {
      if (config.hostedCredentialKey === null) throw unavailable();
      const owner = Number(userId);
      const timestamp = now();
      const outcome = await repository.transaction(async (tx): Promise<Denied | { notify: string[] }> => {
        await tx.ke.lockUser(owner);
        const row = await tx.findHosted(instanceId);
        if (row === null || row.userId !== owner) throw notFound();
        const hosting = await tx.ke.readHostingEntitlement(owner, timestamp);
        if (!hostingEligible(hosting)) {
          // 无资格的用户即使已有记录也不能启动；顺带确保 desired=stopped。
          if (row.desired === 'running') await tx.markStopped(instanceId, 'no-hosting-entitlement', timestamp);
          return { denied: new KeFailure('KE_HOSTING_ENTITLEMENT_REQUIRED', 403, '账号没有离线挂机资格') };
        }
        if (row.desired === 'running') return { notify: [] }; // 幂等
        if (await tx.countHostedRecords(owner) >= hostedCap(hosting)) {
          throw new KeFailure('KE_HOSTED_CAP_REACHED', 409, '运行中的托管实例已达上限');
        }
        if (row.desired === 'stopped' && row.assignedAgent !== null) {
          // 上一次停止还没收到 agent 的回执：稍后再试，而不是误报“角色被占用”。
          throw new KeFailure('KE_HOSTED_STOPPING', 409, '托管实例正在停止，请稍后再启动');
        }
        if (!await tx.markRunning(instanceId, timestamp)) {
          throw new KeFailure('KE_HOSTED_CHARACTER_BUSY', 409, '该角色已有运行中的托管实例');
        }
        const agentId = await schedule(tx, { ...row, desired: 'running', assignedAgent: null }, timestamp);
        return { notify: agentId === null ? [] : [agentId] };
      });
      if (isDenied(outcome)) throw outcome.denied;
      return outcome;
    },

    async stop(userId, instanceId) {
      const owner = Number(userId);
      const timestamp = now();
      return repository.transaction(async (tx) => {
        await tx.ke.lockUser(owner);
        const row = await tx.findHosted(instanceId);
        if (row === null || row.userId !== owner) throw notFound();
        if (row.desired === 'stopped' && row.assignedAgent === null) return { notify: [] };
        await tx.markStopped(instanceId, 'user', timestamp);
        return { notify: row.assignedAgent === null ? [] : [row.assignedAgent] };
      });
    },

    async authenticateAgent({ headers, method, pathAndQuery, body }) {
      const timestamp = now();
      let signed: ReturnType<typeof parseSignedHeaders>;
      try {
        signed = parseSignedHeaders(headers, timestamp);
      } catch (error) {
        if (error instanceof AgentSignatureError) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
        throw error;
      }
      const agent = await repository.findAgent(signed.agentId);
      if (agent === null) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
      try {
        await verifyAgentSignature(agent.pubkey, signed.signature, method, pathAndQuery, signed.ts, signed.nonce, body);
      } catch (error) {
        if (error instanceof AgentSignatureError) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
        throw error;
      }
      // 防重放：签名正确之后才占用 nonce，避免未认证请求污染 nonce 表。
      const fresh = await repository.transaction((tx) => tx.insertNonce(agent.agentId, signed.nonce, timestamp));
      if (!fresh) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
      return agent;
    },

    async lease(agent, input) {
      const timestamp = now();
      const first = await repository.transaction(async (tx): Promise<{ fenced: boolean; rows: HostedRow[]; maxInstances: number }> => {
        const locked = await tx.lockAgent(agent.agentId);
        if (locked === null) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
        if (locked.status === 'down') {
          // 被围栏的 agent 必须先清场：只有声明“本机没有遗留实例”才能重新上线，否则旧进程仍可能在线。
          if (!input.cleanSlate || input.instances.length > 0) return { fenced: true, rows: [], maxInstances: locked.maxInstances };
          await tx.patchAgent(agent.agentId, { status: 'online' }, timestamp);
        }
        await tx.patchAgent(agent.agentId, {
          lastSeen: timestamp,
          memAvailableMb: input.memAvailableMb,
          version: input.version,
          packageId: input.packageId,
        }, timestamp);
        for (const reported of input.instances) {
          const row = await tx.findHosted(reported.id);
          if (row !== null && row.assignedAgent === agent.agentId && row.epoch === reported.epoch
            && ['starting', 'running', 'backoff', 'stopping'].includes(reported.phase)) {
            await tx.applyReport(reported.id, reported.epoch, reported.phase, reported.retryAt, timestamp);
          }
        }
        await tx.recomputeReserved(agent.agentId, timestamp);
        return { fenced: false, rows: await tx.listHostedByAgent(agent.agentId), maxInstances: locked.maxInstances };
      });
      if (first.fenced) {
        return { fenced: true, server_time_ms: timestamp, lease_ms: AGENT_LEASE_MS, max_instances: first.maxInstances, instances: [] };
      }
      // 资格/上限在每次租约对账时重新判定（不缓存）：失去资格的实例在这一轮就被标记为 stopped。
      const users = [...new Set(first.rows.filter((row) => row.desired === 'running').map((row) => row.userId))];
      for (const userId of users) await enforceUser(userId);
      const rows = await repository.transaction((tx) => tx.listHostedByAgent(agent.agentId));
      return {
        fenced: false,
        server_time_ms: timestamp,
        lease_ms: AGENT_LEASE_MS,
        max_instances: first.maxInstances,
        instances: rows.map((row) => ({
          id: row.instanceId, epoch: row.epoch, desired: row.desired, phase: row.phase, char_name: null,
        })),
      };
    },

    async launch(agent, instanceId, epoch) {
      assertOnline(agent);
      if (config.hostedCredentialKey === null) throw unavailable();
      const timestamp = now();
      const peek = await repository.transaction((tx) => tx.findHosted(instanceId));
      if (peek === null || peek.assignedAgent !== agent.agentId) throw notFound();
      const outcome = await repository.transaction(async (tx): Promise<Denied | { pkg: LaunchPackage }> => {
        await tx.ke.lockUser(peek.userId);
        const row = await tx.findHosted(instanceId);
        if (row === null || row.assignedAgent !== agent.agentId) throw notFound();
        // 幂等只豁免“预占名额”这一步：以下校验每次重放都重新做（6A 的 I9）。
        if (row.epoch !== epoch) throw new KeFailure('KE_EPOCH_STALE', 409, '托管实例已被改派');
        if (row.desired !== 'running') throw new KeFailure('KE_INSTANCE_NOT_ACTIVE', 409, '托管实例未处于运行状态');
        const hosting = await tx.ke.readHostingEntitlement(row.userId, timestamp);
        if (!hostingEligible(hosting)) {
          await tx.markStopped(instanceId, 'no-hosting-entitlement', timestamp);
          return { denied: new KeFailure('KE_HOSTING_ENTITLEMENT_REQUIRED', 403, '账号没有离线挂机资格') };
        }
        const credential = await tx.findCredential(row.credentialId);
        if (credential === null || credential.userId !== row.userId) throw notFound();
        const threshold = timestamp - KE_LIVENESS_WINDOW_MS;
        // 30 天独占：已被其他账号绑定的角色不能登录游戏（避免登录之后才被 bind 拒绝）。
        const character = await tx.ke.findCharacter(row.aid, row.cid, row.nid);
        if (character !== null && character.user_id !== null && character.user_id !== row.userId
          && character.bound_at !== null && timestamp - character.bound_at < KE_BINDING_EXCLUSIVE_MS) {
          throw new KeFailure('KE_CHARACTER_BOUND', 409, '该角色已被其他账号绑定');
        }
        // I15：同角色存在存活的非托管会话就等待，不顶用户。
        const same = await tx.ke.listSameCharacter(row.userId, row.aid, row.cid, row.nid, instanceId);
        if (same.some((item) => !item.hosted && (item.state === 'ACTIVE' ? (item.last_heartbeat_at ?? 0) > threshold : item.updated_at > threshold))) {
          throw new KeFailure('KE_CHARACTER_IN_USE', 409, '该角色正在被其他会话使用');
        }
        // I3：先预占额度，再发凭据。预占 = 把该实例置 ACTIVE（心跳时间 now），按现有规则立即计入额度。
        let instance = await tx.ke.findInstance(instanceId);
        if (instance === null) {
          await tx.ke.insertInstance(instanceId, row.userId, {
            aid: row.aid, cid: row.cid, nid: row.nid, char_name: credential.charName,
            base_level: null, job_level: null, job_id: null, map_name: null,
          }, null, null, null, timestamp);
          instance = await tx.ke.findInstance(instanceId);
        }
        if (instance === null) throw unavailable();
        const holds = instance.state === 'ACTIVE' && instance.mode === 'auto' && (instance.last_heartbeat_at ?? 0) > threshold;
        if (!holds && await tx.ke.countActive(row.userId, instanceId, threshold) >= hosting.slots) {
          const active = await tx.ke.listActive(row.userId, threshold);
          throw new KeFailure('KE_QUOTA_EXCEEDED', 409, '已达实例额度', { active_instances: active });
        }
        const licenseExpiresAt = cappedLicenseExpiry(timestamp, KE_LICENSE_LEASE_MS, hosting.hostingExpiresAt);
        await tx.ke.activateInstance(instanceId, 'auto', JSON.stringify(['core']), null, null, null, licenseExpiresAt, timestamp);
        const launchSeq = await tx.bumpLaunchSeq(instanceId, timestamp);
        await tx.revokeTokens(instanceId, timestamp);
        const { token, expiresAt } = await issueToken(tx, row, row.userId, launchSeq, timestamp, hosting.hostingExpiresAt);
        const password = await decryptGamePassword(config.hostedCredentialKey!, {
          userId: credential.userId, nid: credential.nid, aid: credential.aid, cid: credential.cid, keyVersion: credential.keyVersion,
        }, credential.gamePasswordEnc);
        return {
          pkg: {
            instance_id: instanceId, epoch: row.epoch, launch_seq: launchSeq, user_id: String(row.userId),
            ltsd_token: token, ltsd_token_expires_at: expiresAt,
            game_account: credential.gameAccount, game_password: password,
            nid: row.nid, aid: row.aid, cid: row.cid, char_name: credential.charName,
            profile: 'lastro-2x', commands: [...row.launchCommands],
          },
        };
      });
      if (isDenied(outcome)) throw outcome.denied;
      return outcome.pkg;
    },

    async refreshToken(agent, instanceId, epoch) {
      assertOnline(agent);
      const timestamp = now();
      const peek = await repository.transaction((tx) => tx.findHosted(instanceId));
      if (peek === null || peek.assignedAgent !== agent.agentId) throw notFound();
      const outcome = await repository.transaction(async (tx): Promise<Denied | { token: string; expiresAt: number }> => {
        await tx.ke.lockUser(peek.userId);
        const row = await tx.findHosted(instanceId);
        if (row === null || row.assignedAgent !== agent.agentId) throw notFound();
        if (row.epoch !== epoch) throw new KeFailure('KE_EPOCH_STALE', 409, '托管实例已被改派');
        if (row.desired !== 'running') throw new KeFailure('KE_INSTANCE_NOT_ACTIVE', 409, '托管实例未处于运行状态');
        const hosting = await tx.ke.readHostingEntitlement(row.userId, timestamp);
        if (!hostingEligible(hosting)) {
          await tx.markStopped(instanceId, 'no-hosting-entitlement', timestamp);
          return { denied: new KeFailure('KE_HOSTING_ENTITLEMENT_REQUIRED', 403, '账号没有离线挂机资格') };
        }
        // 刷新不吊销旧 token（子进程切换前仍可能在用），旧 token 自然过期；停止/改派时统一吊销。
        return issueToken(tx, row, row.userId, row.launchSeq, timestamp, hosting.hostingExpiresAt);
      });
      if (isDenied(outcome)) throw outcome.denied;
      return { ltsd_token: outcome.token, ltsd_token_expires_at: outcome.expiresAt };
    },

    async report(agent, instanceId, input) {
      const timestamp = now();
      const peek = await repository.transaction((tx) => tx.findHosted(instanceId));
      if (peek === null || peek.assignedAgent !== agent.agentId) throw new KeFailure('KE_EPOCH_STALE', 409, '托管实例已被改派');
      return repository.transaction(async (tx) => {
        await tx.ke.lockUser(peek.userId);
        const row = await tx.findHosted(instanceId);
        if (row === null || row.assignedAgent !== agent.agentId || row.epoch !== input.epoch) {
          throw new KeFailure('KE_EPOCH_STALE', 409, '托管实例已被改派');
        }
        const notify: string[] = [];
        if (input.phase === 'stopped' || input.phase === 'error') {
          // 进程已确认退出：它在 ke_instances 里预占的额度必须同时释放，否则用户停掉 A 再启动 B 要白等 10 分钟的存活窗口。
          // 停止回执到达时托管 token 已被吊销，进程自己没法再调 /stop，所以只能在这里收尾。
          const keRow = await tx.ke.findInstance(instanceId);
          if (keRow !== null && keRow.state === 'ACTIVE') await tx.ke.markStopped(instanceId, timestamp);
        }
        if (input.phase === 'stopped') {
          // 停止回执时按“当时的” desired 决定落点：用户可能在停止过程中又点了启动。
          const requeue = row.desired === 'running';
          await tx.release(instanceId, requeue, null, timestamp);
          await tx.recomputeReserved(agent.agentId, timestamp);
          if (requeue) {
            const assigned = await schedule(tx, { ...row, assignedAgent: null }, timestamp);
            if (assigned !== null) notify.push(assigned);
          }
        } else if (input.phase === 'error') {
          await tx.markStopped(instanceId, 'error', timestamp);
          await tx.release(instanceId, false, 'error', timestamp);
          await tx.recomputeReserved(agent.agentId, timestamp);
        } else {
          await tx.applyReport(instanceId, input.epoch, input.phase, input.retryAt, timestamp);
        }
        return { notify };
      });
    },

    async moduleKeys(agent, input) {
      assertOnline(agent);
      const requested = [...new Set(input.modules)];
      if (requested.length === 0 || requested.some((module) => !['core', 'network'].includes(module)) || input.kePublicKey.byteLength !== 32) {
        throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
      }
      const bundles: Record<string, WrappedKeyBundle> = {};
      const versions: Record<string, number> = {};
      // 以 agent_id 作为 HKDF 盐/AAD（现有协议里这个位置是 instance_id）；只发 core / network，不含 activity。
      if (requested.includes('core')) {
        if (config.coreKey === null) throw unavailable();
        bundles.core = await wrapChunkKey(config.coreKey, input.kePublicKey, agent.agentId, 'core');
        versions.core = Number(config.coreKeyVersion);
      }
      if (requested.includes('network')) {
        if (config.networkKey === null) throw unavailable();
        bundles.network = await wrapChunkKey(config.networkKey, input.kePublicKey, agent.agentId, 'network');
        versions.network = Number(config.networkKeyVersion);
      }
      return { key_bundles: bundles, key_versions: versions };
    },

    async tick() {
      const timestamp = now();
      const summary: TickSummary = { frozen: 'none', failedOver: [], scheduled: 0, enforced: 0 };
      const agents = await repository.transaction((tx) => tx.listAgents());
      const evidence = await repository.transaction((tx) => tx.lastHealthEvidence());
      const decision = decideFailover(
        agents.map((agent) => ({ agentId: agent.agentId, status: agent.status, lastSeen: agent.lastSeen })),
        timestamp,
        evidence,
      );
      summary.frozen = decision.frozen;
      if (decision.frozen !== 'none') log('hosted.failover_frozen', { reason: decision.frozen });
      for (const agentId of decision.expired) {
        // 事务 A：条件标记 down（Cron 可能重复/延迟执行，必须幂等）；返回需要释放的实例。
        const instances = await repository.transaction(async (tx) => {
          const locked = await tx.lockAgent(agentId);
          if (locked === null || locked.status !== 'online'
            || (locked.lastSeen !== null && timestamp - locked.lastSeen <= AGENT_LEASE_MS)) return null;
          await tx.patchAgent(agentId, { status: 'down' }, timestamp);
          return tx.listHostedByAgent(agentId);
        });
        if (instances === null) continue;
        summary.failedOver.push(agentId);
        // 事务 B：逐个先锁用户再释放；desired=running 的回到 queued，desired=stopped 的也要清掉归属。
        await releaseInstances(agentId, instances, timestamp);
        log('hosted.agent_failed_over', { agentId, instances: instances.length });
      }
      // 补偿：agent 已经被标记 down（上一轮的事务 B 中途失败/Worker 中断，或运维手动置 down），名下还挂着的实例继续释放。
      // 熔断期间不动：那说明现在的健康证据不足，不是该改派的时候。
      if (decision.frozen === 'none') {
        for (const agent of agents) {
          if (agent.status !== 'down' || decision.expired.includes(agent.agentId)) continue;
          const stranded = await repository.transaction((tx) => tx.listHostedByAgent(agent.agentId));
          if (stranded.length === 0) continue;
          await releaseInstances(agent.agentId, stranded, timestamp);
          summary.failedOver.push(agent.agentId);
          log('hosted.agent_failover_resumed', { agentId: agent.agentId, instances: stranded.length });
        }
      }
      // 资格/上限扫描：时间驱动的到期没有事件，租约对账、heartbeat、这里三处都要查。
      const users = await repository.transaction((tx) => tx.listRunningUserIds(ENTITLEMENT_SWEEP_LIMIT));
      for (const userId of users) summary.enforced += await enforceUser(userId);
      // 队列扫描：事件触发的调度可能丢失（Worker 在写库后、调度前崩溃），这里兜底。
      const queued = await repository.transaction((tx) => tx.listQueued(QUEUE_SCAN_LIMIT));
      for (const row of queued) {
        const assigned = await repository.transaction(async (tx) => {
          await tx.ke.lockUser(row.userId);
          const current = await tx.findHosted(row.instanceId);
          if (current === null || current.desired !== 'running' || current.assignedAgent !== null) return null;
          const hosting = await tx.ke.readHostingEntitlement(current.userId, timestamp);
          if (!hostingEligible(hosting)) {
            await tx.markStopped(current.instanceId, 'no-hosting-entitlement', timestamp);
            return null;
          }
          return schedule(tx, current, timestamp);
        });
        if (assigned !== null) summary.scheduled += 1;
      }
      await repository.cleanup(timestamp);
      return summary;
    },
  };
}
