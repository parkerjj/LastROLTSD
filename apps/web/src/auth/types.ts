export type UserId = string;
export type AccountStatus = 'PENDING_EMAIL' | 'ACTIVE' | 'DISABLED';

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

export interface MailAvailability {
  code: 'AVAILABLE' | 'MAIL_DAILY_QUOTA' | 'MAIL_MONTHLY_QUOTA';
  retry_at: number | null;
}

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

export interface AuthCsrfResponse {
  csrf_token: string;
}

export interface AuthSessionRefreshResponse {
  expires_at: number;
  csrf_token: string;
}

export type EmailVerificationRequestResponse =
  | AuthAcceptedResponse
  | { verified: true };

export interface AuthUserResponse {
  user: AccountProfile;
}

export interface RegisterInput {
  email: string;
  password: string;
  password_confirmation: string;
  display_name: string;
  avatar_base64?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface EmailVerificationConfirmInput {
  token: string;
}

export interface PasswordChangeInput {
  current_password: string;
  new_password: string;
  new_password_confirmation: string;
}

export interface PasswordResetRequestInput {
  email: string;
}

export interface PasswordResetConfirmInput {
  token: string;
  new_password: string;
  new_password_confirmation: string;
}

export interface ProfileUpdateInput {
  display_name: string;
}

export interface AvatarUpdateInput {
  avatar_base64: string;
}

export interface AuthErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
  };
}
