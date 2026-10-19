/** 账号等级徽章：取值对应 auth_users.permission_level（0 萌新 / 1 正式 / 2 赞助 / >=100 管理员）。 */
export interface TierBadge {
  readonly label: string;
  readonly cls: string;
}

export function tierBadge(permission_level: number): TierBadge {
  if (permission_level >= 100) return { label: "管理员", cls: "gb-badge--admin" };
  if (permission_level === 2) return { label: "赞助用户", cls: "gb-badge--sponsor" };
  if (permission_level === 1) return { label: "正式用户", cls: "gb-badge--verified" };
  return { label: "萌新用户", cls: "gb-badge--newbie" };
}
