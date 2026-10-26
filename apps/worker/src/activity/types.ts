// 账号操作日志的公共类型。日志保留期 180 天。
export const ACTIVITY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export type ActivityEvent =
  | 'REGISTER'
  | 'EMAIL_VERIFIED'
  | 'LOGIN'
  | 'PASSWORD_RESET_REQUEST'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGE'
  | 'KE_DEVICE_APPROVE'
  | 'KE_DEVICE_TOKEN'
  | 'KE_BIND'
  | 'KE_START'
  | 'KE_HEARTBEAT'
  | 'GUESTBOOK_POST'
  | 'GUESTBOOK_REPLY'
  | 'ADMIN_CHARACTER_TRANSFER';

export type ActivityResult = 'SUCCESS' | 'FAILURE';

/**
 * 未经身份验证的尝试：只要知道邮箱就能以任意账号的名义产生（登录失败、申请找回密码）。
 * 这类记录保留在时间线里供人工查看，但不能作为账号归属的证据，也不计入热度统计。
 */
export function isUnauthenticatedAttempt(record: { event: ActivityEvent; result: ActivityResult }): boolean {
  return (record.event === 'LOGIN' && record.result === 'FAILURE') || record.event === 'PASSWORD_RESET_REQUEST';
}

export interface ActivityNetwork {
  ip: string | null;
  ip_net: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  as_org: string | null;
  is_hosting: boolean;
  device_id: string | null;
  fingerprint: string | null;
  user_agent: string | null;
}

export const EMPTY_NETWORK: ActivityNetwork = {
  ip: null,
  ip_net: null,
  country: null,
  region: null,
  city: null,
  latitude: null,
  longitude: null,
  asn: null,
  as_org: null,
  is_hosting: false,
  device_id: null,
  fingerprint: null,
  user_agent: null,
};

export interface ActivityCharacter {
  aid: number;
  cid: number;
  nid: number;
}

export interface ActivityRow extends ActivityNetwork {
  user_id: number;
  event: ActivityEvent;
  result: ActivityResult;
  aid: number | null;
  cid: number | null;
  nid: number | null;
  ref: string | null;
  source: 'live' | 'backfill';
  request_id: string | null;
  created_at: number;
}

export interface ActivityRecord extends ActivityRow {
  id: number;
}
