/** 账号等级徽章：取值对应 auth_users.admin（0 萌新 / 1 正式 / 2 赞助 / >=100 管理员）。 */
export interface TierBadge {
  readonly label: string;
  readonly cls: string;
}

export function tierBadge(admin: number): TierBadge {
  if (admin >= 100) return { label: "管理员", cls: "gb-badge--admin" };
  if (admin === 2) return { label: "赞助用户", cls: "gb-badge--sponsor" };
  if (admin === 1) return { label: "正式用户", cls: "gb-badge--verified" };
  return { label: "萌新用户", cls: "gb-badge--newbie" };
}
