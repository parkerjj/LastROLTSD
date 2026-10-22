import { KE_PERMANENT_MS } from '../ke/entitlements';
import { AdminFailure } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DELTA = 1000;
const MAX_DURATION_DAYS = 36_500;
const MAX_NOTE_LENGTH = 200;
const RESOURCE_PATTERN = /^(slots|module:[a-z][a-z0-9_]{0,31})$/u;

export interface AdjustInput {
  resource: string;
  delta: number;
  expiresAt: number;
  note: string | null;
}

export interface EditInput {
  expiresAt?: number;
  revoked?: boolean;
}

function badRequest(message = '请求字段无效'): AdminFailure {
  return new AdminFailure('ADMIN_BAD_REQUEST', 400, message);
}

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badRequest();
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw badRequest();
  return body;
}

function safeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw badRequest();
  return value;
}

/** 赠送 / 扣减：resource + 非零整数 delta + 恰好一种有效期（永久 / 天数 / 到期时间）+ 可选备注。 */
export function parseAdjustInput(raw: unknown, now: number): AdjustInput {
  const body = record(raw, ['resource', 'delta', 'permanent', 'duration_days', 'expires_at', 'note']);
  if (typeof body.resource !== 'string' || !RESOURCE_PATTERN.test(body.resource)) throw badRequest('资源类型无效');
  const delta = safeInteger(body.delta);
  if (delta === 0 || Math.abs(delta) > MAX_DELTA) throw badRequest(`数量须为非零整数，绝对值不超过 ${MAX_DELTA}`);

  const given = ['permanent', 'duration_days', 'expires_at'].filter((key) => body[key] !== undefined);
  if (given.length !== 1) throw badRequest('有效期须且仅须指定一种：permanent / duration_days / expires_at');
  let expiresAt: number;
  if (body.permanent !== undefined) {
    if (body.permanent !== true) throw badRequest();
    expiresAt = now + KE_PERMANENT_MS;
  } else if (body.duration_days !== undefined) {
    const days = safeInteger(body.duration_days);
    if (days < 1 || days > MAX_DURATION_DAYS) throw badRequest('天数需在 1 到 36500 之间');
    expiresAt = now + days * DAY_MS;
  } else {
    expiresAt = safeInteger(body.expires_at);
    if (expiresAt <= now || expiresAt > now + KE_PERMANENT_MS) throw badRequest('到期时间必须晚于当前时间，且不超过 99 年');
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw badRequest();
    const trimmed = body.note.trim();
    if ([...trimmed].length > MAX_NOTE_LENGTH) throw badRequest(`备注不能超过 ${MAX_NOTE_LENGTH} 个字符`);
    note = trimmed === '' ? null : trimmed;
  }
  return { resource: body.resource, delta, expiresAt, note };
}

/** 修改权益：可改到期时间和 / 或撤销状态，至少给一项。 */
export function parseEditInput(raw: unknown): EditInput {
  const body = record(raw, ['expires_at', 'revoked']);
  const result: EditInput = {};
  if (body.expires_at !== undefined) result.expiresAt = safeInteger(body.expires_at);
  if (body.revoked !== undefined) {
    if (typeof body.revoked !== 'boolean') throw badRequest();
    result.revoked = body.revoked;
  }
  if (result.expiresAt === undefined && result.revoked === undefined) throw badRequest('没有需要修改的内容');
  return result;
}
