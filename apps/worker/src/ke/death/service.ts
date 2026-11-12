import { KeFailure } from '../types';
import type { ProfileService } from '../profile-service';
import type { DeathRepository, DeathRow } from './repository';
import { assertSafePatch } from './config-patch';
import type { ConfigPatch, DeathFix, FixesState } from './types';

export const MAX_REPORT_BYTES = 256 * 1024;
const LIST_LIMIT = 100;
const DAY_MS = 24 * 3600 * 1000;

const KNOWN_ITEMS: Record<string, number> = { 苍蝇翅膀: 601, 蝴蝶翅膀: 602, 红色药水: 501, 橙色药水: 502, 黄色药水: 503, 白色药水: 504, 蓝色药水: 505 };
export const itemIdOf = (name: string): number | null => KNOWN_ITEMS[name] ?? null;

const bad = (message = '死亡报告格式无效') => new KeFailure('KE_BAD_REQUEST', 400, message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): string => (typeof value === 'string' && value.length <= max ? value : '');

function validPatch(value: unknown): value is ConfigPatch {
  if (!shapeOk(value)) return false;
  try {
    assertSafePatch(value as ConfigPatch);
    return true;
  } catch {
    return false;
  }
}

function shapeOk(value: unknown): boolean {
  if (!isObject(value)) return false;
  const opt = (v: unknown) => v === null || typeof v === 'string';
  if (value.op === 'setKey') return value.file === 'config.txt' && typeof value.key === 'string' && opt(value.expected) && opt(value.value);
  if (value.op === 'upsertLine') return value.file === 'mon_control.txt' && typeof value.first === 'string' && opt(value.expected) && opt(value.line);
  if (value.op === 'upsertBlock') {
    return value.file === 'config.txt' && typeof value.block === 'string' && typeof value.selector === 'string'
      && (value.expected === null || (isObject(value.expected) && Object.values(value.expected).every(opt)))
      && (value.fields === null || (Array.isArray(value.fields) && value.fields.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string' && typeof f[1] === 'string')));
  }
  return false;
}

export interface ParsedReport {
  reportKey: string;
  diedAt: number;
  map: string;
  killerMobId: number | null;
  killerSkillId: number | null;
  killerName: string;
  skillName: string;
  cause: string;
  causeLabel: string;
  fixesTotal: number;
}

/** 只校验并提取索引字段；报告其余部分原样存取。 */
export function parseReport(report: unknown): ParsedReport {
  if (!isObject(report) || report.reportVersion !== 1) throw bad();
  const id = str(report.id, 64);
  if (!/^[\w-]+$/u.test(id)) throw bad();
  if (typeof report.atMs !== 'number' || !Number.isSafeInteger(report.atMs) || report.atMs < 0) throw bad();
  if (!isObject(report.map) || !isObject(report.killer) || typeof report.cause !== 'string') throw bad();
  const fixes = report.fixes;
  if (!Array.isArray(fixes) || fixes.length > 8) throw bad();
  for (const fix of fixes) {
    if (!isObject(fix) || typeof fix.id !== 'string' || !/^f\d$/u.test(fix.id)) throw bad();
    if (fix.patch != null && !validPatch(fix.patch)) throw bad();
  }
  const optInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  return {
    reportKey: id, diedAt: report.atMs, map: str(report.map.name, 32).replace(/[^\w.-]/gu, ''),
    killerMobId: optInt(report.killer.mobId), killerSkillId: optInt(report.killer.skillId),
    killerName: str(report.killer.name, 64), skillName: str(report.killer.skillName, 64),
    cause: str(report.cause, 32), causeLabel: str(report.causeLabel, 32), fixesTotal: fixes.length,
  };
}

export interface DeathListItem {
  reportKey: string;
  diedAt: number;
  map: string;
  killerName: string;
  skillName: string;
  causeLabel: string;
  fixesTotal: number;
  fixesApplied: number;
}

export interface DeathListResponse {
  items: DeathListItem[];
  stats: {
    last7Days: number;
    perDay7: number[];
    topKiller: { name: string; count: number } | null;
    topCause: { label: string; count: number } | null;
    fixesApplied: number;
    fixesTotal: number;
  };
  profileName: string | null;
}

function top(counts: Map<string, number>): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of counts) if (name !== '' && (best === null || count > best.count)) best = { name, count };
  return best;
}

export function summarize(rows: DeathRow[], now: number): DeathListResponse['stats'] {
  const perDay7 = [0, 0, 0, 0, 0, 0, 0];
  const killers = new Map<string, number>();
  const causes = new Map<string, number>();
  let last7Days = 0;
  let fixesApplied = 0;
  let fixesTotal = 0;
  for (const row of rows) {
    const age = Math.floor((now - row.diedAt) / DAY_MS);
    if (age < 0 || age > 6) continue;
    last7Days += 1;
    perDay7[6 - age]! += 1;
    killers.set(row.killerName, (killers.get(row.killerName) ?? 0) + 1);
    causes.set(row.causeLabel, (causes.get(row.causeLabel) ?? 0) + 1);
    fixesApplied += row.fixesApplied;
    fixesTotal += row.fixesTotal;
  }
  const killer = top(killers);
  const cause = top(causes);
  return { last7Days, perDay7, topKiller: killer, topCause: cause === null ? null : { label: cause.name, count: cause.count }, fixesApplied, fixesTotal };
}

export interface DeathService {
  ingest(userId: string, instanceId: string, report: unknown): Promise<{ stored: boolean }>;
  list(userId: string, instanceId: string): Promise<DeathListResponse>;
  get(userId: string, instanceId: string, reportKey: string): Promise<{ report: unknown; fixesState: FixesState }>;
  applyFix(userId: string, instanceId: string, reportKey: string, fixId: string, action: 'apply' | 'undo'): Promise<{ fixesState: FixesState; notify: string[] }>;
  /** 脱机 App 用：直接对角色当前配置应用补丁。 */
  patchActive(userId: string, aid: number, cid: number, nid: number, patch: ConfigPatch): Promise<{ revert: ConfigPatch; profileName: string }>;
  adminStats(days: 7 | 30): Promise<Awaited<ReturnType<DeathRepository['stats']>>>;
  prune(): Promise<void>;
}

export function createDeathService(deps: {
  repository: DeathRepository;
  profiles: Pick<ProfileService, 'patchActive' | 'activeName'>;
  now: () => number;
}): DeathService {
  const { repository, profiles, now } = deps;

  const owned = async (userId: string, instanceId: string) => {
    const hosted = await repository.findHosted(instanceId);
    if (hosted === null || hosted.userId !== Number(userId)) throw new KeFailure('KE_INSTANCE_NOT_FOUND', 404, '托管实例不存在');
    return hosted;
  };

  const parseState = (row: DeathRow): FixesState => {
    if (row.fixesStateJson === null) return {};
    try {
      const parsed: unknown = JSON.parse(row.fixesStateJson);
      return isObject(parsed) ? (parsed as FixesState) : {};
    } catch {
      return {};
    }
  };

  return {
    async ingest(userId, instanceId, report) {
      const hosted = await repository.findHosted(instanceId);
      if (hosted === null || hosted.userId !== Number(userId)) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前授权');
      const json = JSON.stringify(report);
      if (json.length > MAX_REPORT_BYTES) throw new KeFailure('KE_BAD_REQUEST', 413, '死亡报告过大');
      const parsed = parseReport(report);
      const stored = await repository.insert({
        userId: hosted.userId, instanceId, nid: hosted.nid, aid: hosted.aid, cid: hosted.cid, ...parsed, reportJson: json,
      }, now());
      return { stored };
    },

    async list(userId, instanceId) {
      const hosted = await owned(userId, instanceId);
      const rows = await repository.list(instanceId, LIST_LIMIT);
      return {
        items: rows.map((row) => ({
          reportKey: row.reportKey, diedAt: row.diedAt, map: row.map, killerName: row.killerName, skillName: row.skillName,
          causeLabel: row.causeLabel, fixesTotal: row.fixesTotal, fixesApplied: row.fixesApplied,
        })),
        stats: summarize(rows, now()),
        profileName: await profiles.activeName(userId, hosted.aid, hosted.cid, hosted.nid),
      };
    },

    async get(userId, instanceId, reportKey) {
      await owned(userId, instanceId);
      const row = await repository.get(instanceId, reportKey);
      if (row === null) throw new KeFailure('KE_NOT_FOUND', 404, '死亡报告不存在');
      return { report: JSON.parse(row.reportJson) as unknown, fixesState: parseState(row) };
    },

    async applyFix(userId, instanceId, reportKey, fixId, action) {
      const hosted = await owned(userId, instanceId);
      const row = await repository.get(instanceId, reportKey);
      if (row === null) throw new KeFailure('KE_NOT_FOUND', 404, '死亡报告不存在');
      const state = parseState(row);
      const report = JSON.parse(row.reportJson) as { fixes?: DeathFix[] };
      const fix = report.fixes?.find((candidate) => candidate.id === fixId);
      if (!fix) throw new KeFailure('KE_NOT_FOUND', 404, '建议不存在');
      let patch: ConfigPatch;
      if (action === 'apply') {
        if (!fix.patch) throw bad('这条建议只是说明，没有可应用的配置改动');
        if (state[fixId]?.status === 'applied') throw new KeFailure('KE_CONFLICT', 409, '这条建议已经应用过了');
        patch = fix.patch;
      } else {
        const current = state[fixId];
        if (current?.status !== 'applied') throw new KeFailure('KE_CONFLICT', 409, '这条建议还没有应用，无法撤销');
        patch = current.revert;
      }
      const result = await profiles.patchActive(userId, hosted.aid, hosted.cid, hosted.nid, patch, itemIdOf);
      state[fixId] = { status: action === 'apply' ? 'applied' : 'reverted', at: now(), revert: result.revert };
      const applied = Object.values(state).filter((entry) => entry.status === 'applied').length;
      await repository.setFixesState(row.id, JSON.stringify(state), applied);
      const synced = await repository.requestConfigSync(instanceId, now());
      return { fixesState: state, notify: synced && hosted.assignedAgent ? [hosted.assignedAgent] : [] };
    },

    async patchActive(userId, aid, cid, nid, patch) {
      if (!validPatch(patch)) throw bad('补丁格式无效');
      const result = await profiles.patchActive(userId, aid, cid, nid, patch, itemIdOf);
      return { revert: result.revert, profileName: result.profileName };
    },

    adminStats: (days) => repository.stats(now() - days * DAY_MS),
    prune: () => repository.prune(now()),
  };
}
