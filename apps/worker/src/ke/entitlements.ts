import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';

/** KE 权益：实例额度与可用模块，均由 ke_entitlements 流水按「当前时刻」实时求和得出。 */

/** 「永久」权益的有效期：99 年。 */
export const KE_PERMANENT_MS = 99 * 365 * 24 * 60 * 60 * 1000;

export const KE_RESOURCE_SLOTS = 'slots';
export const KE_MODULE_PREFIX = 'module:';
export const KE_CORE_MODULE = 'core';
/** 脱机版模块：允许 bind 下发 network 模块密钥，并在 license.key_versions 里带 network。 */
export const KE_STANDALONE_MODULE = 'standalone';

export interface KeEntitlements {
  /** auto 实例额度；负数流水可能让总和为负，这里钳到 0。 */
  slots: number;
  /** 生效中的模块名（不含 `module:` 前缀）。 */
  modules: ReadonlySet<string>;
}

export interface ResourceTotal {
  resource: string;
  total: number;
}

/** 把「有效流水按 resource 求和」的结果折算成权益：额度钳到 0，模块总和 > 0 才生效。 */
export function foldEntitlements(totals: readonly ResourceTotal[]): KeEntitlements {
  let slots = 0;
  const modules = new Set<string>();
  for (const { resource, total } of totals) {
    if (resource === KE_RESOURCE_SLOTS) slots = Math.max(0, total);
    else if (resource.startsWith(KE_MODULE_PREFIX) && total > 0) modules.add(resource.slice(KE_MODULE_PREFIX.length));
  }
  return { slots, modules };
}

/**
 * 账号在 now 时刻生效的额度与模块：对有效流水（未撤销、starts_at <= now < expires_at）在 SQL 里按 resource 求和后折算。
 * KE 授权与管理后台共用这一个查询，口径保持一致，也不受任何展示用的分页 / 截断影响。
 */
export async function queryEntitlements(db: MysqlDatabase, userId: number, now: number): Promise<KeEntitlements> {
  const rows = await db.all<MysqlRow>(
    'SELECT resource, SUM(quantity) AS total FROM ke_entitlements WHERE user_id = ? AND starts_at <= ? AND expires_at > ? AND revoked_at IS NULL GROUP BY resource',
    [userId, now, now],
  );
  return foldEntitlements(rows.map((row) => ({ resource: String(row.resource), total: Number(row.total) })));
}

/**
 * 邮箱验证成功时赠送：1 个额度 + 核心模块，均为 99 年。
 * 调用方须在「验证邮箱」的同一事务里调用；(user_id, source, source_ref) 唯一键保证重复调用不会重复赠送。
 */
export async function grantSignupEntitlements(db: MysqlDatabase, userId: string, at: number): Promise<void> {
  const expiresAt = at + KE_PERMANENT_MS;
  await db.run(
    `INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, created_at)
     VALUES (?, ?, 1, ?, ?, 'signup', 'email-verified:slots', ?), (?, ?, 1, ?, ?, 'signup', 'email-verified:module:core', ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [userId, KE_RESOURCE_SLOTS, at, expiresAt, at, userId, `${KE_MODULE_PREFIX}${KE_CORE_MODULE}`, at, expiresAt, at],
  );
}
