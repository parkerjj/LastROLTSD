// 一人多号关联分析：纯函数，不查库。输入两个账号的操作日志和"热度"，输出分数、结论和证据。
import { maskIp } from '../activity/network';
import type { ActivityEvent, ActivityRecord } from '../activity/types';

export type EvidenceKind = 'strong' | 'weak' | 'counter';
export type RuleId =
  | 'SAME_DEVICE'
  | 'SAME_FINGERPRINT'
  | 'NEAR_SAME_IP'
  | 'CHARACTER_AID'
  | 'OTHER_AID'
  | 'REGISTRATION_CHAIN'
  | 'SHARED_IP'
  | 'MAIN_CITY'
  | 'MAIN_ASN'
  | 'SAME_UA'
  | 'PUBLIC_IP'
  | 'HOSTING_IP'
  | 'COMMON_DEVICE'
  | 'COMMON_FINGERPRINT'
  | 'CONCURRENT_COUNTRY'
  | 'CONCURRENT_CITY';

export interface Evidence {
  rule: RuleId;
  kind: EvidenceKind;
  points: number;
  text: string;
  // 脱敏版文案：IP 用 maskIp，永久保存的审计快照只用这一份。
  redacted_text: string;
  event_ids: number[];
}

export type Verdict = 'HIGH' | 'POSSIBLE' | 'NONE' | 'INSUFFICIENT';
export interface TransferAnalysis {
  score: number;
  verdict: Verdict;
  evidence: Evidence[];
  notes: string[];
}
export interface AnalysisSide {
  userId: number;
  records: ActivityRecord[];
  truncated: boolean;
  aids: number[];
}
export interface AnalysisInput {
  source: AnalysisSide;
  target: AnalysisSide;
  characterAid: number;
  heat: { ip_net: Record<string, number>; device_id: Record<string, number>; fingerprint: Record<string, number> };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// 所有权重、窗口、档位都在这里，便于以后调整。
export const ANALYSIS_RULES = {
  minRecords: 3,
  defaultHeat: 2,
  maxScore: 100,
  maxEventsPerSide: 5,
  // IP 热度系数：≤ lowMax → 1；≤ midMax → midFactor；更高 → 0；机房再乘 hostingFactor。
  ip: { lowMax: 2, midMax: 5, midFactor: 0.5, hostingFactor: 0.3 },
  // 设备：热度 ≤ highMax → highPoints；≤ midMax → midPoints；更高视为公共设备。
  device: { highMax: 2, highPoints: 45, midMax: 5, midPoints: 15 },
  fingerprint: { highMax: 3, highPoints: 30, midMax: 10, midPoints: 10 },
  nearSameIp: { windowMs: 30 * MINUTE, points: 25 },
  characterAid: { points: 30 },
  otherAid: { points: 20 },
  registrationChain: { windowMs: 24 * HOUR, points: 15 },
  sharedIp: { perIpPoints: 8, maxPoints: 24 },
  mainCity: { points: 5 },
  mainAsn: { points: 3 },
  sameUa: { points: 3 },
  concurrent: { windowMs: 10 * MINUTE, countryPoints: -20, cityPoints: -10, minDistanceKm: 300 },
  verdict: { high: 70, possible: 40 },
} as const;

export function verdictFor(score: number, insufficient: boolean): Verdict {
  if (insufficient) return 'INSUFFICIENT';
  if (score >= ANALYSIS_RULES.verdict.high) return 'HIGH';
  if (score >= ANALYSIS_RULES.verdict.possible) return 'POSSIBLE';
  return 'NONE';
}

const EVENT_VERBS: Record<ActivityEvent, string> = {
  REGISTER: '注册',
  EMAIL_VERIFIED: '验证邮箱',
  LOGIN: '登录',
  PASSWORD_RESET_REQUEST: '申请重置密码',
  PASSWORD_RESET: '重置密码',
  PASSWORD_CHANGE: '修改密码',
  KE_DEVICE_APPROVE: '授权设备',
  KE_DEVICE_TOKEN: '领取设备令牌',
  KE_BIND: '绑定角色',
  KE_START: '启动',
  KE_HEARTBEAT: '心跳',
  GUESTBOOK_POST: '留言',
  GUESTBOOK_REPLY: '回复留言',
  ADMIN_CHARACTER_TRANSFER: '角色转移',
};

type IpFormat = (net: string) => string;
const plainIp: IpFormat = (net) => net;

function evidence(
  rule: RuleId,
  kind: EvidenceKind,
  rawPoints: number,
  eventIds: number[],
  make: (ip: IpFormat) => string,
): Evidence {
  return { rule, kind, points: Math.round(rawPoints), text: make(plainIp), redacted_text: make(maskIp), event_ids: eventIds };
}

function formatGap(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时`;
}

function formatFactor(factor: number): string {
  return `×${Number(factor.toFixed(2))}`;
}

// 按 key 分组，保持输入（时间）顺序；key 为 null 的记录丢弃。
function groupBy(records: ActivityRecord[], keyOf: (record: ActivityRecord) => string | null): Map<string, ActivityRecord[]> {
  const groups = new Map<string, ActivityRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

// 在按 created_at 升序的数组里找第一个 created_at >= t 的下标。
function lowerBound(sorted: ActivityRecord[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as ActivityRecord).created_at < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 找 sorted 中第一个 created_at > t 的下标。
function upperBound(sorted: ActivityRecord[], t: number): number {
  return lowerBound(sorted, t + 1);
}

// 窗口 [t - window, t + window] 内与 t 最近的记录。
function nearest(sorted: ActivityRecord[], t: number, windowMs: number): { record: ActivityRecord; diff: number } | null {
  const p = lowerBound(sorted, t);
  let best: { record: ActivityRecord; diff: number } | null = null;
  for (const index of [p - 1, p]) {
    const record = sorted[index];
    if (!record) continue;
    const diff = Math.abs(record.created_at - t);
    if (diff <= windowMs && (best === null || diff < best.diff)) best = { record, diff };
  }
  return best;
}

function sharedKeys(a: Map<string, ActivityRecord[]>, b: Map<string, ActivityRecord[]>): string[] {
  return [...a.keys()].filter((key) => b.has(key));
}

function byTime(records: ActivityRecord[]): ActivityRecord[] {
  return [...records].sort((x, y) => x.created_at - y.created_at || x.id - y.id);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 出现次数最多的取值；并列取最近出现的。输入需按时间升序。
function mostCommon(records: ActivityRecord[], keyOf: (record: ActivityRecord) => string | null): { key: string; record: ActivityRecord } | null {
  const stats = new Map<string, { count: number; last: number; record: ActivityRecord }>();
  records.forEach((record, index) => {
    const key = keyOf(record);
    if (key === null) return;
    const stat = stats.get(key);
    if (stat) {
      stat.count += 1;
      stat.last = index;
      stat.record = record;
    } else stats.set(key, { count: 1, last: index, record });
  });
  let best: { key: string; record: ActivityRecord; count: number; last: number } | null = null;
  for (const [key, stat] of stats) {
    if (best === null || stat.count > best.count || (stat.count === best.count && stat.last > best.last)) best = { key, ...stat };
  }
  return best && { key: best.key, record: best.record };
}

// 取前 limit 条记录的 id（输入已按时间升序）。
function firstIds(records: ActivityRecord[] | undefined, limit: number = ANALYSIS_RULES.maxEventsPerSide): number[] {
  return (records ?? []).slice(0, limit).map((record) => record.id);
}

export function analyzeTransfer(input: AnalysisInput): TransferAnalysis {
  const rules = ANALYSIS_RULES;
  const a = byTime(input.source.records.filter((record) => record.event !== 'ADMIN_CHARACTER_TRANSFER'));
  const b = byTime(input.target.records.filter((record) => record.event !== 'ADMIN_CHARACTER_TRANSFER'));
  const found: Evidence[] = [];

  const heatOf = (table: Record<string, number>, key: string): number => table[key] ?? rules.defaultHeat;
  const hostingNets = new Set<string>();
  for (const record of [...a, ...b]) if (record.is_hosting && record.ip_net !== null) hostingNets.add(record.ip_net);
  const ipFactor = (net: string): number => {
    const heat = heatOf(input.heat.ip_net, net);
    const base = heat <= rules.ip.lowMax ? 1 : heat <= rules.ip.midMax ? rules.ip.midFactor : 0;
    return hostingNets.has(net) ? base * rules.ip.hostingFactor : base;
  };

  // 设备系数取自 SAME_DEVICE 的档位比例：热度 ≤ highMax → 1；≤ midMax → midPoints / highPoints；更高视为公共设备 → 0。
  const deviceFactor = (deviceId: string): number => {
    const heat = heatOf(input.heat.device_id, deviceId);
    const tier = rules.device;
    return heat <= tier.highMax ? 1 : heat <= tier.midMax ? tier.midPoints / tier.highPoints : 0;
  };

  const byNetA = groupBy(a, (r) => r.ip_net);
  const byNetB = groupBy(b, (r) => r.ip_net);
  const byDeviceA = groupBy(a, (r) => r.device_id);
  const byDeviceB = groupBy(b, (r) => r.device_id);
  const byFpA = groupBy(a, (r) => r.fingerprint);
  const byFpB = groupBy(b, (r) => r.fingerprint);
  const sharedNets = sharedKeys(byNetA, byNetB);

  // 设备与指纹：取共有项里热度最低的一档给强证据；热度过高的共有项各出一条反向证据。
  const traitRules = (
    strong: RuleId,
    counter: RuleId,
    name: string,
    groupsA: Map<string, ActivityRecord[]>,
    groupsB: Map<string, ActivityRecord[]>,
    heatTable: Record<string, number>,
    tier: { highMax: number; highPoints: number; midMax: number; midPoints: number },
  ): [Evidence[], Evidence[]] => {
    const strongList: Evidence[] = [];
    const counterList: Evidence[] = [];
    const shared = sharedKeys(groupsA, groupsB);
    const idsOf = (key: string) => [...firstIds(groupsA.get(key)), ...firstIds(groupsB.get(key))];
    let lowest: string | null = null;
    for (const key of shared) {
      if (lowest === null || heatOf(heatTable, key) < heatOf(heatTable, lowest)) lowest = key;
      const heat = heatOf(heatTable, key);
      if (heat > tier.midMax) {
        counterList.push(
          evidence(counter, 'counter', 0, idsOf(key), () => `A、B 共有的一${name === '设备' ? '台' : '个'}${name}被 ${heat} 个账号使用过，视为公共${name}，相关证据未计分`),
        );
      }
    }
    if (lowest !== null) {
      const heat = heatOf(heatTable, lowest);
      const points = heat <= tier.highMax ? tier.highPoints : heat <= tier.midMax ? tier.midPoints : 0;
      if (points > 0) {
        const extra = shared.length > 1 ? `，共 ${shared.length} 个共有${name}` : '';
        strongList.push(evidence(strong, 'strong', points, idsOf(lowest), () => `A、B 使用过同一${name}（共 ${heat} 个账号用过它）${extra}`));
      }
    }
    return [strongList, counterList];
  };
  const [sameDevice, commonDevice] = traitRules('SAME_DEVICE', 'COMMON_DEVICE', '设备', byDeviceA, byDeviceB, input.heat.device_id, rules.device);
  const [sameFingerprint, commonFingerprint] = traitRules('SAME_FINGERPRINT', 'COMMON_FINGERPRINT', '指纹', byFpA, byFpB, input.heat.fingerprint, rules.fingerprint);

  // NEAR_SAME_IP：同网段内 A、B 各一条且时间差 ≤ 30 分钟；窗口用二分查找，不做全量配对。
  let nearBest: { net: string; factor: number; diff: number; a: ActivityRecord; b: ActivityRecord } | null = null;
  let nearPairs = 0;
  for (const net of sharedNets) {
    const factor = ipFactor(net);
    if (factor <= 0) continue;
    const listA = byNetA.get(net) as ActivityRecord[];
    const listB = byNetB.get(net) as ActivityRecord[];
    for (const left of listA) {
      const window = rules.nearSameIp.windowMs;
      nearPairs += upperBound(listB, left.created_at + window) - lowerBound(listB, left.created_at - window);
      const hit = nearest(listB, left.created_at, window);
      if (hit && (nearBest === null || factor > nearBest.factor || (factor === nearBest.factor && hit.diff < nearBest.diff))) {
        nearBest = { net, factor, diff: hit.diff, a: left, b: hit.record };
      }
    }
  }
  const nearSameIp: Evidence[] = [];
  if (nearBest !== null) {
    const best = nearBest;
    const scale = best.factor < 1 ? `，按 ${formatFactor(best.factor)} 折算` : '';
    nearSameIp.push(
      evidence('NEAR_SAME_IP', 'strong', rules.nearSameIp.points * best.factor, [best.a.id, best.b.id], (ip) =>
        `A、B 在 ${formatGap(best.diff)} 内先后使用同一 IP（${ip(best.net)}），30 分钟内共 ${nearPairs} 次配对${scale}`,
      ),
    );
  }

  // 角色与 aid。
  const characterAid: Evidence[] = [];
  if (input.target.aids.includes(input.characterAid)) {
    characterAid.push(
      evidence('CHARACTER_AID', 'strong', rules.characterAid.points, b.filter((r) => r.aid === input.characterAid).map((r) => r.id), () =>
        'B 名下也出现过被转移角色所在的游戏账号',
      ),
    );
  }
  const otherAid: Evidence[] = [];
  const sourceAids = new Set(input.source.aids);
  const commonAids = new Set(input.target.aids.filter((aid) => sourceAids.has(aid) && aid !== input.characterAid));
  if (commonAids.size > 0) {
    const ids = [...a, ...b].filter((r) => r.aid !== null && commonAids.has(r.aid)).map((r) => r.id);
    otherAid.push(evidence('OTHER_AID', 'strong', rules.otherAid.points, ids, () => `除被转移角色外，A、B 还共有 ${commonAids.size} 个游戏账号`));
  }

  // 注册链：任一侧的注册记录，与另一侧 24 小时内同网段或同设备的记录。
  interface ChainHit {
    coef: number;
    diff: number;
    r: ActivityRecord;
    o: ActivityRecord;
    via: 'ip' | 'device';
    rSide: 'A' | 'B';
  }
  const chainScan = (
    registers: ActivityRecord[],
    rSide: 'A' | 'B',
    otherNet: Map<string, ActivityRecord[]>,
    otherDevice: Map<string, ActivityRecord[]>,
  ): ChainHit | null => {
    let best: ChainHit | null = null;
    for (const r of registers) {
      if (r.event !== 'REGISTER') continue;
      const candidates: { coef: number; via: 'ip' | 'device'; hit: { record: ActivityRecord; diff: number } | null }[] = [];
      if (r.ip_net !== null) {
        candidates.push({ coef: ipFactor(r.ip_net), via: 'ip', hit: nearest(otherNet.get(r.ip_net) ?? [], r.created_at, rules.registrationChain.windowMs) });
      }
      if (r.device_id !== null) {
        candidates.push({ coef: deviceFactor(r.device_id), via: 'device', hit: nearest(otherDevice.get(r.device_id) ?? [], r.created_at, rules.registrationChain.windowMs) });
      }
      for (const { coef, via, hit } of candidates) {
        if (!hit || coef <= 0) continue;
        if (best === null || coef > best.coef || (coef === best.coef && hit.diff < best.diff)) {
          best = { coef, diff: hit.diff, r, o: hit.record, via, rSide };
        }
      }
    }
    return best;
  };
  const chainA = chainScan(a, 'A', byNetB, byDeviceB);
  const chainB = chainScan(b, 'B', byNetA, byDeviceA);
  const chainBest =
    chainA && chainB ? (chainB.coef > chainA.coef || (chainB.coef === chainA.coef && chainB.diff < chainA.diff) ? chainB : chainA) : (chainA ?? chainB);
  const registrationChain: Evidence[] = [];
  if (chainBest !== null) {
    const best = chainBest;
    const other = best.rSide === 'A' ? 'B' : 'A';
    const direction = best.o.created_at >= best.r.created_at ? '后' : '前';
    const scale = best.coef < 1 ? `，按 ${formatFactor(best.coef)} 折算` : '';
    registrationChain.push(
      evidence('REGISTRATION_CHAIN', 'strong', rules.registrationChain.points * best.coef, [best.r.id, best.o.id], (ip) => {
        const via = best.via === 'ip' ? `同一 IP（${ip(best.r.ip_net as string)}）` : '同一设备';
        return `${other} 在 ${best.rSide} 注册 ${formatGap(best.diff)}${direction}，用${via}${EVENT_VERBS[best.o.event]}${scale}`;
      }),
    );
  }

  // 共同 IP 网段：只对系数 > 0 的计分。
  const sharedIp: Evidence[] = [];
  const scoringNets = sharedNets.filter((net) => ipFactor(net) > 0);
  const sharedRaw = Math.min(rules.sharedIp.maxPoints, scoringNets.reduce((sum, net) => sum + rules.sharedIp.perIpPoints * ipFactor(net), 0));
  if (sharedRaw > 0) {
    const ids = scoringNets.flatMap((net) => [...firstIds(byNetA.get(net), 1), ...firstIds(byNetB.get(net), 1)]);
    sharedIp.push(
      evidence('SHARED_IP', 'strong', sharedRaw, ids, (ip) => {
        const shown = scoringNets.slice(0, 3).map(ip).join('、');
        return `A、B 共有 ${scoringNets.length} 个 IP 网段（${shown}${scoringNets.length > 3 ? ' 等' : ''}）`;
      }),
    );
  }
  const publicIp: Evidence[] = [];
  const hostingIp: Evidence[] = [];
  for (const net of sharedNets) {
    const ids = [...firstIds(byNetA.get(net), 1), ...firstIds(byNetB.get(net), 1)];
    const heat = heatOf(input.heat.ip_net, net);
    if (heat > rules.ip.midMax) {
      publicIp.push(evidence('PUBLIC_IP', 'counter', 0, ids, (ip) => `共有 IP ${ip(net)} 被 ${heat} 个账号使用过，视为公共 IP，相关证据未计分`));
    }
    if (hostingNets.has(net)) {
      hostingIp.push(evidence('HOSTING_IP', 'counter', 0, ids, (ip) => `共有 IP ${ip(net)} 属于机房/VPN，相关加分 ${formatFactor(rules.ip.hostingFactor)}`));
    }
  }

  // 弱证据。
  const mainCity: Evidence[] = [];
  const cityA = mostCommon(a, (r) => (r.city ? r.city.toLowerCase() : null));
  const cityB = mostCommon(b, (r) => (r.city ? r.city.toLowerCase() : null));
  if (cityA && cityB && cityA.key === cityB.key) {
    mainCity.push(evidence('MAIN_CITY', 'weak', rules.mainCity.points, [], () => `A、B 最常出现的城市相同（${cityA.record.city}）`));
  }
  const mainAsn: Evidence[] = [];
  const asnA = mostCommon(a, (r) => (r.asn === null ? null : String(r.asn)));
  const asnB = mostCommon(b, (r) => (r.asn === null ? null : String(r.asn)));
  if (asnA && asnB && asnA.key === asnB.key) {
    const org = asnA.record.as_org ? ` ${asnA.record.as_org}` : '';
    mainAsn.push(evidence('MAIN_ASN', 'weak', rules.mainAsn.points, [], () => `A、B 最常用的运营商相同（AS${asnA.key}${org}）`));
  }
  const sameUa: Evidence[] = [];
  const uaA = groupBy(a, (r) => r.user_agent);
  const uaB = groupBy(b, (r) => r.user_agent);
  const sharedUa = sharedKeys(uaA, uaB)[0];
  if (sharedUa !== undefined) {
    sameUa.push(evidence('SAME_UA', 'weak', rules.sameUa.points, [...firstIds(uaA.get(sharedUa), 1), ...firstIds(uaB.get(sharedUa), 1)], () => 'A、B 出现过完全相同的浏览器 UA'));
  }

  // 反向证据：10 分钟内同时出现在不同国家 / 相距遥远的不同城市。每个 A 记录只扫描 B 的时间窗口。
  const concurrentWindow = rules.concurrent.windowMs;
  let countryPair: { diff: number; a: ActivityRecord; b: ActivityRecord } | null = null;
  let cityPair: { diff: number; a: ActivityRecord; b: ActivityRecord; km: number } | null = null;
  for (const left of a) {
    const lo = lowerBound(b, left.created_at - concurrentWindow);
    const hi = upperBound(b, left.created_at + concurrentWindow);
    for (let index = lo; index < hi; index += 1) {
      const right = b[index] as ActivityRecord;
      const diff = Math.abs(right.created_at - left.created_at);
      if (left.country && right.country && left.country !== right.country) {
        if (countryPair === null || diff < countryPair.diff) countryPair = { diff, a: left, b: right };
        continue;
      }
      if (
        left.city && right.city && left.city.toLowerCase() !== right.city.toLowerCase() &&
        left.latitude !== null && left.longitude !== null && right.latitude !== null && right.longitude !== null
      ) {
        const km = haversineKm(left.latitude, left.longitude, right.latitude, right.longitude);
        if (km >= rules.concurrent.minDistanceKm && (cityPair === null || diff < cityPair.diff)) cityPair = { diff, a: left, b: right, km };
      }
    }
  }
  const concurrentCountry: Evidence[] = [];
  const concurrentCity: Evidence[] = [];
  if (countryPair !== null) {
    const pair = countryPair as NonNullable<typeof countryPair>;
    concurrentCountry.push(
      evidence('CONCURRENT_COUNTRY', 'counter', rules.concurrent.countryPoints, [pair.a.id, pair.b.id], () =>
        `A、B 在 ${formatGap(pair.diff)} 内分别出现在不同国家（${pair.a.country}、${pair.b.country}）`,
      ),
    );
  } else if (cityPair !== null) {
    const pair = cityPair as NonNullable<typeof cityPair>;
    concurrentCity.push(
      evidence('CONCURRENT_CITY', 'counter', rules.concurrent.cityPoints, [pair.a.id, pair.b.id], () =>
        `A、B 在 ${formatGap(pair.diff)} 内分别出现在相距约 ${Math.round(pair.km)} 公里的不同城市（${pair.a.city}、${pair.b.city}）`,
      ),
    );
  }

  // 按设计表顺序汇总，再按 强 → 弱 → 反向 稳定排序。
  found.push(
    ...sameDevice, ...commonDevice, ...sameFingerprint, ...commonFingerprint, ...nearSameIp, ...characterAid, ...otherAid,
    ...registrationChain, ...sharedIp, ...publicIp, ...hostingIp, ...mainCity, ...mainAsn, ...sameUa, ...concurrentCountry, ...concurrentCity,
  );
  const kindOrder: Record<EvidenceKind, number> = { strong: 0, weak: 1, counter: 2 };
  const sorted = found.map((item, index) => ({ item, index })).sort((x, y) => kindOrder[x.item.kind] - kindOrder[y.item.kind] || x.index - y.index).map(({ item }) => item);

  const total = sorted.reduce((sum, item) => sum + item.points, 0);
  const score = Math.min(rules.maxScore, Math.max(0, total));
  const notes: string[] = [];
  if (input.source.truncated) notes.push('账号 A 的日志超过上限，只分析了最近的部分');
  if (input.target.truncated) notes.push('账号 B 的日志超过上限，只分析了最近的部分');
  return {
    score,
    verdict: verdictFor(score, a.length < rules.minRecords || b.length < rules.minRecords),
    evidence: sorted,
    notes,
  };
}
