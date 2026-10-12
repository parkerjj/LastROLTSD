export type UserId = string;
export type AccountStatus = 'PENDING_EMAIL' | 'ACTIVE' | 'DISABLED';
export type ActionPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD';
export type MailPurpose = ActionPurpose | 'PASSWORD_CHANGED';
export type CsrfMode = 'anonymous' | 'session';
export type PasswordScheme = 'hmac-sha256-v1';
export type AuthFailureStatus = 400 | 401 | 403 | 404 | 413 | 415 | 429 | 503;

export interface AccountProfile {
  id: UserId;
  email: string;
  display_name: string;
  status: AccountStatus;
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
}

interface AuthConfigKeyVersions {
  passwordKeys: ReadonlyMap<string, Uint8Array>;
  mailPayloadKeys: ReadonlyMap<string, Uint8Array>;
  currentPasswordKeyVersion: string;
  currentMailPayloadKeyVersion: string;
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
  mysqlUrl: string;
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

export interface NewMailJob {
  payloadKeyVersion: string;
}

export interface ClaimedMailJob {
  payloadKeyVersion: string;
}
