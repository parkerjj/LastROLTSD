import type { MysqlDatabase } from '../db/mysql-client';

/** KE 权益：实例额度与可用模块，均由 ke_entitlements 流水按「当前时刻」实时求和得出。 */

/** 「永久」权益的有效期：99 年。 */
export const KE_PERMANENT_MS = 99 * 365 * 24 * 60 * 60 * 1000;

export const KE_RESOURCE_SLOTS = 'slots';
export const KE_MODULE_PREFIX = 'module:';
export const KE_CORE_MODULE = 'core';

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
