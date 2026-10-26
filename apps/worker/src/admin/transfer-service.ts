import type { ActivityRepository } from '../activity/repository';
import { EMPTY_NETWORK, type ActivityEvent, type ActivityRecord, type ActivityResult } from '../activity/types';
import { analyzeTransfer, type AnalysisSide, type TransferAnalysis } from './transfer-analysis';
import type { TransferCharacter, TransferRepository } from './transfer-repository';
import { AdminFailure, type AdminUserRow } from './types';

/** 每个账号读取的日志条数上限；超出时分析里会注明只看了最近的部分。 */
export const TRANSFER_LOG_LIMIT = 2000;

const MAX_NOTE_LENGTH = 200;
const MAX_PROFILE_NAME_LENGTH = 64;
const RENAME_SUFFIX = '（转移）';

export interface TimelineRow {
  id: number;
  side: 'source' | 'target';
  event: ActivityEvent;
  result: ActivityResult;
  created_at: number;
  source: 'live' | 'backfill';
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  as_org: string | null;
  is_hosting: boolean;
  /** 指纹 / 设备 ID 只展示前 4 个字符。 */
  fingerprint_short: string | null;
  device_short: string | null;
  aid: number | null;
}

export interface TransferPreview {
  source: AdminUserRow;
  target: AdminUserRow;
  character: TransferCharacter;
  analysis: TransferAnalysis;
  timeline: TimelineRow[];
}

export interface TransferRequest {
  source: string;
  target: string;
  aid: number;
  cid: number;
  nid: number;
}

export interface TransferResult {
  moved_profile_ids: number[];
  detached_share_ids: number[];
}

function badRequest(message: string): AdminFailure {
  return new AdminFailure('ADMIN_BAD_REQUEST', 400, message);
}

function userNotFound(): AdminFailure {
  return new AdminFailure('ADMIN_USER_NOT_FOUND', 404, '账号不存在');
}

function characterNotFound(): AdminFailure {
  return new AdminFailure('ADMIN_CHARACTER_NOT_FOUND', 404, '角色不存在或已不属于源账号，请重新查询');
}

function validateNote(note: string): string {
  const trimmed = note.trim();
  const length = [...trimmed].length;
  if (length === 0 || length > MAX_NOTE_LENGTH) throw badRequest('请填写审核备注（最多 200 字）');
  return trimmed;
}

// 配置名唯一键使用 utf8mb4_0900_ai_ci（不分大小写和重音）：这里用相近的规则判断重名，宁可多改名也不撞唯一键。
function nameKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// 搬过来的配置与目标账号已有名称冲突时改名为「名称（转移）」「名称（转移2）」…，总长不超过 64 个码点。
function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let attempt = 1; taken.has(nameKey(candidate)); attempt += 1) {
    const suffix = attempt === 1 ? RENAME_SUFFIX : `（转移${attempt}）`;
    const base = [...name].slice(0, MAX_PROFILE_NAME_LENGTH - [...suffix].length).join('');
    candidate = `${base}${suffix}`;
  }
  taken.add(nameKey(candidate));
  return candidate;
}

function shortOf(value: string | null): string | null {
  return value === null ? null : [...value].slice(0, 4).join('');
}

function timelineRow(record: ActivityRecord, side: 'source' | 'target'): TimelineRow {
  return {
    id: record.id, side, event: record.event, result: record.result, created_at: record.created_at, source: record.source,
    ip: record.ip, country: record.country, region: record.region, city: record.city, as_org: record.as_org, is_hosting: record.is_hosting,
    fingerprint_short: shortOf(record.fingerprint), device_short: shortOf(record.device_id), aid: record.aid,
  };
}

export function createTransferService(repository: TransferRepository, activity: ActivityRepository, now: () => number = () => Date.now()) {
  async function requireUser(account: string): Promise<AdminUserRow> {
    const user = await repository.resolveUser(account);
    if (!user) throw userNotFound();
    return user;
  }

  async function sideOf(user: AdminUserRow): Promise<AnalysisSide> {
    const { records, truncated } = await activity.listForUser(user.id, TRANSFER_LOG_LIMIT);
    const aids = new Set<number>(await repository.listAids(user.id));
    for (const record of records) if (record.aid !== null) aids.add(record.aid);
    return { userId: user.id, records, truncated, aids: [...aids] };
  }

  // 只对两侧共有的 IP 段 / 设备 / 指纹查热度（有多少个账号出现过），其余用算法默认值。
  async function heatOf(source: AnalysisSide, target: AnalysisSide) {
    const heat = { ip_net: {} as Record<string, number>, device_id: {} as Record<string, number>, fingerprint: {} as Record<string, number> };
    const valuesOf = (side: AnalysisSide, field: keyof typeof heat) => new Set(side.records.map((record) => record[field]).filter((value): value is string => value !== null));
    for (const field of ['ip_net', 'device_id', 'fingerprint'] as const) {
      const targetValues = valuesOf(target, field);
      const common = [...valuesOf(source, field)].filter((value) => targetValues.has(value));
      const counts = await Promise.all(common.map((value) => activity.countUsers(field, value)));
      common.forEach((value, index) => { heat[field][value] = counts[index]!; });
    }
    return heat;
  }

  // 预览和确认共用：解析账号、校验、读取日志并分析。
  async function prepare(request: TransferRequest): Promise<TransferPreview> {
    const [source, target] = [await requireUser(request.source), await requireUser(request.target)];
    if (source.id === target.id) throw badRequest('源账号和目标账号不能相同');
    if (target.status !== 'ACTIVE' || target.email_verified_at === null) throw badRequest('目标账号必须是已验证邮箱的正常账号');
    const found = await repository.findCharacter(request.aid, request.cid, request.nid);
    if (!found || found.user_id !== source.id) throw characterNotFound();
    const { user_id: _owner, ...character } = found;

    const [sourceSide, targetSide] = [await sideOf(source), await sideOf(target)];
    const analysis = analyzeTransfer({ source: sourceSide, target: targetSide, characterAid: request.aid, heat: await heatOf(sourceSide, targetSide) });
    const timeline = [
      ...sourceSide.records.map((record) => timelineRow(record, 'source')),
      ...targetSide.records.map((record) => timelineRow(record, 'target')),
    ].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    return { source, target, character, analysis, timeline };
  }

  return {
    async listCharacters(account: string): Promise<{ user: AdminUserRow; characters: TransferCharacter[] }> {
      const user = await requireUser(account);
      return { user, characters: await repository.listCharacters(user.id) };
    },

    preview: prepare,

    async confirm(actorId: number, request: TransferRequest & { note: string }, requestId: string): Promise<TransferResult> {
      const note = validateNote(request.note);
      // 不信任前端传来的分数：事务外重新算一次分析，快照存这一份。
      const { source, target, character, analysis } = await prepare(request);
      const at = now();
      const { aid, cid, nid } = request;

      return repository.transaction(async (tx) => {
        await tx.lockUsers([source.id, target.id]);
        const locked = await tx.lockCharacter(aid, cid, nid);
        if (!locked || locked.user_id !== source.id) throw characterNotFound();
        await tx.moveCharacter(aid, cid, nid, target.id, at);

        const moving = await tx.listProfilesForUpdate(source.id, aid, cid, nid);
        const existing = await tx.listProfilesForUpdate(target.id, aid, cid, nid);
        const taken = new Set(existing.map((profile) => nameKey(profile.name)));
        const targetHasActive = existing.some((profile) => profile.is_active);
        for (const profile of moving) {
          const name = uniqueName(profile.name, taken);
          await tx.moveProfile(profile.id, target.id, name, targetHasActive ? false : profile.is_active, at);
        }
        const movedProfileIds = moving.map((profile) => profile.id);
        const detachedShareIds = await tx.detachShares(movedProfileIds);

        // 永久保存的快照：证据只存脱敏文案（字段名 text），不含完整 IP、设备 ID、指纹。
        await tx.insertAudit({
          actor_user_id: actorId, action: 'CHARACTER_TRANSFER', target_user_id: source.id, request_id: requestId, created_at: at,
          detail: {
            from_user_id: source.id, to_user_id: target.id, aid, cid, nid, char_name: character.char_name, note,
            analysis: {
              score: analysis.score,
              verdict: analysis.verdict,
              notes: analysis.notes,
              evidence: analysis.evidence.map(({ rule, kind, points, redacted_text }) => ({ rule, kind, points, text: redacted_text })),
            },
            moved_profile_ids: movedProfileIds,
            detached_share_ids: detachedShareIds,
          },
        });
        for (const userId of [source.id, target.id]) {
          await tx.insertActivity({
            ...EMPTY_NETWORK, user_id: userId, event: 'ADMIN_CHARACTER_TRANSFER', result: 'SUCCESS',
            aid, cid, nid, ref: requestId, source: 'live', request_id: requestId, created_at: at,
          });
        }
        return { moved_profile_ids: movedProfileIds, detached_share_ids: detachedShareIds };
      });
    },
  };
}

export type TransferService = ReturnType<typeof createTransferService>;
