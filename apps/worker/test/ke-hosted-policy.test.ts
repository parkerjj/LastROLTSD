import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_LEASE_MS,
  AGENT_FAILOVER_MARGIN_MS,
  cappedLicenseExpiry,
  decideFailover,
  hostedCap,
  hostingEligible,
  planConvergence,
  rankAgents,
  type HostingEntitlement,
  type PlanInstance,
  type SchedulableAgent,
} from '../src/ke/hosted/policy';
import {
  AgentSignatureError,
  canonicalRequest,
  parseSignedHeaders,
  verifyAgentSignature,
} from '../src/ke/hosted/signature';
import { base64UrlDecode, base64UrlEncode } from '../src/ke/crypto';

const entitlement = (slots: number, extraSlots: number, hasCore = true): HostingEntitlement => ({ slots, extraSlots, hasCore });

describe('托管资格（I1）：全有或全无', () => {
  it('只有免费额度、没有核心模块、被扣减到 0 都没有资格', () => {
    expect(hostingEligible(entitlement(1, 0))).toBe(false);
    expect(hostingEligible(entitlement(2, 1, false))).toBe(false);
    expect(hostingEligible(entitlement(1, 0))).toBe(false);
    expect(hostedCap(entitlement(1, 0))).toBe(0);
  });
  it('任何额外额度（含管理员赠送）都有资格，托管上限等于总额度（含免费那个）', () => {
    expect(hostingEligible(entitlement(2, 1))).toBe(true);
    expect(hostedCap(entitlement(2, 1))).toBe(2);
    expect(hostedCap(entitlement(11, 10))).toBe(11);
  });
});

const inst = (id: string, hosted: boolean, startedAt: number): PlanInstance => ({ instanceId: id, hosted, startedAt });

describe('超额收敛（I6）', () => {
  it('买 1 个额外额度（共 2 个）托管 2 个，到期后两个都停，一个都不保留', () => {
    const verdicts = planConvergence({
      eligible: false,
      slots: 1,
      instances: [inst('a', true, 1), inst('b', true, 2)],
    });
    expect(verdicts).toEqual([
      { instanceId: 'a', action: 'stop_no_entitlement' },
      { instanceId: 'b', action: 'stop_no_entitlement' },
    ]);
  });

  it('额度 3 → 2：只停最新启动的 1 个托管实例', () => {
    const verdicts = planConvergence({
      eligible: true,
      slots: 2,
      instances: [inst('a', true, 1), inst('b', true, 2), inst('c', true, 3)],
    });
    expect(verdicts).toEqual([{ instanceId: 'c', action: 'stop_over_cap' }]);
  });

  it('先算资格再算额度：托管被停后，非托管实例不会被同时误杀', () => {
    // limit 回到 1；托管 H 最老、浏览器 B 较新。H 因失去资格被停，B 必须继续运行。
    const verdicts = planConvergence({
      eligible: false,
      slots: 1,
      instances: [inst('H', true, 1), inst('B', false, 2)],
    });
    expect(verdicts).toEqual([{ instanceId: 'H', action: 'stop_no_entitlement' }]);
  });

  it('非托管实例超出额度时按 startedAt 升序保留，其余被踢；并列按 id 排序且结果确定', () => {
    const instances = [inst('z', false, 5), inst('a', false, 5), inst('m', false, 9)];
    const first = planConvergence({ eligible: true, slots: 1, instances });
    const second = planConvergence({ eligible: true, slots: 1, instances: [...instances].reverse() });
    expect(first).toEqual(second);
    expect(first).toEqual([
      { instanceId: 'z', action: 'kick_quota_shrunk' },
      { instanceId: 'm', action: 'kick_quota_shrunk' },
    ]);
  });

  it('未超额时不产生任何动作', () => {
    expect(planConvergence({ eligible: true, slots: 3, instances: [inst('a', true, 1), inst('b', false, 2)] })).toEqual([]);
    expect(planConvergence({ eligible: false, slots: 1, instances: [inst('b', false, 2)] })).toEqual([]);
  });

  it('托管与非托管混合：先限制托管数，再整体收敛', () => {
    // slots=2：托管 h1 h2 h3 + 非托管 n1 → 先停 h3（over cap），剩 h1 h2 n1 共 3 个，再踢最新的 n1。
    const verdicts = planConvergence({
      eligible: true,
      slots: 2,
      instances: [inst('h1', true, 1), inst('h2', true, 2), inst('h3', true, 3), inst('n1', false, 4)],
    });
    expect(verdicts).toEqual([
      { instanceId: 'h3', action: 'stop_over_cap' },
      { instanceId: 'n1', action: 'kick_quota_shrunk' },
    ]);
  });
});

const agent = (overrides: Partial<SchedulableAgent> = {}): SchedulableAgent => ({
  agentId: 'agt_000000000000000000000001',
  status: 'online',
  accepting: true,
  reserved: 0,
  maxInstances: 40,
  memAvailableMb: 1000,
  lastSeen: 1_000_000,
  rejectUntil: null,
  ...overrides,
});

describe('调度（6.1）', () => {
  const now = 1_000_000;
  it('只选在线、接受新实例、有空位、内存够的 agent，空位多者优先', () => {
    const ranked = rankAgents([
      agent({ agentId: 'agt_a', reserved: 30 }),
      agent({ agentId: 'agt_b', reserved: 5 }),
      agent({ agentId: 'agt_c', status: 'down' }),
      agent({ agentId: 'agt_d', accepting: false }),
      agent({ agentId: 'agt_e', reserved: 40 }),
      agent({ agentId: 'agt_f', memAvailableMb: 10 }),
      agent({ agentId: 'agt_g', rejectUntil: now + 1 }),
      agent({ agentId: 'agt_h', lastSeen: now - AGENT_LEASE_MS - 1 }),
    ], now, AGENT_LEASE_MS);
    expect(ranked.map((item) => item.agentId)).toEqual(['agt_b', 'agt_a']);
  });
  it('空位相同按可用内存，再按 id，顺序固定', () => {
    const ranked = rankAgents([
      agent({ agentId: 'agt_2', memAvailableMb: 500 }),
      agent({ agentId: 'agt_1', memAvailableMb: 900 }),
      agent({ agentId: 'agt_3', memAvailableMb: 900 }),
    ], now, AGENT_LEASE_MS);
    expect(ranked.map((item) => item.agentId)).toEqual(['agt_1', 'agt_3', 'agt_2']);
  });
});

describe('故障转移判定与熔断', () => {
  const now = 10 * 60 * 60 * 1000;
  const old = now - AGENT_LEASE_MS - AGENT_FAILOVER_MARGIN_MS - 1;
  const fresh = now - 30_000;

  it('只有一台过期而另一台新鲜：判过期那台', () => {
    const decision = decideFailover([
      { agentId: 'a', status: 'online', lastSeen: old },
      { agentId: 'b', status: 'online', lastSeen: fresh },
      { agentId: 'c', status: 'online', lastSeen: fresh },
    ], now, null);
    expect(decision).toEqual({ expired: ['a'], frozen: 'none' });
  });
  it('租约还在 L+3 分钟余量内不判故障', () => {
    const decision = decideFailover([
      { agentId: 'a', status: 'online', lastSeen: now - AGENT_LEASE_MS - 1 },
      { agentId: 'b', status: 'online', lastSeen: fresh },
    ], now, null);
    expect(decision.expired).toEqual([]);
  });
  it('LTSD 整体故障：全部过期且没有健康证据，熔断冻结', () => {
    const decision = decideFailover([
      { agentId: 'a', status: 'online', lastSeen: old },
      { agentId: 'b', status: 'online', lastSeen: old },
    ], now, null);
    expect(decision).toEqual({ expired: [], frozen: 'no_health_evidence' });
  });
  it('有实例心跳作为健康证据，但过半 agent 过期：仍冻结', () => {
    const decision = decideFailover([
      { agentId: 'a', status: 'online', lastSeen: old },
      { agentId: 'b', status: 'online', lastSeen: old },
      { agentId: 'c', status: 'online', lastSeen: fresh },
    ], now, now - 1000);
    expect(decision.frozen).toBe('majority_expired');
  });
  it('只有一台 VPS：没有健康证据就不判；有实例心跳证据才判（无处可迁，但状态要释放）', () => {
    const single = [{ agentId: 'a', status: 'online', lastSeen: old }];
    expect(decideFailover(single, now, null).frozen).toBe('no_health_evidence');
    expect(decideFailover(single, now, now - 1000)).toEqual({ expired: ['a'], frozen: 'none' });
  });
  it('已经 down 的 agent 不再重复判定', () => {
    expect(decideFailover([{ agentId: 'a', status: 'down', lastSeen: old }], now, now).expired).toEqual([]);
  });
});

describe('托管 license 封顶', () => {
  it('不会超过资格到期时间', () => {
    expect(cappedLicenseExpiry(1000, 5000, 3000)).toBe(3000);
    expect(cappedLicenseExpiry(1000, 5000, 99999)).toBe(6000);
    expect(cappedLicenseExpiry(1000, 5000, null)).toBe(6000);
  });
});

describe('agent 请求签名', () => {
  const seed = new Uint8Array(32).fill(7);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
  const body = new TextEncoder().encode('{"a":1}');
  const ts = 1_800_000_000;
  const nonce = 'abcdefghijklmnop0123456789';

  async function sign64(path = '/api/v1/ke/agent/lease'): Promise<Uint8Array> {
    const message = await canonicalRequest('POST', path, String(ts), nonce, body);
    return new Uint8Array(sign(null, Buffer.from(message), privateKey));
  }

  it('canonical 字符串固定（Rust agent 使用同一份向量）', async () => {
    const message = new TextDecoder().decode(await canonicalRequest('post', '/api/v1/ke/agent/lease', String(ts), nonce, body));
    expect(message).toBe(
      'KE-AGENT-V1\nPOST\n/api/v1/ke/agent/lease\n1800000000\nabcdefghijklmnop0123456789\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  it('固定私钥种子产生固定签名（Rust 侧用同一向量校验互操作）', async () => {
    expect(base64UrlEncode(await sign64())).toBe('j0oEa98_Gul_2Un5sijx6YM-ltVgUnR5KyLGyFEbms4iiHksTY-OODK9ZuIPxuGIaTW2_P_DSfp_P1USI4tZCg');
    expect(base64UrlEncode(publicKey)).toBe('6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw');
  });

  it('合法签名通过；篡改路径、body、nonce、公钥都失败', async () => {
    const signature = await sign64();
    await expect(verifyAgentSignature(publicKey, signature, 'POST', '/api/v1/ke/agent/lease', ts, nonce, body)).resolves.toBeUndefined();
    await expect(verifyAgentSignature(publicKey, signature, 'POST', '/api/v1/ke/agent/other', ts, nonce, body)).rejects.toBeInstanceOf(AgentSignatureError);
    await expect(verifyAgentSignature(publicKey, signature, 'POST', '/api/v1/ke/agent/lease', ts, nonce, new TextEncoder().encode('{"a":2}'))).rejects.toBeInstanceOf(AgentSignatureError);
    await expect(verifyAgentSignature(publicKey, signature, 'POST', '/api/v1/ke/agent/lease', ts, 'zzzzzzzzzzzzzzzzzzzz', body)).rejects.toBeInstanceOf(AgentSignatureError);
    await expect(verifyAgentSignature(new Uint8Array(32).fill(1), signature, 'POST', '/api/v1/ke/agent/lease', ts, nonce, body)).rejects.toBeInstanceOf(AgentSignatureError);
    await expect(verifyAgentSignature(publicKey, signature.slice(0, 63), 'POST', '/api/v1/ke/agent/lease', ts, nonce, body)).rejects.toBeInstanceOf(AgentSignatureError);
  });

  it('请求头格式与时间窗检查', async () => {
    const signature = await sign64();
    const headers = (overrides: Record<string, string> = {}) => new Headers({
      'x-ke-agent': 'agt_0123456789abcdef01234567',
      'x-ke-ts': String(ts),
      'x-ke-nonce': nonce,
      'x-ke-sig': base64UrlEncode(signature),
      ...overrides,
    });
    expect(parseSignedHeaders(headers(), ts * 1000).agentId).toBe('agt_0123456789abcdef01234567');
    expect(() => parseSignedHeaders(headers(), (ts + 61) * 1000)).toThrow(AgentSignatureError);
    expect(() => parseSignedHeaders(headers(), (ts - 61) * 1000)).toThrow(AgentSignatureError);
    for (const bad of [{ 'x-ke-agent': 'agt_xyz' }, { 'x-ke-ts': 'abc' }, { 'x-ke-nonce': 'short' }, { 'x-ke-sig': 'AAAA' }]) {
      expect(() => parseSignedHeaders(headers(bad), ts * 1000)).toThrow(AgentSignatureError);
    }
    expect(base64UrlDecode(base64UrlEncode(signature))).toEqual(signature);
  });
});
