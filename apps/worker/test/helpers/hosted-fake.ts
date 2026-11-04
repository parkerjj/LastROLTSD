import type { AgentRow, CredentialRow, HostedBearerRecord, HostedListItem, HostedRepository, HostedRow, HostedTx, NewHostedToken } from '../../src/ke/hosted/repository';
import { makeFakeRepository, type FakeRepository } from './ke-fake';

interface Token extends NewHostedToken {
  id: number;
  revokedAt: number | null;
}

export interface FakeHostedRepository extends HostedRepository {
  ke: FakeRepository;
  agents: Map<string, AgentRow>;
  hosted: Map<string, HostedRow>;
  credentials: Map<number, CredentialRow>;
  tokens: Token[];
  nonces: Set<string>;
  healthEvidence: { at: number | null };
}

/** 托管仓库的内存假实现：与 MySQL 实现遵循同样的条件更新语义（影响行数/唯一约束）。 */
export function makeFakeHostedRepository(): FakeHostedRepository {
  const ke = makeFakeRepository();
  const agents = new Map<string, AgentRow>();
  const hosted = new Map<string, HostedRow>();
  const credentials = new Map<number, CredentialRow>();
  const tokens: Token[] = [];
  const nonces = new Set<string>();
  const healthEvidence = { at: null as number | null };
  const activeKeys = new Map<string, string>();
  let nextCredential = 1;
  let nextToken = 1;

  const activeKey = (row: { nid: number; aid: number; cid: number }): string => `${row.nid}:${row.aid}:${row.cid}`;
  const clearKey = (instanceId: string): void => {
    for (const [key, owner] of activeKeys) if (owner === instanceId) activeKeys.delete(key);
  };

  const tx: HostedTx = {
    ke: ke.tx,
    async lockAgent(agentId) {
      return agents.get(agentId) ?? null;
    },
    async listAgents() {
      return [...agents.values()];
    },
    async patchAgent(agentId, patch) {
      const agent = agents.get(agentId);
      if (agent) Object.assign(agent, patch);
    },
    async recomputeReserved(agentId) {
      const count = [...hosted.values()].filter((row) => row.assignedAgent === agentId).length;
      const agent = agents.get(agentId);
      if (agent) agent.reserved = count;
      return count;
    },
    async reserveAgentSlot(agentId) {
      const agent = agents.get(agentId);
      if (!agent || agent.status !== 'online' || !agent.accepting || agent.reserved >= agent.maxInstances) return false;
      agent.reserved += 1;
      return true;
    },
    async insertNonce(agentId, nonce) {
      const key = `${agentId}:${nonce}`;
      if (nonces.has(key)) return false;
      nonces.add(key);
      return true;
    },
    async readUserVersions() {
      return { credentialVersion: 1, authVersion: 1 };
    },
    async countCredentials(userId) {
      return [...credentials.values()].filter((row) => row.userId === userId).length;
    },
    async countHostedRecords(userId) {
      return [...hosted.values()].filter((row) => row.userId === userId && (row.desired === 'running' || row.assignedAgent !== null)).length;
    },
    async insertCredential(row) {
      const duplicate = [...credentials.values()].some((item) => item.userId === row.userId && item.nid === row.nid && item.aid === row.aid && item.cid === row.cid);
      if (duplicate) throw Object.assign(new Error('duplicate'), { errno: 1062 });
      const id = nextCredential++;
      credentials.set(id, { id, ...row });
      return id;
    },
    async findCredential(id) {
      return credentials.get(id) ?? null;
    },
    async insertHosted(row, now) {
      hosted.set(row.instanceId, {
        instanceId: row.instanceId, userId: row.userId, credentialId: row.credentialId, nid: row.nid, aid: row.aid, cid: row.cid,
        desired: 'stopped', phase: 'stopped', assignedAgent: null, epoch: 0, launchSeq: 0, configSyncSeq: 0, stopReason: null, retryAt: null,
        launchCommands: ['ai auto'], lastReportAt: null, migratingSince: null, createdAt: now,
      });
    },
    async findHosted(instanceId) {
      const row = hosted.get(instanceId);
      return row ? { ...row } : null;
    },
    async listHostedByUser(userId): Promise<HostedListItem[]> {
      return [...hosted.values()].filter((row) => row.userId === userId).map((row) => ({
        ...row, charName: credentials.get(row.credentialId)?.charName ?? '', agentName: row.assignedAgent ? agents.get(row.assignedAgent)?.name ?? null : null,
        statusJson: ke.statuses.get(row.instanceId) ?? null, statusAt: null,
      }));
    },
    async listHostedByAgent(agentId) {
      return [...hosted.values()].filter((row) => row.assignedAgent === agentId).map((row) => ({ ...row }));
    },
    async listQueued(limit) {
      return [...hosted.values()].filter((row) => row.desired === 'running' && row.assignedAgent === null).slice(0, limit).map((row) => ({ ...row }));
    },
    async listRunningUserIds(limit) {
      return [...new Set([...hosted.values()].filter((row) => row.desired === 'running').map((row) => row.userId))].slice(0, limit);
    },
    async deleteHosted(instanceId) {
      const row = hosted.get(instanceId);
      if (row) credentials.delete(row.credentialId);
      hosted.delete(instanceId);
      clearKey(instanceId);
    },
    async markRunning(instanceId) {
      const row = hosted.get(instanceId);
      if (!row || row.desired !== 'stopped' || row.assignedAgent !== null) return false;
      const key = activeKey(row);
      if (activeKeys.has(key) && activeKeys.get(key) !== instanceId) return false;
      activeKeys.set(key, instanceId);
      Object.assign(row, { desired: 'running', phase: 'queued', stopReason: null, retryAt: null, assignedAgent: null });
      return true;
    },
    async markStopped(instanceId, reason) {
      const row = hosted.get(instanceId);
      if (!row) return;
      clearKey(instanceId);
      Object.assign(row, { desired: 'stopped', phase: row.assignedAgent === null ? 'stopped' : 'stopping', stopReason: reason, retryAt: null });
      for (const token of tokens) if (token.instanceId === instanceId && token.revokedAt === null) token.revokedAt = 1;
    },
    async requestConfigSync(instanceId) {
      const row = hosted.get(instanceId);
      if (!row || row.desired !== 'running' || row.assignedAgent === null) return false;
      row.configSyncSeq += 1;
      return true;
    },
    async assign(instanceId, agentId) {
      const row = hosted.get(instanceId);
      if (!row || row.assignedAgent !== null || row.desired !== 'running') return false;
      Object.assign(row, { assignedAgent: agentId, epoch: row.epoch + 1, launchSeq: 0, phase: 'assigned', retryAt: null });
      return true;
    },
    async release(instanceId, toQueue, reason) {
      const row = hosted.get(instanceId);
      if (!row) return null;
      const previous = row.assignedAgent;
      Object.assign(row, { assignedAgent: null, phase: toQueue ? 'queued' : 'stopped', retryAt: null, stopReason: reason ?? row.stopReason });
      for (const token of tokens) if (token.instanceId === instanceId && token.revokedAt === null) token.revokedAt = 1;
      return previous;
    },
    async bumpLaunchSeq(instanceId) {
      const row = hosted.get(instanceId)!;
      row.launchSeq += 1;
      return row.launchSeq;
    },
    async applyReport(instanceId, epoch, phase, retryAt, now) {
      const row = hosted.get(instanceId);
      if (!row || row.epoch !== epoch || row.assignedAgent === null) return false;
      Object.assign(row, { phase, retryAt, lastReportAt: now });
      return true;
    },
    async markMigrating(instanceId, now) {
      const row = hosted.get(instanceId);
      if (row) Object.assign(row, { phase: 'migrating', migratingSince: now });
    },
    async revokeTokens(instanceId, now) {
      for (const token of tokens) if (token.instanceId === instanceId && token.revokedAt === null) token.revokedAt = now;
    },
    async insertToken(token) {
      tokens.push({ ...token, id: nextToken++, revokedAt: null });
    },
    async readStatus(instanceId) {
      const json = ke.statuses.get(instanceId);
      return json ? { statusJson: json, statusAt: 0 } : null;
    },
    async lastHealthEvidence() {
      return healthEvidence.at;
    },
  };

  return {
    ke,
    agents,
    hosted,
    credentials,
    tokens,
    nonces,
    healthEvidence,
    transaction: (work) => work(tx),
    async findAgent(agentId) {
      return agents.get(agentId) ?? null;
    },
    async readHostedBearer(digest, now): Promise<HostedBearerRecord | null> {
      const hex = (bytes: Uint8Array) => [...bytes].join(',');
      const token = tokens.find((item) => hex(item.digest) === hex(digest) && item.revokedAt === null && item.expiresAt > now);
      return token ? { tokenId: token.id, userId: token.userId, instanceId: token.instanceId, epoch: token.epoch, launchSeq: token.launchSeq } : null;
    },
    async cleanup() {},
  };
}
