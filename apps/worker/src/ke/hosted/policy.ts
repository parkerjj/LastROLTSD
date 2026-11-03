/**
 * 托管（离线挂机）的纯策略函数：不碰数据库，便于逐条验证 docs/linux-hosting-design.md 第 6A 节的不变量。
 */

/** 实例额度流水按来源拆分后的求和。 */
export interface HostingEntitlement {
  /** 当前总额度（含免费 1 个），已钳到 0。 */
  slots: number;
  /** 非 signup 来源的有效 slots 之和：买了或被赠送的额外额度。 */
  extraSlots: number;
  /** 是否拥有核心模块。 */
  hasCore: boolean;
}

export const HOSTING_SIGNUP_SOURCE = 'signup';

/** I1：托管资格全有或全无——任何额外额度（含管理员赠送）≥ 1 才有资格；被扣减到 0 则无资格。 */
export function hostingEligible(entitlement: HostingEntitlement): boolean {
  return entitlement.hasCore && entitlement.extraSlots >= 1;
}

/** 托管记录数/运行数上限：有资格时等于总额度（含免费那一个），无资格为 0。 */
export function hostedCap(entitlement: HostingEntitlement): number {
  return hostingEligible(entitlement) ? Math.max(0, entitlement.slots) : 0;
}

export interface PlanInstance {
  instanceId: string;
  hosted: boolean;
  /** 首次进入 ACTIVE 的时间；幂等续期与同一行的托管重登不改变它。 */
  startedAt: number;
}

export type ConvergenceAction = 'stop_no_entitlement' | 'stop_over_cap' | 'kick_quota_shrunk';

export interface ConvergenceVerdict {
  instanceId: string;
  action: ConvergenceAction;
}

function byAge(a: PlanInstance, b: PlanInstance): number {
  return a.startedAt - b.startedAt || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0);
}

/**
 * I6：到期/缩水收敛。先算资格，再算额度，避免“托管因失去资格被停、非托管同时被超额收敛误杀”。
 * ① 无资格：所有托管实例停止，一个都不保留；
 * ② 有资格但托管数超过新额度：按 startedAt 升序保留前 N 个；
 * ③ 在剩余实例里若仍超过额度：同样按 startedAt 升序保留前 N 个，其余在下一次 heartbeat 被踢（quota_shrunk）。
 * 并列时按 instanceId 字典序，结果是确定的、不会来回踢。
 */
export function planConvergence(input: {
  eligible: boolean;
  slots: number;
  instances: readonly PlanInstance[];
}): ConvergenceVerdict[] {
  const verdicts: ConvergenceVerdict[] = [];
  const sorted = [...input.instances].sort(byAge);
  const slots = Math.max(0, input.slots);
  let remaining: PlanInstance[];
  if (!input.eligible) {
    for (const instance of sorted) {
      if (instance.hosted) verdicts.push({ instanceId: instance.instanceId, action: 'stop_no_entitlement' });
    }
    remaining = sorted.filter((instance) => !instance.hosted);
  } else {
    let hostedKept = 0;
    remaining = [];
    for (const instance of sorted) {
      if (!instance.hosted) {
        remaining.push(instance);
      } else if (hostedKept < slots) {
        hostedKept += 1;
        remaining.push(instance);
      } else {
        verdicts.push({ instanceId: instance.instanceId, action: 'stop_over_cap' });
      }
    }
    remaining.sort(byAge);
  }
  for (const instance of remaining.slice(slots)) {
    verdicts.push({ instanceId: instance.instanceId, action: 'kick_quota_shrunk' });
  }
  return verdicts;
}

export interface SchedulableAgent {
  agentId: string;
  status: string;
  accepting: boolean;
  reserved: number;
  maxInstances: number;
  memAvailableMb: number | null;
  lastSeen: number | null;
  rejectUntil: number | null;
}

/** 单个实例所需内存预算（MB）；agent 上报的可用内存低于它就不接新实例。 */
export const HOSTED_INSTANCE_MEM_MB = 60;

/** 调度候选：在线、接受新实例、有空位、内存够；空位多者优先，其次可用内存多，最后按 id 固定顺序。 */
export function rankAgents(agents: readonly SchedulableAgent[], now: number, leaseMs: number): SchedulableAgent[] {
  return agents
    .filter((agent) =>
      agent.status === 'online'
      && agent.accepting
      && agent.lastSeen !== null && now - agent.lastSeen <= leaseMs
      && agent.reserved < agent.maxInstances
      && (agent.rejectUntil === null || agent.rejectUntil <= now)
      && (agent.memAvailableMb === null || agent.memAvailableMb >= HOSTED_INSTANCE_MEM_MB))
    .sort((a, b) =>
      (b.maxInstances - b.reserved) - (a.maxInstances - a.reserved)
      || (b.memAvailableMb ?? 0) - (a.memAvailableMb ?? 0)
      || (a.agentId < b.agentId ? -1 : 1));
}

export const AGENT_LEASE_MS = 30 * 60 * 1000;
/** 判故障前的余量：吸收请求往返与优雅停止耗时（agent 先自我围栏，LTSD 后改派）。 */
export const AGENT_FAILOVER_MARGIN_MS = 3 * 60 * 1000;
/** “Worker 正常”的证据窗口：此窗口内有其他 agent 续租或任一实例心跳，才允许判某个 agent 故障。 */
export const FLEET_HEALTH_WINDOW_MS = 2 * 60 * 1000;

export interface FailoverAgent {
  agentId: string;
  status: string;
  lastSeen: number | null;
}

export interface FailoverDecision {
  expired: string[];
  /** 非空表示熔断冻结了故障转移及原因。 */
  frozen: 'none' | 'no_health_evidence' | 'majority_expired';
}

/**
 * I11/6A：Cron 判 agent 故障，带熔断。LTSD 整体故障或坏发布会让所有 agent 同时过期；
 * 此时不能全量改派，需满足：Worker 近期成功处理过“其他”agent 的租约或任一实例心跳，且过期占比小于 50%。
 */
export function decideFailover(
  agents: readonly FailoverAgent[],
  now: number,
  lastHealthEvidenceAt: number | null,
): FailoverDecision {
  const online = agents.filter((agent) => agent.status === 'online');
  const expired = online.filter(
    (agent) => agent.lastSeen === null || now - agent.lastSeen > AGENT_LEASE_MS + AGENT_FAILOVER_MARGIN_MS,
  );
  if (expired.length === 0) return { expired: [], frozen: 'none' };
  // 健康证据：Worker 最近确实在处理请求（其他 agent 的租约、或实例心跳）。
  const alive = online.filter((agent) => !expired.includes(agent));
  const aliveRecently = alive.some((agent) => agent.lastSeen !== null && now - agent.lastSeen <= FLEET_HEALTH_WINDOW_MS);
  const heartbeatRecently = lastHealthEvidenceAt !== null && now - lastHealthEvidenceAt <= FLEET_HEALTH_WINDOW_MS;
  if (!aliveRecently && !heartbeatRecently) return { expired: [], frozen: 'no_health_evidence' };
  if (online.length >= 2 && expired.length * 2 >= online.length) return { expired: [], frozen: 'majority_expired' };
  return { expired: expired.map((agent) => agent.agentId), frozen: 'none' };
}

/** 托管 license 到期封顶：min(now + 租约, 资格到期时间)；无法确定资格到期时间时取租约。 */
export function cappedLicenseExpiry(nowMs: number, leaseMs: number, entitlementExpiresAtMs: number | null): number {
  const natural = nowMs + leaseMs;
  return entitlementExpiresAtMs === null ? natural : Math.min(natural, entitlementExpiresAtMs);
}
