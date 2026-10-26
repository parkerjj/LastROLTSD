import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_RULES,
  analyzeTransfer,
  verdictFor,
  type AnalysisInput,
  type Evidence,
  type RuleId,
} from '../src/admin/transfer-analysis';
import { EMPTY_NETWORK, type ActivityRecord } from '../src/activity/types';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CHARACTER_AID = 7001;
const DEVICE = '0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const DEVICE_2 = '1c8d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const FINGERPRINT = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const FINGERPRINT_2 = 'b'.repeat(32) + 'fedcba9876543210'.repeat(2);

type Side = 'A' | 'B';
let nextId = 1;

function rec(side: Side, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    ...EMPTY_NETWORK,
    id: nextId++,
    user_id: side === 'A' ? 1 : 2,
    event: 'LOGIN',
    result: 'SUCCESS',
    aid: null,
    cid: null,
    nid: null,
    ref: null,
    source: 'live',
    request_id: null,
    created_at: T0,
    ...overrides,
  };
}

interface RunOptions {
  heat?: Partial<AnalysisInput['heat']>;
  aAids?: number[];
  bAids?: number[];
  aTruncated?: boolean;
  bTruncated?: boolean;
  noPad?: boolean;
}

// 每侧补 3 条无网络信息的旧记录，避免触发"数据不足"，也不会命中任何规则。
function pad(side: Side): ActivityRecord[] {
  return [1, 2, 3].map((i) => rec(side, { created_at: T0 - 60 * DAY - i * DAY }));
}

function run(a: ActivityRecord[], b: ActivityRecord[], options: RunOptions = {}) {
  return analyzeTransfer({
    source: {
      userId: 1,
      records: options.noPad ? a : [...a, ...pad('A')],
      truncated: options.aTruncated ?? false,
      aids: options.aAids ?? [],
    },
    target: {
      userId: 2,
      records: options.noPad ? b : [...b, ...pad('B')],
      truncated: options.bTruncated ?? false,
      aids: options.bAids ?? [],
    },
    characterAid: CHARACTER_AID,
    heat: {
      ip_net: options.heat?.ip_net ?? {},
      device_id: options.heat?.device_id ?? {},
      fingerprint: options.heat?.fingerprint ?? {},
    },
  });
}

function find(result: { evidence: Evidence[] }, rule: RuleId): Evidence | undefined {
  return result.evidence.find((item) => item.rule === rule);
}

function ids(evidence: Evidence | undefined): number[] {
  return [...(evidence?.event_ids ?? [])].sort((x, y) => x - y);
}

describe('verdictFor', () => {
  it('分档边界', () => {
    expect(verdictFor(70, false)).toBe('HIGH');
    expect(verdictFor(69, false)).toBe('POSSIBLE');
    expect(verdictFor(40, false)).toBe('POSSIBLE');
    expect(verdictFor(39, false)).toBe('NONE');
    expect(verdictFor(100, true)).toBe('INSUFFICIENT');
  });
});

describe('设备与指纹', () => {
  it('同一设备热度缺省按 2 计 45 分，事件取两侧带该设备的记录', () => {
    const a = rec('A', { device_id: DEVICE });
    const b = rec('B', { device_id: DEVICE });
    const result = run([a, rec('A')], [b]);
    const evidence = find(result, 'SAME_DEVICE');
    expect(evidence).toMatchObject({ kind: 'strong', points: 45 });
    expect(ids(evidence)).toEqual([a.id, b.id]);
    expect(find(result, 'COMMON_DEVICE')).toBeUndefined();
  });

  it('热度 3 的设备 15 分；热度 6 不产出 SAME_DEVICE，改出 COMMON_DEVICE', () => {
    const records = () => [[rec('A', { device_id: DEVICE })], [rec('B', { device_id: DEVICE })]] as const;
    const [a3, b3] = records();
    expect(find(run([...a3], [...b3], { heat: { device_id: { [DEVICE]: 3 } } }), 'SAME_DEVICE')?.points).toBe(15);
    const [a6, b6] = records();
    const high = run([...a6], [...b6], { heat: { device_id: { [DEVICE]: 6 } } });
    expect(find(high, 'SAME_DEVICE')).toBeUndefined();
    expect(find(high, 'COMMON_DEVICE')).toMatchObject({ kind: 'counter', points: 0 });
    expect(ids(find(high, 'COMMON_DEVICE'))).toEqual([a6[0]!.id, b6[0]!.id].sort((x, y) => x - y));
  });

  it('多个共有设备取热度最低的一档，其余高热度设备各出一条 COMMON_DEVICE', () => {
    const result = run(
      [rec('A', { device_id: DEVICE }), rec('A', { device_id: DEVICE_2 })],
      [rec('B', { device_id: DEVICE }), rec('B', { device_id: DEVICE_2 })],
      { heat: { device_id: { [DEVICE]: 8, [DEVICE_2]: 1 } } },
    );
    expect(find(result, 'SAME_DEVICE')?.points).toBe(45);
    expect(result.evidence.filter((item) => item.rule === 'COMMON_DEVICE')).toHaveLength(1);
  });

  it('只有一侧出现的设备不命中；每侧最多取 5 条记录', () => {
    expect(find(run([rec('A', { device_id: DEVICE })], [rec('B')]), 'SAME_DEVICE')).toBeUndefined();
    const manyA = Array.from({ length: 8 }, (_, i) => rec('A', { device_id: DEVICE, created_at: T0 + i }));
    const manyB = Array.from({ length: 8 }, (_, i) => rec('B', { device_id: DEVICE, created_at: T0 + i }));
    expect(find(run(manyA, manyB), 'SAME_DEVICE')?.event_ids).toHaveLength(10);
  });

  it('指纹档位：3 → 30，4 → 10，10 → 10，11 → 不产出并出 COMMON_FINGERPRINT', () => {
    const points = (heat: number) => {
      const result = run([rec('A', { fingerprint: FINGERPRINT })], [rec('B', { fingerprint: FINGERPRINT })], {
        heat: { fingerprint: { [FINGERPRINT]: heat } },
      });
      return { strong: find(result, 'SAME_FINGERPRINT'), counter: find(result, 'COMMON_FINGERPRINT') };
    };
    expect(points(3).strong?.points).toBe(30);
    expect(points(4).strong?.points).toBe(10);
    expect(points(10).strong?.points).toBe(10);
    expect(points(11).strong).toBeUndefined();
    expect(points(11).counter).toMatchObject({ kind: 'counter', points: 0 });
    expect(points(10).counter).toBeUndefined();
  });
});

describe('IP 规则', () => {
  const ip = (net: string, extra: Partial<ActivityRecord> = {}) => ({ ip: net, ip_net: net, ...extra });

  it('30 分钟内同一 IP 网段 25 分，文本写出配对次数', () => {
    const a = rec('A', ip('203.0.113.9'));
    const b1 = rec('B', ip('203.0.113.9', { created_at: T0 + 10 * MIN }));
    const b2 = rec('B', ip('203.0.113.9', { created_at: T0 + 20 * MIN }));
    const evidence = find(run([a], [b1, b2]), 'NEAR_SAME_IP');
    expect(evidence).toMatchObject({ kind: 'strong', points: 25 });
    expect(ids(evidence)).toEqual([a.id, b1.id]);
    expect(evidence?.text).toContain('2 次');
    expect(evidence?.text).toContain('203.0.113.9');
    expect(evidence?.redacted_text).toContain('203.0.x.x');
  });

  it('超过 30 分钟、不同网段都不命中；刚好 30 分钟命中', () => {
    expect(find(run([rec('A', ip('203.0.113.9'))], [rec('B', ip('203.0.113.9', { created_at: T0 + 31 * MIN }))]), 'NEAR_SAME_IP')).toBeUndefined();
    expect(find(run([rec('A', ip('203.0.113.9'))], [rec('B', ip('198.51.100.7'))]), 'NEAR_SAME_IP')).toBeUndefined();
    expect(find(run([rec('A', ip('203.0.113.9'))], [rec('B', ip('203.0.113.9', { created_at: T0 - 30 * MIN }))]), 'NEAR_SAME_IP')?.points).toBe(25);
  });

  it('机房 IP：NEAR_SAME_IP 按 0.3 折算为 8，并有 HOSTING_IP', () => {
    const result = run(
      [rec('A', ip('203.0.113.9', { is_hosting: true }))],
      [rec('B', ip('203.0.113.9', { created_at: T0 + MIN }))],
    );
    expect(find(result, 'NEAR_SAME_IP')?.points).toBe(Math.round(25 * 0.3));
    expect(find(result, 'NEAR_SAME_IP')?.points).toBe(8);
    expect(find(result, 'HOSTING_IP')).toMatchObject({ kind: 'counter', points: 0 });
    expect(find(result, 'HOSTING_IP')?.text).toContain('0.3');
  });

  it('IP 热度 4 → 13 分；热度 6 → 不产出并有 PUBLIC_IP', () => {
    const records = () => [
      [rec('A', ip('203.0.113.9'))],
      [rec('B', ip('203.0.113.9', { created_at: T0 + MIN }))],
    ] as const;
    const [a4, b4] = records();
    expect(find(run([...a4], [...b4], { heat: { ip_net: { '203.0.113.9': 4 } } }), 'NEAR_SAME_IP')?.points).toBe(13);
    const [a6, b6] = records();
    const result = run([...a6], [...b6], { heat: { ip_net: { '203.0.113.9': 6 } } });
    expect(find(result, 'NEAR_SAME_IP')).toBeUndefined();
    expect(find(result, 'SHARED_IP')).toBeUndefined();
    expect(find(result, 'PUBLIC_IP')).toMatchObject({ kind: 'counter', points: 0 });
    expect(find(result, 'PUBLIC_IP')?.text).toContain('公共 IP');
    expect(find(result, 'PUBLIC_IP')?.event_ids).toHaveLength(2);
  });

  it('多个网段取系数最大的一对', () => {
    const a1 = rec('A', ip('203.0.113.9'));
    const b1 = rec('B', ip('203.0.113.9', { created_at: T0 + MIN }));
    const a2 = rec('A', ip('198.51.100.7'));
    const b2 = rec('B', ip('198.51.100.7', { created_at: T0 + 2 * MIN }));
    const evidence = find(run([a1, a2], [b1, b2], { heat: { ip_net: { '203.0.113.9': 4 } } }), 'NEAR_SAME_IP');
    expect(evidence?.points).toBe(25);
    expect(ids(evidence)).toEqual([a2.id, b2.id]);
  });

  it('系数并列时取时间差最小的一对', () => {
    const a1 = rec('A', ip('203.0.113.9'));
    const b1 = rec('B', ip('203.0.113.9', { created_at: T0 + 20 * MIN }));
    const a2 = rec('A', ip('198.51.100.7'));
    const b2 = rec('B', ip('198.51.100.7', { created_at: T0 + 2 * MIN }));
    expect(ids(find(run([a1, a2], [b1, b2]), 'NEAR_SAME_IP'))).toEqual([a2.id, b2.id]);
  });

  it('IPv6 /64 网段同样适用，脱敏文本用 maskIp', () => {
    const net = '2001:db8:1:2::/64';
    const evidence = find(run([rec('A', ip(net))], [rec('B', ip(net, { created_at: T0 + MIN }))]), 'NEAR_SAME_IP');
    expect(evidence?.text).toContain(net);
    expect(evidence?.redacted_text).toContain('2001:db8:x:x::/64');
    expect(evidence?.redacted_text).not.toContain(net);
  });

  it('SHARED_IP：1 个 8 分，4 个封顶 24；无共有不产出；事件每个 IP 每侧 1 条', () => {
    const nets = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'];
    const aRecs = nets.map((net, i) => rec('A', ip(net, { created_at: T0 - (i + 5) * DAY })));
    const bRecs = nets.map((net, i) => rec('B', ip(net, { created_at: T0 + (i + 5) * DAY })));
    const four = find(run(aRecs, bRecs), 'SHARED_IP');
    expect(four).toMatchObject({ kind: 'strong', points: 24 });
    expect(four?.event_ids).toHaveLength(8);

    const one = run([rec('A', ip(nets[0]!, { created_at: T0 - 5 * DAY }))], [rec('B', ip(nets[0]!, { created_at: T0 + 5 * DAY }))]);
    expect(find(one, 'SHARED_IP')?.points).toBe(8);
    expect(find(one, 'NEAR_SAME_IP')).toBeUndefined();

    expect(find(run([rec('A', ip(nets[0]!))], [rec('B', ip(nets[1]!))]), 'SHARED_IP')).toBeUndefined();
  });

  it('SHARED_IP 按热度折算：热度 4 的两个 IP = 8', () => {
    const aRecs = ['203.0.113.1', '203.0.113.2'].map((net) => rec('A', ip(net, { created_at: T0 - 5 * DAY })));
    const bRecs = ['203.0.113.1', '203.0.113.2'].map((net) => rec('B', ip(net, { created_at: T0 + 5 * DAY })));
    const heat = { ip_net: { '203.0.113.1': 4, '203.0.113.2': 4 } };
    expect(find(run(aRecs, bRecs, { heat }), 'SHARED_IP')?.points).toBe(8);
  });

  it('机房共有 IP 的 SHARED_IP 为 round(8 × 0.3) = 2', () => {
    const result = run(
      [rec('A', ip('203.0.113.1', { is_hosting: true, created_at: T0 - 5 * DAY }))],
      [rec('B', ip('203.0.113.1', { created_at: T0 + 5 * DAY }))],
    );
    expect(find(result, 'SHARED_IP')?.points).toBe(2);
  });
});

describe('注册链', () => {
  const ip = (net: string, extra: Partial<ActivityRecord> = {}) => ({ ip: net, ip_net: net, ...extra });

  it('A 注册后 6 分钟 B 用同一 IP 操作 → 15 分，文本含时间差，事件 [r, o]', () => {
    const r = rec('A', ip('203.0.113.9', { event: 'REGISTER' }));
    const o = rec('B', ip('203.0.113.9', { event: 'REGISTER', created_at: T0 + 6 * MIN }));
    const evidence = find(run([r], [o]), 'REGISTRATION_CHAIN');
    expect(evidence).toMatchObject({ kind: 'strong', points: 15 });
    expect(evidence?.event_ids).toEqual([r.id, o.id]);
    expect(evidence?.text).toContain('B 在 A 注册 6 分钟后');
    expect(evidence?.text).toContain('同一 IP');
  });

  it('B 的注册、A 的操作同样命中', () => {
    const r = rec('B', ip('203.0.113.9', { event: 'REGISTER', created_at: T0 + 2 * HOUR }));
    const o = rec('A', ip('203.0.113.9', { event: 'LOGIN' }));
    const evidence = find(run([o], [r]), 'REGISTRATION_CHAIN');
    expect(evidence?.points).toBe(15);
    expect(evidence?.event_ids).toEqual([r.id, o.id]);
    expect(evidence?.text).toContain('A 在 B 注册 2 小时前');
  });

  it('同设备按设备热度折算：缺省热度 2 → 15 分，即使 IP 是公共 IP', () => {
    const r = rec('A', ip('203.0.113.9', { event: 'REGISTER', device_id: DEVICE }));
    const o = rec('B', ip('203.0.113.9', { device_id: DEVICE, created_at: T0 + HOUR }));
    const result = run([r], [o], { heat: { ip_net: { '203.0.113.9': 9 } } });
    expect(find(result, 'REGISTRATION_CHAIN')?.points).toBe(15);
    expect(find(result, 'REGISTRATION_CHAIN')?.text).toContain('同一设备');
    expect(find(result, 'REGISTRATION_CHAIN')?.text).not.toContain(DEVICE);
  });

  it('同设备热度 4 → round(15 / 3) = 5 分', () => {
    const r = rec('A', { event: 'REGISTER', device_id: DEVICE });
    const o = rec('B', { device_id: DEVICE, created_at: T0 + HOUR });
    const result = run([r], [o], { heat: { device_id: { [DEVICE]: 4 } } });
    expect(find(result, 'REGISTRATION_CHAIN')?.points).toBe(Math.round(15 / 3));
  });

  it('公共设备（热度 9）不为注册链加分，且仍有 COMMON_DEVICE', () => {
    const r = rec('A', ip('203.0.113.9', { event: 'REGISTER', device_id: DEVICE }));
    const o = rec('B', ip('203.0.113.9', { device_id: DEVICE, created_at: T0 + HOUR }));
    const result = run([r], [o], { heat: { ip_net: { '203.0.113.9': 9 }, device_id: { [DEVICE]: 9 } } });
    expect(find(result, 'REGISTRATION_CHAIN')).toBeUndefined();
    expect(find(result, 'COMMON_DEVICE')).toMatchObject({ points: 0 });
  });

  it('公共设备但 IP 热度低时，注册链仍按 IP 计分', () => {
    const r = rec('A', ip('203.0.113.9', { event: 'REGISTER', device_id: DEVICE }));
    const o = rec('B', ip('203.0.113.9', { device_id: DEVICE, created_at: T0 + HOUR }));
    const result = run([r], [o], { heat: { device_id: { [DEVICE]: 9 } } });
    expect(find(result, 'REGISTRATION_CHAIN')?.points).toBe(15);
    expect(find(result, 'REGISTRATION_CHAIN')?.text).toContain('同一 IP');
  });

  it('同 IP 按热度折算：热度 4 → round(7.5) = 8；热度 6 → 不产出', () => {
    const mk = () => [
      [rec('A', ip('203.0.113.9', { event: 'REGISTER' }))],
      [rec('B', ip('203.0.113.9', { created_at: T0 + HOUR }))],
    ] as const;
    const [a4, b4] = mk();
    expect(find(run([...a4], [...b4], { heat: { ip_net: { '203.0.113.9': 4 } } }), 'REGISTRATION_CHAIN')?.points).toBe(8);
    const [a6, b6] = mk();
    expect(find(run([...a6], [...b6], { heat: { ip_net: { '203.0.113.9': 6 } } }), 'REGISTRATION_CHAIN')).toBeUndefined();
  });

  it('超过 24 小时、双方都不是注册、IP 与设备都不同，均不命中', () => {
    const farR = rec('A', ip('203.0.113.9', { event: 'REGISTER' }));
    const farO = rec('B', ip('203.0.113.9', { created_at: T0 + 24 * HOUR + MIN }));
    expect(find(run([farR], [farO]), 'REGISTRATION_CHAIN')).toBeUndefined();
    const noReg = run([rec('A', ip('203.0.113.9'))], [rec('B', ip('203.0.113.9', { created_at: T0 + HOUR }))]);
    expect(find(noReg, 'REGISTRATION_CHAIN')).toBeUndefined();
    const diff = run([rec('A', ip('203.0.113.9', { event: 'REGISTER' }))], [rec('B', ip('198.51.100.7', { created_at: T0 + HOUR }))]);
    expect(find(diff, 'REGISTRATION_CHAIN')).toBeUndefined();
  });
});

describe('aid 规则', () => {
  it('目标账号带有被转移角色的 aid → 30 分，事件为 B 侧该 aid 的记录', () => {
    const b = rec('B', { aid: CHARACTER_AID });
    const result = run([rec('A', { aid: CHARACTER_AID })], [b, rec('B', { aid: 9 })], { bAids: [CHARACTER_AID, 9] });
    const evidence = find(result, 'CHARACTER_AID');
    expect(evidence).toMatchObject({ kind: 'strong', points: 30 });
    expect(evidence?.event_ids).toEqual([b.id]);
  });

  it('目标账号没有该 aid 不命中', () => {
    expect(find(run([], [], { aAids: [CHARACTER_AID], bAids: [5] }), 'CHARACTER_AID')).toBeUndefined();
  });

  it('其他共有 aid → 20 分，事件为两侧带该 aid 的记录；只共有被转移 aid 不命中', () => {
    const a = rec('A', { aid: 55 });
    const b = rec('B', { aid: 55 });
    const hit = find(run([a, rec('A', { aid: 66 })], [b], { aAids: [CHARACTER_AID, 55, 66], bAids: [CHARACTER_AID, 55] }), 'OTHER_AID');
    expect(hit).toMatchObject({ kind: 'strong', points: 20 });
    expect(ids(hit)).toEqual([a.id, b.id]);
    expect(find(run([], [], { aAids: [CHARACTER_AID], bAids: [CHARACTER_AID] }), 'OTHER_AID')).toBeUndefined();
  });
});

describe('弱证据', () => {
  it('最常出现的城市相同（不区分大小写）→ 5 分，无事件', () => {
    const result = run(
      [rec('A', { city: 'Beijing' }), rec('A', { city: 'Beijing' }), rec('A', { city: 'Tokyo' })],
      [rec('B', { city: 'beijing' })],
    );
    expect(find(result, 'MAIN_CITY')).toMatchObject({ kind: 'weak', points: 5, event_ids: [] });
  });

  it('最常出现城市不同不命中；并列取最近出现的', () => {
    const miss = run([rec('A', { city: 'Beijing' })], [rec('B', { city: 'Shanghai' })]);
    expect(find(miss, 'MAIN_CITY')).toBeUndefined();
    const tie = run(
      [rec('A', { city: 'Beijing', created_at: T0 }), rec('A', { city: 'Tokyo', created_at: T0 + MIN })],
      [rec('B', { city: 'Tokyo' })],
    );
    expect(find(tie, 'MAIN_CITY')?.points).toBe(5);
    const tieMiss = run(
      [rec('A', { city: 'Tokyo', created_at: T0 }), rec('A', { city: 'Beijing', created_at: T0 + MIN })],
      [rec('B', { city: 'Tokyo' })],
    );
    expect(find(tieMiss, 'MAIN_CITY')).toBeUndefined();
  });

  it('最常用 ASN 相同 → 3 分；不同不命中', () => {
    const hit = run([rec('A', { asn: 4134, as_org: 'Chinanet' })], [rec('B', { asn: 4134, as_org: 'Chinanet' })]);
    expect(find(hit, 'MAIN_ASN')).toMatchObject({ kind: 'weak', points: 3, event_ids: [] });
    expect(find(run([rec('A', { asn: 4134 })], [rec('B', { asn: 4837 })]), 'MAIN_ASN')).toBeUndefined();
  });

  it('完全相同的非空 UA → 3 分，事件为一对；不同或为空不命中', () => {
    const a = rec('A', { user_agent: 'Mozilla/5.0 X' });
    const b = rec('B', { user_agent: 'Mozilla/5.0 X' });
    const hit = find(run([a], [b]), 'SAME_UA');
    expect(hit).toMatchObject({ kind: 'weak', points: 3 });
    expect(ids(hit)).toEqual([a.id, b.id]);
    expect(find(run([rec('A', { user_agent: 'X' })], [rec('B', { user_agent: 'Y' })]), 'SAME_UA')).toBeUndefined();
    expect(find(run([rec('A')], [rec('B')]), 'SAME_UA')).toBeUndefined();
  });
});

describe('反向证据', () => {
  const beijing = { country: 'CN', city: 'Beijing', latitude: 39.9042, longitude: 116.4074 };
  const guangzhou = { country: 'CN', city: 'Guangzhou', latitude: 23.1291, longitude: 113.2644 };
  const tokyo = { country: 'JP', city: 'Tokyo', latitude: 35.6762, longitude: 139.6503 };

  it('不同国家 10 分钟内 → -20，且没有 CONCURRENT_CITY', () => {
    const a = rec('A', beijing);
    const b = rec('B', { ...tokyo, created_at: T0 + 10 * MIN });
    const result = run([a], [b]);
    expect(find(result, 'CONCURRENT_COUNTRY')).toMatchObject({ kind: 'counter', points: -20 });
    expect(ids(find(result, 'CONCURRENT_COUNTRY'))).toEqual([a.id, b.id]);
    expect(find(result, 'CONCURRENT_CITY')).toBeUndefined();
    expect(result.evidence.filter((item) => item.rule === 'CONCURRENT_COUNTRY')).toHaveLength(1);
  });

  it('北京与广州 5 分钟内、同为 CN → CONCURRENT_CITY -10', () => {
    const a = rec('A', beijing);
    const b = rec('B', { ...guangzhou, created_at: T0 + 5 * MIN });
    const result = run([a], [b]);
    expect(find(result, 'CONCURRENT_CITY')).toMatchObject({ kind: 'counter', points: -10 });
    expect(ids(find(result, 'CONCURRENT_CITY'))).toEqual([a.id, b.id]);
    expect(find(result, 'CONCURRENT_COUNTRY')).toBeUndefined();
  });

  it('超过 10 分钟、同城、距离不足 300 km、缺经纬度都不命中', () => {
    expect(find(run([rec('A', beijing)], [rec('B', { ...tokyo, created_at: T0 + 11 * MIN })]), 'CONCURRENT_COUNTRY')).toBeUndefined();
    expect(find(run([rec('A', beijing)], [rec('B', { ...beijing, created_at: T0 + MIN })]), 'CONCURRENT_CITY')).toBeUndefined();
    const tianjin = { country: 'CN', city: 'Tianjin', latitude: 39.3434, longitude: 117.3616 };
    expect(find(run([rec('A', beijing)], [rec('B', { ...tianjin, created_at: T0 + MIN })]), 'CONCURRENT_CITY')).toBeUndefined();
    const noGeo = { country: 'CN', city: 'Guangzhou' };
    expect(find(run([rec('A', beijing)], [rec('B', { ...noGeo, created_at: T0 + MIN })]), 'CONCURRENT_CITY')).toBeUndefined();
    expect(find(run([rec('A', { country: 'CN' })], [rec('B', { country: null })]), 'CONCURRENT_COUNTRY')).toBeUndefined();
  });

  it('同一对既不同国家又不同城市时只出 CONCURRENT_COUNTRY；跨国一对之外另有同国远城一对仍只算一次国家', () => {
    const result = run([rec('A', beijing)], [rec('B', { ...tokyo, created_at: T0 + MIN })]);
    expect(result.evidence.map((item) => item.rule)).not.toContain('CONCURRENT_CITY');
  });
});

describe('分数与结论', () => {
  it('设备 + 指纹 + 近时同 IP + 共同 IP + 角色 aid 全部命中 → 截断到 100', () => {
    const net = { ip: '203.0.113.9', ip_net: '203.0.113.9' };
    const result = run(
      [rec('A', { ...net, device_id: DEVICE, fingerprint: FINGERPRINT })],
      [rec('B', { ...net, device_id: DEVICE, fingerprint: FINGERPRINT, aid: CHARACTER_AID, created_at: T0 + MIN })],
      { bAids: [CHARACTER_AID] },
    );
    expect(result.score).toBe(100);
    expect(result.verdict).toBe('HIGH');
  });

  it('只有 CONCURRENT_COUNTRY → 分数截断到 0', () => {
    const result = run([rec('A', { country: 'CN' })], [rec('B', { country: 'JP', created_at: T0 + MIN })]);
    expect(find(result, 'CONCURRENT_COUNTRY')?.points).toBe(-20);
    expect(result.score).toBe(0);
    expect(result.verdict).toBe('NONE');
  });

  it('分数等于各证据分之和；中间档位', () => {
    const result = run(
      [rec('A', { device_id: DEVICE })],
      [rec('B', { device_id: DEVICE })],
      { heat: { device_id: { [DEVICE]: 3 } }, bAids: [CHARACTER_AID] },
    );
    expect(result.score).toBe(45);
    expect(result.verdict).toBe('POSSIBLE');
  });

  it('一侧只有 2 条有效记录（另有 1 条后台角色转移）→ INSUFFICIENT', () => {
    const a = [rec('A'), rec('A'), rec('A')];
    const b = [rec('B'), rec('B'), rec('B', { event: 'ADMIN_CHARACTER_TRANSFER' })];
    const result = run(a, b, { noPad: true });
    expect(result.verdict).toBe('INSUFFICIENT');
  });

  it('后台角色转移日志不参与任何规则', () => {
    const net = { ip: '203.0.113.9', ip_net: '203.0.113.9', device_id: DEVICE };
    const result = run([rec('A', net)], [rec('B', { ...net, event: 'ADMIN_CHARACTER_TRANSFER' })]);
    expect(result.evidence).toEqual([]);
  });

  it('一侧 0 条记录 → INSUFFICIENT 且不抛错', () => {
    const result = analyzeTransfer({
      source: { userId: 1, records: [], truncated: false, aids: [] },
      target: { userId: 2, records: [], truncated: false, aids: [] },
      characterAid: CHARACTER_AID,
      heat: { ip_net: {}, device_id: {}, fingerprint: {} },
    });
    expect(result).toMatchObject({ score: 0, verdict: 'INSUFFICIENT', evidence: [], notes: [] });
  });

  it('证据按 强 → 弱 → 反向 排序', () => {
    const result = run(
      [rec('A', { device_id: DEVICE, city: 'Beijing', country: 'CN' })],
      [rec('B', { device_id: DEVICE, city: 'Beijing', country: 'JP', created_at: T0 + MIN })],
    );
    const kinds = result.evidence.map((item) => item.kind);
    expect(kinds).toEqual(['strong', 'weak', 'counter']);
  });

  it('截断的一侧写入 notes', () => {
    const result = run([], [], { aTruncated: true, bTruncated: true });
    expect(result.notes).toEqual([
      '账号 A 的日志超过上限，只分析了最近的部分',
      '账号 B 的日志超过上限，只分析了最近的部分',
    ]);
    expect(run([], []).notes).toEqual([]);
  });
});

describe('隐私', () => {
  it('redacted_text 不含完整 IPv4，所有文本不含设备 ID 与指纹', () => {
    const base = { ip: '203.0.113.9', ip_net: '203.0.113.9', country: 'CN', city: 'Beijing', asn: 4134, as_org: 'Chinanet', user_agent: 'UA-1' };
    const a = [
      rec('A', { ...base, event: 'REGISTER', device_id: DEVICE, fingerprint: FINGERPRINT, is_hosting: true, aid: CHARACTER_AID }),
      rec('A', { ...base, ip: '198.51.100.7', ip_net: '198.51.100.7', device_id: DEVICE_2, fingerprint: FINGERPRINT_2, latitude: 39.9, longitude: 116.4 }),
      rec('A', { ip: '2001:db8:1:2::1', ip_net: '2001:db8:1:2::/64' }),
    ];
    const b = [
      rec('B', { ...base, device_id: DEVICE, fingerprint: FINGERPRINT, created_at: T0 + MIN, aid: CHARACTER_AID }),
      rec('B', { ...base, ip: '198.51.100.7', ip_net: '198.51.100.7', device_id: DEVICE_2, fingerprint: FINGERPRINT_2, country: 'JP', city: 'Tokyo', latitude: 35.6, longitude: 139.6, created_at: T0 + 2 * MIN }),
      rec('B', { ip: '2001:db8:1:2::9', ip_net: '2001:db8:1:2::/64', created_at: T0 + 3 * MIN }),
    ];
    const result = run(a, b, {
      bAids: [CHARACTER_AID],
      heat: {
        ip_net: { '198.51.100.7': 9 },
        device_id: { [DEVICE_2]: 9 },
        fingerprint: { [FINGERPRINT_2]: 20 },
      },
    });
    expect(result.evidence.length).toBeGreaterThan(6);
    for (const item of result.evidence) {
      expect(item.redacted_text).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
      for (const secret of [DEVICE, DEVICE_2, FINGERPRINT, FINGERPRINT_2]) {
        for (const text of [item.text, item.redacted_text]) {
          expect(text).not.toContain(secret);
          expect(text).not.toContain(secret.slice(0, 8));
        }
      }
    }
  });
});

describe('ANALYSIS_RULES', () => {
  it('分值常量与设计稿一致', () => {
    expect(ANALYSIS_RULES.device).toMatchObject({ highPoints: 45, midPoints: 15 });
    expect(ANALYSIS_RULES.fingerprint).toMatchObject({ highPoints: 30, midPoints: 10 });
    expect(ANALYSIS_RULES.verdict).toEqual({ high: 70, possible: 40 });
  });
});
