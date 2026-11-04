import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digestToken } from '../src/auth/crypto';
import type { KeConfig } from '../src/ke/config';
import { base64UrlDecode, base64UrlEncode } from '../src/ke/crypto';
import { decryptGamePassword } from '../src/ke/hosted/credential-crypto';
import { AGENT_FAILOVER_MARGIN_MS, AGENT_LEASE_MS } from '../src/ke/hosted/policy';
import type { AgentRow } from '../src/ke/hosted/repository';
import { createHostedService, type HostedService } from '../src/ke/hosted/service';
import { canonicalRequest } from '../src/ke/hosted/signature';
import { KeFailure } from '../src/ke/types';
import { makeFakeHostedRepository, type FakeHostedRepository } from './helpers/hosted-fake';

const USER = 10000;
const OTHER_USER = 20000;
const AGENT_A = 'agt_0000000000000000000000a1';
const AGENT_B = 'agt_0000000000000000000000b2';
const encoder = new TextEncoder();
const KEY = new Uint8Array(32).fill(5);

function config(): KeConfig {
  return {
    enabled: true, licensePrivateKey: new Uint8Array(48), licenseKeyVersion: '1', coreKey: new Uint8Array(32).fill(9), coreKeyVersion: '3',
    networkKey: new Uint8Array(32).fill(8), networkKeyVersion: '2', buildManifest: null, hostedCredentialKey: KEY, hostedCredentialKeyVersion: 1,
  };
}

function agentRow(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: id, name: `vps-${id.slice(-2)}`, pubkey: new Uint8Array(32), status: 'online', accepting: true, reserved: 0, maxInstances: 5,
    memAvailableMb: 1500, lastSeen: 1_700_000_000_000, rejectUntil: null, version: '1', packageId: 'pkg', ...overrides,
  };
}

function setup(options: { slots?: number; extra?: number; agents?: string[] } = {}) {
  let nowMs = 1_700_000_000_000;
  const repo = makeFakeHostedRepository();
  repo.ke.entitlements.set(USER, { slots: options.slots ?? 2, modules: new Set(['core']) });
  repo.ke.hostingModule.set(USER, options.extra ?? 1);
  repo.ke.entitlements.set(OTHER_USER, { slots: 2, modules: new Set(['core']) });
  repo.ke.hostingModule.set(OTHER_USER, 1);
  for (const id of options.agents ?? [AGENT_A]) repo.agents.set(id, agentRow(id, { lastSeen: nowMs }));
  const events: [string, Record<string, unknown>][] = [];
  const service = createHostedService(repo, config(), () => nowMs, (event, detail) => events.push([event, detail]));
  return { repo, service, events, advance: (ms: number) => { nowMs += ms; }, now: () => nowMs };
}

const create = (service: HostedService, aid = 1000001, userId = USER) =>
  service.create(String(userId), { nid: 3, aid, cid: 2000002, charName: `Char${aid}`, gameAccount: `acct${aid}`, gamePassword: `pw-${aid}` });

describe('托管创建与资格（I1/I2）', () => {
  it('没有托管资格的用户不能创建；有资格时密码以密文落库', async () => {
    const denied = setup({ slots: 1, extra: 0 });
    await expect(create(denied.service)).rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED', status: 403 });
    expect(denied.repo.credentials.size).toBe(0);

    const { service, repo } = setup();
    const { id } = await create(service);
    const credential = [...repo.credentials.values()][0]!;
    expect(credential.gameAccount).toBe('acct1000001');
    expect(new TextDecoder().decode(credential.gamePasswordEnc)).not.toContain('pw-1000001');
    expect(await decryptGamePassword(KEY, { userId: USER, nid: 3, aid: 1000001, cid: 2000002, keyVersion: 1 }, credential.gamePasswordEnc)).toBe('pw-1000001');
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'stopped', userId: USER });
  });

  it('密文绑定 (user, nid, aid, cid, key_version)：换一行就解不开', async () => {
    const { service, repo } = setup();
    await create(service);
    const blob = [...repo.credentials.values()][0]!.gamePasswordEnc;
    await expect(decryptGamePassword(KEY, { userId: OTHER_USER, nid: 3, aid: 1000001, cid: 2000002, keyVersion: 1 }, blob)).rejects.toThrow();
    await expect(decryptGamePassword(KEY, { userId: USER, nid: 3, aid: 1000009, cid: 2000002, keyVersion: 1 }, blob)).rejects.toThrow();
    await expect(decryptGamePassword(KEY, { userId: USER, nid: 3, aid: 1000001, cid: 2000002, keyVersion: 2 }, blob)).rejects.toThrow();
  });

  it('同一角色重复登记返回 KE_HOSTED_EXISTS；每用户凭据上限 20', async () => {
    const { service } = setup();
    await create(service);
    await expect(create(service)).rejects.toMatchObject({ code: 'KE_HOSTED_EXISTS' });
    for (let aid = 2000000; aid < 2000019; aid += 1) await create(service, aid);
    await expect(create(service, 2999999)).rejects.toMatchObject({ code: 'KE_HOSTED_LIMIT' });
  });

  it('已被其他账号 30 天内绑定的角色不能登记，且不泄露是谁', async () => {
    const { service, repo, now } = setup();
    repo.ke.characters.set('1000001:2000002:3', {
      aid: 1000001, cid: 2000002, nid: 3, user_id: OTHER_USER, char_name: 'Taken', base_level: null, job_level: null, job_id: null, map_name: null, bound_at: now(), last_seen_at: now(),
    });
    const error = await create(service).catch((e: unknown) => e) as KeFailure;
    expect(error.code).toBe('KE_HOSTED_CHARACTER_UNAVAILABLE');
    expect(error.details).toBeUndefined();
  });

  it('托管密钥未配置时整体不可用（fail closed）', async () => {
    const repo = makeFakeHostedRepository();
    repo.ke.hostingModule.set(USER, 1);
    const service = createHostedService(repo, { ...config(), hostedCredentialKey: null }, () => 1);
    await expect(create(service)).rejects.toMatchObject({ code: 'KE_UNAVAILABLE' });
  });
});

describe('启动、调度与停止（6.1/6.2）', () => {
  it('start 分配到在线 agent：epoch+1、预留名额；重复 start 幂等', async () => {
    const { service, repo } = setup();
    const { id } = await create(service);
    const first = await service.start(String(USER), id);
    expect(first.notify).toEqual([AGENT_A]);
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'running', assignedAgent: AGENT_A, epoch: 1, phase: 'assigned' });
    expect(repo.agents.get(AGENT_A)?.reserved).toBe(1);
    expect((await service.start(String(USER), id)).notify).toEqual([]);
    expect(repo.hosted.get(id)?.epoch).toBe(1);
  });

  it('运行中的托管数不能超过额度（I2）；无资格用户不能启动已有记录', async () => {
    const { service, repo } = setup({ slots: 2 });
    const ids = [(await create(service, 1)).id, (await create(service, 2)).id, (await create(service, 3)).id];
    await service.start(String(USER), ids[0]!);
    await service.start(String(USER), ids[1]!);
    await expect(service.start(String(USER), ids[2]!)).rejects.toMatchObject({ code: 'KE_HOSTED_CAP_REACHED' });
    repo.ke.hostingModule.set(USER, 0);
    await expect(service.start(String(USER), ids[2]!)).rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED' });
  });

  it('别的用户看不到、也启动不了这个记录', async () => {
    const { service } = setup();
    const { id } = await create(service);
    await expect(service.start(String(OTHER_USER), id)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_FOUND' });
    await expect(service.stop(String(OTHER_USER), id)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_FOUND' });
    await expect(service.remove(String(OTHER_USER), id)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_FOUND' });
  });

  it('同一角色同时只能有一个运行中的托管记录（防抢注，无竞态）', async () => {
    const { service, repo } = setup();
    const mine = await create(service);
    const theirs = await create(service, 1000001, OTHER_USER);
    await service.start(String(USER), mine.id);
    await expect(service.start(String(OTHER_USER), theirs.id)).rejects.toMatchObject({ code: 'KE_HOSTED_CHARACTER_BUSY' });
    expect(repo.hosted.get(theirs.id)?.desired).toBe('stopped');
  });

  it('没有可用 agent 时进入 queued；agent 上线后 Cron 兜底调度', async () => {
    const { service, repo, advance, now } = setup({ agents: [] });
    const { id } = await create(service);
    expect((await service.start(String(USER), id)).notify).toEqual([]);
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'running', assignedAgent: null, phase: 'queued' });
    repo.agents.set(AGENT_A, agentRow(AGENT_A, { lastSeen: now() }));
    advance(1000);
    const summary = await service.tick();
    expect(summary.scheduled).toBe(1);
    expect(repo.hosted.get(id)).toMatchObject({ assignedAgent: AGENT_A, epoch: 1 });
  });

  it('空位多的 agent 优先；满了的 agent 不再分配', async () => {
    const { service, repo, now } = setup({ agents: [AGENT_A, AGENT_B], slots: 5 });
    repo.agents.get(AGENT_A)!.reserved = 3;
    repo.agents.get(AGENT_B)!.maxInstances = 1;
    repo.agents.get(AGENT_B)!.reserved = 1;
    const { id } = await create(service);
    await service.start(String(USER), id);
    expect(repo.hosted.get(id)?.assignedAgent).toBe(AGENT_A);
    expect(now()).toBeGreaterThan(0);
  });

  it('stop 后 agent 回执 stopped 才释放归属；停止过程中又点启动则重新排队', async () => {
    const { service, repo } = setup();
    const { id } = await create(service);
    await service.start(String(USER), id);
    const agent = repo.agents.get(AGENT_A)!;
    expect((await service.stop(String(USER), id)).notify).toEqual([AGENT_A]);
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'stopped', assignedAgent: AGENT_A, phase: 'stopping' });

    await service.report(agent, id, { epoch: 1, phase: 'stopped', retryAt: null });
    expect(repo.hosted.get(id)).toMatchObject({ assignedAgent: null, phase: 'stopped' });
    expect(agent.reserved).toBe(0);

    // 停止过程中用户又点了启动：回执时按当时的 desired 重新排队，而不是无条件清空。
    await service.start(String(USER), id);
    await service.stop(String(USER), id);
    repo.hosted.get(id)!.desired = 'running';
    const result = await service.report(agent, id, { epoch: 2, phase: 'stopped', retryAt: null });
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'running', epoch: 3, assignedAgent: AGENT_A });
    expect(result.notify).toEqual([AGENT_A]);
  });

  it('上一次停止还没收到回执时再点启动：返回 KE_HOSTED_STOPPING，不误报角色被占用', async () => {
    const { service, repo } = setup();
    const { id } = await create(service);
    await service.start(String(USER), id);
    await service.stop(String(USER), id);
    await expect(service.start(String(USER), id)).rejects.toMatchObject({ code: 'KE_HOSTED_STOPPING', status: 409 });
    expect(repo.hosted.get(id)?.desired).toBe('stopped');
  });

  it('过期 epoch 的回执被拒绝；error 回执让 LTSD 置 desired=stopped 并释放槽位', async () => {
    const { service, repo } = setup();
    const { id } = await create(service);
    await service.start(String(USER), id);
    const agent = repo.agents.get(AGENT_A)!;
    await expect(service.report(agent, id, { epoch: 99, phase: 'running', retryAt: null })).rejects.toMatchObject({ code: 'KE_EPOCH_STALE' });
    await service.report(agent, id, { epoch: 1, phase: 'running', retryAt: null });
    expect(repo.hosted.get(id)?.phase).toBe('running');
    await service.report(agent, id, { epoch: 1, phase: 'error', retryAt: null });
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'stopped', assignedAgent: null, stopReason: 'error' });
    expect(agent.reserved).toBe(0);
  });

  it('进程确认退出（stopped / error 回执）后，它在 KE 实例表里预占的额度一起释放', async () => {
    const { service, repo } = setup({ slots: 1 });
    const { id } = await create(service);
    await service.start(String(USER), id);
    const agent = repo.agents.get(AGENT_A)!;
    const now = Date.now();
    // launch 预占额度后，KE 实例行是 ACTIVE。
    repo.ke.instances.set(id, {
      instance_id: id, user_id: USER, aid: 1000001, cid: 2000002, nid: 3, state: 'ACTIVE', mode: 'auto',
      char_name: 'Char1000001', map_name: null, started_at: now, last_heartbeat_at: now, updated_at: now, stopped_at: null,
      kicked_by_instance_id: null, kick_reason: null,
    } as never);
    await service.stop(String(USER), id);
    await service.report(agent, id, { epoch: 1, phase: 'stopped', retryAt: null });
    expect(repo.ke.instances.get(id)?.state).toBe('STOPPED');

    // error 回执同样释放。
    const second = await create(service, 1000002);
    await service.start(String(USER), second.id);
    repo.ke.instances.set(second.id, { ...repo.ke.instances.get(id)!, instance_id: second.id, state: 'ACTIVE' } as never);
    await service.report(agent, second.id, { epoch: 1, phase: 'error', retryAt: null });
    expect(repo.ke.instances.get(second.id)?.state).toBe('STOPPED');
  });

  it('被其他方式顶下线（KICKED）的 KE 实例行不会被终止回执改写', async () => {
    const { service, repo } = setup();
    const { id } = await create(service);
    await service.start(String(USER), id);
    const now = Date.now();
    repo.ke.instances.set(id, {
      instance_id: id, user_id: USER, aid: 1000001, cid: 2000002, nid: 3, state: 'KICKED', mode: 'auto',
      char_name: 'Char1000001', map_name: null, started_at: now, last_heartbeat_at: now, updated_at: now, stopped_at: null,
      kicked_by_instance_id: 'other', kick_reason: 'quota_kick',
    } as never);
    await service.report(repo.agents.get(AGENT_A)!, id, { epoch: 1, phase: 'error', retryAt: null });
    expect(repo.ke.instances.get(id)?.state).toBe('KICKED');
  });

  it('删除前必须先停止', async () => {
    const { service, repo } = setup();
    const { id } = await create(service);
    await service.start(String(USER), id);
    await expect(service.remove(String(USER), id)).rejects.toMatchObject({ code: 'KE_HOSTED_NOT_STOPPED' });
    await service.stop(String(USER), id);
    await service.report(repo.agents.get(AGENT_A)!, id, { epoch: 1, phase: 'stopped', retryAt: null });
    await service.remove(String(USER), id);
    expect(repo.hosted.size).toBe(0);
    expect(repo.credentials.size).toBe(0);
  });
});

describe('launch（I3/I9/I15）', () => {
  async function started() {
    const ctx = setup({ slots: 2 });
    const { id } = await create(ctx.service);
    await ctx.service.start(String(USER), id);
    return { ...ctx, id, agent: ctx.repo.agents.get(AGENT_A)! };
  }

  it('下发凭据与托管 token，并先预占额度（实例置 ACTIVE、占槽）', async () => {
    const { service, repo, id, agent, now } = await started();
    const pkg = await service.launch(agent, id, 1);
    expect(pkg).toMatchObject({ instance_id: id, epoch: 1, launch_seq: 1, game_account: 'acct1000001', game_password: 'pw-1000001', commands: ['ai auto'], user_id: String(USER) });
    expect(pkg.ltsd_token).toMatch(/^ke1_[A-Za-z0-9_-]{43}$/u);
    expect(repo.ke.instances.get(id)).toMatchObject({ state: 'ACTIVE', mode: 'auto', last_heartbeat_at: now() });
    const bearer = await repo.readHostedBearer(await digestToken(pkg.ltsd_token.slice(4)), now());
    expect(bearer).toMatchObject({ instanceId: id, epoch: 1, launchSeq: 1, userId: USER });
  });

  it('旧 epoch、别的 agent、desired=stopped 都不能 launch', async () => {
    const { service, repo, id, agent } = await started();
    await expect(service.launch(agent, id, 7)).rejects.toMatchObject({ code: 'KE_EPOCH_STALE' });
    const stranger = agentRow(AGENT_B);
    repo.agents.set(AGENT_B, stranger);
    await expect(service.launch(stranger, id, 1)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_FOUND' });
    repo.hosted.get(id)!.desired = 'stopped';
    await expect(service.launch(agent, id, 1)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });
  });

  it('额度被非托管实例占满：不发凭据、不踢人，返回 KE_QUOTA_EXCEEDED', async () => {
    const { service, repo, id, agent, now } = await started();
    repo.ke.entitlements.set(USER, { slots: 1, modules: new Set(['core']) });
    repo.ke.instances.set('99999999-9999-4999-8999-999999999999', {
      instance_id: '99999999-9999-4999-8999-999999999999', user_id: USER, aid: 7, cid: 7, nid: 7, char_name: 'Other', map_name: null, state: 'ACTIVE', mode: 'auto',
      features: null, build_id: null, license_expires_at: now() + 1000, last_heartbeat_at: now(), started_at: now(), kicked_at: null, kicked_by_instance_id: null,
      stopped_at: null, kick_reason: null, updated_at: now(),
    });
    await expect(service.launch(agent, id, 1)).rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
    expect(repo.ke.instances.get('99999999-9999-4999-8999-999999999999')?.state).toBe('ACTIVE');
    expect(repo.tokens).toHaveLength(0);
  });

  it('同角色存在存活的非托管会话：KE_CHARACTER_IN_USE，不登录、不接管', async () => {
    const { service, repo, id, agent, now } = await started();
    repo.ke.instances.set('88888888-8888-4888-8888-888888888888', {
      instance_id: '88888888-8888-4888-8888-888888888888', user_id: USER, aid: 1000001, cid: 2000002, nid: 3, char_name: 'Mine', map_name: null, state: 'ACTIVE', mode: 'auto',
      features: null, build_id: null, license_expires_at: now() + 1000, last_heartbeat_at: now(), started_at: now(), kicked_at: null, kicked_by_instance_id: null,
      stopped_at: null, kick_reason: null, updated_at: now(),
    });
    await expect(service.launch(agent, id, 1)).rejects.toMatchObject({ code: 'KE_CHARACTER_IN_USE' });
    expect(repo.ke.instances.get('88888888-8888-4888-8888-888888888888')?.state).toBe('ACTIVE');
  });

  it('重放 launch：launch_seq 递增、旧 token 被吊销、不重复占额度', async () => {
    const { service, repo, id, agent, now } = await started();
    const first = await service.launch(agent, id, 1);
    const second = await service.launch(agent, id, 1);
    expect(second.launch_seq).toBe(2);
    expect(await repo.readHostedBearer(await digestToken(first.ltsd_token.slice(4)), now())).toBeNull();
    expect(await repo.readHostedBearer(await digestToken(second.ltsd_token.slice(4)), now())).not.toBeNull();
    expect([...repo.ke.instances.values()].filter((i) => i.state === 'ACTIVE')).toHaveLength(1);
  });

  it('失去资格后重放 launch 必须失败，且停止被持久化（不再下发密码）', async () => {
    const { service, repo, id, agent } = await started();
    await service.launch(agent, id, 1);
    repo.ke.hostingModule.set(USER, 0);
    repo.ke.entitlements.set(USER, { slots: 1, modules: new Set(['core']) });
    await expect(service.launch(agent, id, 1)).rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED' });
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'stopped', stopReason: 'no-hosting-entitlement' });
    expect(repo.tokens.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('托管 token 的到期时间封顶为资格到期时间', async () => {
    const { service, repo, id, agent, now } = await started();
    repo.ke.hostingExpiry.set(USER, now() + 60_000);
    const pkg = await service.launch(agent, id, 1);
    expect(pkg.ltsd_token_expires_at).toBe(now() + 60_000);
  });

  it('refreshToken 签发新 token，不吊销仍在用的旧 token', async () => {
    const { service, repo, id, agent, now } = await started();
    const first = await service.launch(agent, id, 1);
    const refreshed = await service.refreshToken(agent, id, 1);
    expect(refreshed.ltsd_token).not.toBe(first.ltsd_token);
    expect(await repo.readHostedBearer(await digestToken(first.ltsd_token.slice(4)), now())).not.toBeNull();
    await expect(service.refreshToken(agent, id, 9)).rejects.toMatchObject({ code: 'KE_EPOCH_STALE' });
  });
});

describe('租约对账与资格收敛（I1/I6）', () => {
  const leaseInput = { version: '1', packageId: 'pkg', memAvailableMb: 900, cleanSlate: false, instances: [] as { id: string; epoch: number; phase: string; retryAt: number | null }[] };

  it('租约返回属于该 agent 的实例，并刷新 last_seen 与服务端计算的 reserved', async () => {
    const { service, repo, advance } = setup({ agents: [AGENT_A, AGENT_B] });
    const { id } = await create(service);
    await service.start(String(USER), id);
    advance(60_000);
    const agent = repo.agents.get(AGENT_A)!;
    repo.agents.get(AGENT_A)!.reserved = 99; // 被入侵的 agent 谎报/计数漂移：服务端自己重算
    const response = await service.lease(agent, leaseInput);
    expect(response.instances).toEqual([expect.objectContaining({ id, epoch: 1, desired: 'running' })]);
    expect(agent.reserved).toBe(1);
    expect(agent.lastSeen).toBe(1_700_000_060_000);
    const empty = await service.lease(repo.agents.get(AGENT_B)!, leaseInput);
    expect(empty.instances).toEqual([]);
  });

  it('租约里上报不属于自己的实例会被忽略', async () => {
    const { service, repo } = setup({ agents: [AGENT_A, AGENT_B] });
    const { id } = await create(service);
    await service.start(String(USER), id);
    await service.lease(repo.agents.get(AGENT_B)!, { ...leaseInput, instances: [{ id, epoch: 1, phase: 'running', retryAt: null }] });
    expect(repo.hosted.get(id)?.phase).toBe('assigned');
  });

  it('买 1 个额外额度、托管 2 个，到期后下一次租约两个都 desired=stopped，一个都不保留', async () => {
    const { service, repo } = setup({ slots: 2 });
    const a = await create(service, 1);
    const b = await create(service, 2);
    await service.start(String(USER), a.id);
    await service.start(String(USER), b.id);
    repo.ke.hostingModule.set(USER, 0);
    repo.ke.entitlements.set(USER, { slots: 1, modules: new Set(['core']) });
    const response = await service.lease(repo.agents.get(AGENT_A)!, leaseInput);
    expect(response.instances.map((item) => item.desired)).toEqual(['stopped', 'stopped']);
    expect(repo.hosted.get(a.id)).toMatchObject({ desired: 'stopped', stopReason: 'no-hosting-entitlement', phase: 'stopping' });
    expect(repo.hosted.get(b.id)).toMatchObject({ desired: 'stopped', stopReason: 'no-hosting-entitlement' });
    // 重新购买后不自动恢复：必须用户再点启动。
    repo.ke.hostingModule.set(USER, 1);
    repo.ke.entitlements.set(USER, { slots: 2, modules: new Set(['core']) });
    const again = await service.lease(repo.agents.get(AGENT_A)!, leaseInput);
    expect(again.instances.map((item) => item.desired)).toEqual(['stopped', 'stopped']);
  });

  it('额度 3 → 2：只停最新创建的 1 个托管实例，其余继续', async () => {
    const { service, repo, advance } = setup({ slots: 3, extra: 2 });
    const ids: string[] = [];
    for (const aid of [1, 2, 3]) {
      ids.push((await create(service, aid)).id);
      advance(10);
      await service.start(String(USER), ids.at(-1)!);
    }
    repo.ke.entitlements.set(USER, { slots: 2, modules: new Set(['core']) });
    repo.ke.hostingModule.set(USER, 1);
    await service.lease(repo.agents.get(AGENT_A)!, leaseInput);
    expect(ids.map((id) => repo.hosted.get(id)?.desired)).toEqual(['running', 'running', 'stopped']);
  });

  it('额度 2 → 1：幸存者按 KE 启动时间而非登记顺序选择，与心跳收敛一致', async () => {
    const { service, repo, advance, now } = setup({ slots: 2, extra: 1 });
    const a = await create(service, 1); // 先登记
    advance(10);
    const b = await create(service, 2); // 后登记
    await service.start(String(USER), a.id);
    await service.start(String(USER), b.id);
    const active = (id: string, startedAt: number) => ({
      instance_id: id, user_id: USER, aid: 1, cid: 2000002, nid: 3, state: 'ACTIVE', mode: 'auto',
      char_name: id, map_name: null, started_at: startedAt, last_heartbeat_at: now(), updated_at: now(), stopped_at: null,
      kicked_by_instance_id: null, kick_reason: null,
    } as never);
    // B 比 A 更早启动 —— 心跳收敛会保留 B，所以 lease 也必须保留 B、停止 A。
    repo.ke.instances.set(b.id, active(b.id, now() - 2000));
    repo.ke.instances.set(a.id, active(a.id, now() - 1000));
    repo.ke.entitlements.set(USER, { slots: 1, modules: new Set(['core']) });
    repo.ke.hostingModule.set(USER, 1);
    await service.lease(repo.agents.get(AGENT_A)!, leaseInput);
    expect(repo.hosted.get(a.id)?.desired).toBe('stopped');
    expect(repo.hosted.get(b.id)?.desired).toBe('running');
  });

  it('被围栏（down）的 agent 租约返回 fenced；声明清场后才能重新上线', async () => {
    const { service, repo } = setup();
    repo.agents.get(AGENT_A)!.status = 'down';
    const agent = repo.agents.get(AGENT_A)!;
    expect((await service.lease(agent, leaseInput)).fenced).toBe(true);
    expect((await service.lease(agent, { ...leaseInput, cleanSlate: true, instances: [{ id: 'x', epoch: 1, phase: 'running', retryAt: null }] })).fenced).toBe(true);
    const back = await service.lease(agent, { ...leaseInput, cleanSlate: true });
    expect(back.fenced).toBe(false);
    expect(repo.agents.get(AGENT_A)?.status).toBe('online');
  });
});

describe('故障转移（Cron）', () => {
  it('agent 租约超过 L+3 分钟：标记 down，实例回到 queued 并改派到另一台，epoch 加 1，旧 token 吊销', async () => {
    const { service, repo, advance, now } = setup({ agents: [AGENT_A, AGENT_B] });
    repo.agents.get(AGENT_B)!.reserved = 4; // 让第一次分配落在 A
    const { id } = await create(service);
    await service.start(String(USER), id);
    expect(repo.hosted.get(id)?.assignedAgent).toBe(AGENT_A);
    await service.launch(repo.agents.get(AGENT_A)!, id, 1);
    repo.agents.get(AGENT_B)!.reserved = 0;

    advance(AGENT_LEASE_MS + AGENT_FAILOVER_MARGIN_MS + 1000);
    repo.agents.get(AGENT_B)!.lastSeen = now() - 10_000; // B 仍在续租（健康证据）
    const summary = await service.tick();
    expect(summary.failedOver).toEqual([AGENT_A]);
    expect(repo.agents.get(AGENT_A)?.status).toBe('down');
    expect(repo.hosted.get(id)).toMatchObject({ assignedAgent: AGENT_B, epoch: 2, desired: 'running' });
    expect(repo.tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(repo.agents.get(AGENT_A)?.reserved).toBe(0);

    // Cron 可能重复执行：第二次不应再做任何事。
    const again = await service.tick();
    expect(again.failedOver).toEqual([]);
    expect(repo.hosted.get(id)?.epoch).toBe(2);
  });

  it('旧 agent 回来后用旧 epoch launch/report 一律被拒', async () => {
    const { service, repo, advance, now } = setup({ agents: [AGENT_A, AGENT_B] });
    repo.agents.get(AGENT_B)!.reserved = 4;
    const { id } = await create(service);
    await service.start(String(USER), id);
    repo.agents.get(AGENT_B)!.reserved = 0;
    advance(AGENT_LEASE_MS + AGENT_FAILOVER_MARGIN_MS + 1000);
    repo.agents.get(AGENT_B)!.lastSeen = now();
    await service.tick();
    const oldAgent = repo.agents.get(AGENT_A)!;
    await expect(service.launch(oldAgent, id, 1)).rejects.toMatchObject({ code: 'KE_AGENT_FENCED' });
    // 即使它清场重新上线，旧 epoch 的 launch 也找不到归属自己的实例。
    oldAgent.status = 'online';
    await expect(service.launch(oldAgent, id, 1)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_FOUND' });
    await expect(service.report(oldAgent, id, { epoch: 1, phase: 'running', retryAt: null })).rejects.toMatchObject({ code: 'KE_EPOCH_STALE' });
  });

  it('LTSD 整体故障（所有 agent 同时过期、没有健康证据）：熔断冻结，不改派', async () => {
    const { service, repo, advance } = setup({ agents: [AGENT_A, AGENT_B] });
    const { id } = await create(service);
    await service.start(String(USER), id);
    advance(AGENT_LEASE_MS + AGENT_FAILOVER_MARGIN_MS + 1000);
    const summary = await service.tick();
    expect(summary.frozen).toBe('no_health_evidence');
    expect(summary.failedOver).toEqual([]);
    expect(repo.agents.get(AGENT_A)?.status).toBe('online');
    expect(repo.hosted.get(id)?.epoch).toBe(1);
  });

  it('Cron 的资格扫描：没有租约也没有 heartbeat，到期的托管实例照样被停', async () => {
    const { service, repo, advance } = setup();
    const { id } = await create(service);
    await service.start(String(USER), id);
    repo.ke.hostingModule.set(USER, 0);
    repo.ke.entitlements.set(USER, { slots: 1, modules: new Set(['core']) });
    advance(1000);
    const summary = await service.tick();
    expect(summary.enforced).toBe(1);
    expect(repo.hosted.get(id)).toMatchObject({ desired: 'stopped', stopReason: 'no-hosting-entitlement' });
  });

  it('agent 已被标记 down 但上一轮释放中途失败：下一轮 tick 继续完成改派（也覆盖运维手动置 down）', async () => {
    const { service, repo, advance, now } = setup({ agents: [AGENT_A, AGENT_B] });
    const { id } = await create(service);
    await service.start(String(USER), id);
    const assignedTo = repo.hosted.get(id)!.assignedAgent!;
    const other = assignedTo === AGENT_A ? AGENT_B : AGENT_A;
    // 模拟：agent 已 down，但实例仍挂在它名下（事务 B 没跑完）。
    repo.agents.get(assignedTo)!.status = 'down';
    advance(1000);
    repo.agents.get(other)!.lastSeen = now();
    const summary = await service.tick();
    expect(summary.failedOver).toContain(assignedTo);
    expect(repo.hosted.get(id)).toMatchObject({ assignedAgent: other, desired: 'running' });
    expect(repo.agents.get(assignedTo)!.reserved).toBe(0);
    // 已经干净的 down agent 不会反复处理。
    expect((await service.tick()).failedOver).not.toContain(assignedTo);
  });

  it('down 的 agent 名下 desired=stopped 的实例也要释放归属（否则之后永远无法再启动）', async () => {
    const { service, repo, advance, now } = setup({ agents: [AGENT_A, AGENT_B] });
    repo.agents.get(AGENT_B)!.reserved = 4;
    const { id } = await create(service);
    await service.start(String(USER), id);
    repo.agents.get(AGENT_B)!.reserved = 0;
    await service.stop(String(USER), id);
    advance(AGENT_LEASE_MS + AGENT_FAILOVER_MARGIN_MS + 1000);
    repo.agents.get(AGENT_B)!.lastSeen = now();
    await service.tick();
    expect(repo.hosted.get(id)).toMatchObject({ assignedAgent: null, desired: 'stopped', phase: 'stopped' });
    await service.start(String(USER), id);
    expect(repo.hosted.get(id)?.desired).toBe('running');
  });
});

describe('agent 鉴权与模块密钥', () => {
  const seed = new Uint8Array(32).fill(3);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8',
  });
  const pubkey = new Uint8Array(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));

  async function signed(ctx: { now: () => number }, overrides: { agentId?: string; nonce?: string; path?: string; body?: string; method?: string } = {}) {
    const ts = Math.floor(ctx.now() / 1000);
    const nonce = overrides.nonce ?? 'nonce-0123456789-abcdef';
    const path = overrides.path ?? '/api/v1/ke/agent/lease';
    const body = encoder.encode(overrides.body ?? '{}');
    const message = await canonicalRequest('POST', path, String(ts), nonce, body);
    const headers = new Headers({
      'x-ke-agent': overrides.agentId ?? AGENT_A, 'x-ke-ts': String(ts), 'x-ke-nonce': nonce,
      'x-ke-sig': base64UrlEncode(new Uint8Array(sign(null, Buffer.from(message), privateKey))),
    });
    return { headers, method: overrides.method ?? 'POST', pathAndQuery: path, body };
  }

  it('合法签名通过；重放同一 nonce、改路径/body、未知 agent、错误公钥都被拒', async () => {
    const ctx = setup();
    ctx.repo.agents.get(AGENT_A)!.pubkey = pubkey;
    const request = await signed(ctx);
    expect((await ctx.service.authenticateAgent(request)).agentId).toBe(AGENT_A);
    await expect(ctx.service.authenticateAgent(request)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' }); // 重放
    const tampered = await signed(ctx, { nonce: 'nonce-fresh-0123456789' });
    await expect(ctx.service.authenticateAgent({ ...tampered, pathAndQuery: '/api/v1/ke/agent/other' })).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
    const wrongBody = await signed(ctx, { nonce: 'nonce-body-0123456789x' });
    await expect(ctx.service.authenticateAgent({ ...wrongBody, body: encoder.encode('{"x":1}') })).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
    const unknown = await signed(ctx, { agentId: 'agt_ffffffffffffffffffffffff', nonce: 'nonce-unknown-0123456' });
    await expect(ctx.service.authenticateAgent(unknown)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
    ctx.repo.agents.get(AGENT_A)!.pubkey = new Uint8Array(32).fill(1);
    const wrongKey = await signed(ctx, { nonce: 'nonce-wrongkey-0123456' });
    await expect(ctx.service.authenticateAgent(wrongKey)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
  });

  it('时间戳超出 ±60 秒被拒；失败的签名不会占用 nonce', async () => {
    const ctx = setup();
    ctx.repo.agents.get(AGENT_A)!.pubkey = pubkey;
    const request = await signed(ctx, { nonce: 'nonce-skew-0123456789a' });
    ctx.advance(120_000);
    await expect(ctx.service.authenticateAgent(request)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
    expect(ctx.repo.nonces.size).toBe(0);
  });

  it('模块密钥以 agent_id 为盐封装，只发 core / network', async () => {
    const { service, repo } = setup();
    const agent = repo.agents.get(AGENT_A)!;
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const result = await service.moduleKeys(agent, { modules: ['core', 'network'], kePublicKey: publicRaw });
    expect(Object.keys(result.key_bundles).sort()).toEqual(['core', 'network']);
    expect(result.key_versions).toEqual({ core: 3, network: 2 });
    const bundle = result.key_bundles.core!;
    const ephemeral = await crypto.subtle.importKey('raw', base64UrlDecode(bundle.ephemeral_public) as BufferSource, { name: 'X25519' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: ephemeral } as unknown as AlgorithmIdentifier, pair.privateKey, 256));
    const ikm = await crypto.subtle.importKey('raw', shared as BufferSource, { name: 'HKDF' }, false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(AGENT_A), info: encoder.encode('ltsd-ke-core-v1') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const combined = new Uint8Array([...base64UrlDecode(bundle.ciphertext), ...base64UrlDecode(bundle.tag)]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlDecode(bundle.nonce) as BufferSource, additionalData: encoder.encode(AGENT_A) }, kek, combined));
    expect(plain).toEqual(new Uint8Array(32).fill(9));
    await expect(service.moduleKeys(agent, { modules: ['activity'], kePublicKey: publicRaw })).rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });
  });

  it('down 的 agent 不能 launch / 取密钥', async () => {
    const { service, repo } = setup();
    const agent = repo.agents.get(AGENT_A)!;
    agent.status = 'down';
    await expect(service.launch(agent, 'x', 1)).rejects.toMatchObject({ code: 'KE_AGENT_FENCED' });
    await expect(service.moduleKeys(agent, { modules: ['core'], kePublicKey: new Uint8Array(32) })).rejects.toMatchObject({ code: 'KE_AGENT_FENCED' });
  });
});
