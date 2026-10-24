export type UserId = string;
export type AccountStatus = 'PENDING_EMAIL' | 'ACTIVE' | 'DISABLED';
export type ActionPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD';
export type MailPurpose = ActionPurpose | 'PASSWORD_CHANGED';
export type CsrfMode = 'anonymous' | 'session';
export type PasswordScheme = 'hmac-sha256-v1';
export type AuthFailureStatus = 400 | 401 | 403 | 404 | 413 | 415 | 429 | 503;

export type AuthRateLimitRule =
  | { kind: 'window'; scope: string; keyDigest: Uint8Array; limit: number; windowMs: number }
  | { kind: 'cooldown'; scope: 'mail_cooldown'; keyDigest: Uint8Array; cooldownMs: number };

export interface AccountProfile {
  id: UserId;
  email: string;
  display_name: string;
  status: AccountStatus;
  /** 账号等级：0 萌新 / 1 正式（邮箱已验证）/ 2 赞助 / >=100 管理员 */
  permission_level: number;
  email_verified_at: number | null;
  created_at: number;
  has_avatar: boolean;
  avatar_version: number;
  avatar_url: string;
}

export interface AuthIdentity {
  userId: UserId;
  status: AccountStatus;
  credentialVersion: number;
  authVersion: number;
  sessionDigest: Uint8Array;
}

export interface MailAvailability {
  code: 'AVAILABLE' | 'MAIL_DAILY_QUOTA' | 'MAIL_MONTHLY_QUOTA';
  retry_at: number | null;
}

export interface MailAttemptContext {
  reservedAt: number;
  dayBucketStart: number;
  monthBucketStart: number;
}

export type MailReservation =
  | { status: 'reserved'; attempt: MailAttemptContext }
  | { status: 'quota' | 'stale' | 'exhausted' };

export interface AuthAcceptedResponse {
  accepted: true;
  mail_availability: MailAvailability;
}

export interface AuthSessionResponse {
  user: AccountProfile;
  expires_at: number;
  csrf_token: string;
  mail_availability: MailAvailability | null;
}

export interface AuthRuntime {
  now: () => number;
  fetch: typeof globalThis.fetch;
  /** Called after an outbox row commits so delivery starts now rather than at the next Cron tick. */
  wakeMail?: () => void;
}

export interface MailDeliveryConfig {
  apiKey: string | null;
  from: string | null;
  replyTo: string | null;
}

export interface MailPayloadContext {
  mailId: string;
  purpose: MailPurpose;
}

export interface SealedMailPayload {
  payloadCiphertext: string;
  payloadIv: string;
  payloadKeyVersion: string;
}

export class AuthFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status: AuthFailureStatus,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AuthFailure';
  }
}

export interface AuthBindings {
  AUTH_ENABLED?: string | undefined;
  AUTH_SITE_URL?: string | undefined;
  AUTH_PASSWORD_SECRET?: string | undefined;
  AUTH_PASSWORD_KEY_VERSION?: string | undefined;
  AUTH_PASSWORD_PREVIOUS_KEY_VERSION?: string | undefined;
  AUTH_PASSWORD_PREVIOUS_SECRET?: string | undefined;
  AUTH_CSRF_SECRET?: string | undefined;
  AUTH_RATE_SECRET?: string | undefined;
  AUTH_MAIL_PAYLOAD_SECRET?: string | undefined;
  AUTH_MAIL_PAYLOAD_KEY_VERSION?: string | undefined;
  AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION?: string | undefined;
  AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  MAIL_FROM?: string | undefined;
  MAIL_REPLY_TO?: string | undefined;
  AUTH_MAIL_DAILY_LIMIT?: string | undefined;
  AUTH_MAIL_MONTHLY_LIMIT?: string | undefined;
}

interface AuthConfigKeyVersions {
  passwordKeys: ReadonlyMap<string, Uint8Array>;
  mailPayloadKeys: ReadonlyMap<string, Uint8Array>;
  currentPasswordKeyVersion: string;
  currentMailPayloadKeyVersion: string;
  mailDailyLimit: number;
  mailMonthlyLimit: number;
  mailDelivery?: MailDeliveryConfig;
}

export interface DisabledAuthConfig extends AuthConfigKeyVersions {
  enabled: false;
  mysqlUrl: null;
  authSiteUrl: null;
  csrfSecret: null;
  rateSecret: null;
}

export interface EnabledAuthConfig extends AuthConfigKeyVersions {
  enabled: true;
  mysqlUrl: string | null;
  authSiteUrl: string;
  csrfSecret: Uint8Array;
  rateSecret: Uint8Array;
}

export type AuthConfig = DisabledAuthConfig | EnabledAuthConfig;

export interface PasswordMaterial {
  scheme: PasswordScheme;
  salt: Uint8Array;
  digest: Uint8Array;
  keyVersion: string;
}

export interface CredentialSnapshot {
  userId: UserId;
  status: AccountStatus;
  credentialVersion: number;
  authVersion: number;
  scheme: string;
  salt: Uint8Array;
  digest: Uint8Array;
  keyVersion: string;
}

export interface NewMailJob extends SealedMailPayload {
  id: string;
  actionDigest: Uint8Array | null;
  userId: UserId | null;
  purpose: MailPurpose;
  priority: 0 | 1;
  createdAt: number;
  expiresAt: number;
}

export interface ClaimedMailJob extends NewMailJob {
  state: 'CLAIMED';
  leaseId: string;
  leaseUntil: number;
  attemptCount: number;
  nextAttemptAt: number;
  firstAttemptAt: number | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
}
