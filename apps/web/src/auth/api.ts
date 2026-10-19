import type {
  AuthAcceptedResponse,
  AuthCsrfResponse,
  AuthErrorEnvelope,
  AuthSessionRefreshResponse,
  AuthSessionResponse,
  AuthUserResponse,
  AvatarUpdateInput,
  EmailVerificationConfirmInput,
  EmailVerificationRequestResponse,
  LoginInput,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  ProfileUpdateInput,
  RegisterInput,
} from './types';

const AUTH_CSRF_PATH = '/api/v1/auth/csrf';
const ACCOUNT_CACHE = 'no-store';

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

export interface AuthSessionFailure {
  readonly status: number;
  readonly code: string;
  readonly sessionRevision: number;
}

export type AuthSessionFailureListener = (failure: AuthSessionFailure) => void;

export interface AuthApiClient {
  readonly sessionRevision: number;
  getCsrf(): Promise<AuthCsrfResponse>;
  register(input: RegisterInput): Promise<AuthAcceptedResponse>;
  login(input: LoginInput): Promise<AuthSessionResponse>;
  me(): Promise<AuthSessionResponse>;
  refreshSession(): Promise<AuthSessionRefreshResponse>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  requestEmailVerification(): Promise<EmailVerificationRequestResponse>;
  confirmEmailVerification(input: EmailVerificationConfirmInput): Promise<AuthSessionResponse>;
  changePassword(input: PasswordChangeInput): Promise<void>;
  requestPasswordReset(input: PasswordResetRequestInput): Promise<AuthAcceptedResponse>;
  confirmPasswordReset(input: PasswordResetConfirmInput): Promise<void>;
  updateProfile(input: ProfileUpdateInput): Promise<AuthUserResponse>;
  setAvatar(input: AvatarUpdateInput): Promise<AuthUserResponse>;
  deleteAvatar(): Promise<AuthUserResponse>;
  getAvatar(userId: string, version: number): Promise<Blob>;
  /** 账号命名空间之外的登录写请求（如留言板）：自动附带会话 CSRF，401/CSRF 失效会广播会话失败 */
  sessionRequest<T>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T>;
  setSessionCsrf(token: string): void;
  clearSessionCsrf(): void;
  onSessionFailure(listener: AuthSessionFailureListener): () => void;
}

export class AuthApi implements AuthApiClient {
  private anonymousCsrf: string | null = null;
  private anonymousCsrfInFlight: Promise<AuthCsrfResponse> | null = null;
  private sessionCsrf: string | null = null;
  private sessionRevisionValue = 0;
  private readonly sessionFailureListeners = new Set<AuthSessionFailureListener>();

  constructor(private readonly fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {}

  get sessionRevision(): number {
    return this.sessionRevisionValue;
  }

  getCsrf(): Promise<AuthCsrfResponse> {
    if (this.anonymousCsrf) {
      return Promise.resolve({ csrf_token: this.anonymousCsrf });
    }
    if (this.anonymousCsrfInFlight) return this.anonymousCsrfInFlight;

    const request = this.fetcher(AUTH_CSRF_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      cache: ACCOUNT_CACHE,
    }).then((response) => this.readJson<AuthCsrfResponse>(response)).then((result) => {
      if (typeof result.csrf_token !== 'string' || result.csrf_token.length === 0) {
        throw new AuthApiError(502, 'AUTH_BAD_RESPONSE', '账号服务返回了无效响应');
      }
      this.anonymousCsrf = result.csrf_token;
      return result;
    }).finally(() => {
      if (this.anonymousCsrfInFlight === request) this.anonymousCsrfInFlight = null;
    });
    this.anonymousCsrfInFlight = request;
    return request;
  }

  async register(input: RegisterInput): Promise<AuthAcceptedResponse> {
    return this.postJson('/api/v1/auth/register', input, 'anonymous');
  }

  async login(input: LoginInput): Promise<AuthSessionResponse> {
    const result = await this.postJson<AuthSessionResponse>('/api/v1/auth/login', input, 'anonymous');
    this.setSessionCsrf(result.csrf_token);
    return result;
  }

  async me(): Promise<AuthSessionResponse> {
    const revision = this.sessionRevisionValue;
    const result = await this.getJson<AuthSessionResponse>('/api/v1/auth/me');
    this.setSessionCsrfIfCurrent(result.csrf_token, revision);
    return result;
  }

  async refreshSession(): Promise<AuthSessionRefreshResponse> {
    const revision = this.sessionRevisionValue;
    const result = await this.postJson<AuthSessionRefreshResponse>(
      '/api/v1/auth/session/refresh',
      {},
      'session',
      false,
    );
    this.setSessionCsrfIfCurrent(result.csrf_token, revision);
    return result;
  }

  async logout(): Promise<void> {
    const revision = this.sessionRevisionValue;
    await this.postVoid('/api/v1/auth/logout', {}, 'session');
    this.clearSessionCsrfIfCurrent(revision);
  }

  async logoutAll(): Promise<void> {
    const revision = this.sessionRevisionValue;
    await this.postVoid('/api/v1/auth/logout-all', {}, 'session');
    this.clearSessionCsrfIfCurrent(revision);
  }

  async requestEmailVerification(): Promise<EmailVerificationRequestResponse> {
    return this.postJson('/api/v1/auth/email-verification/request', {}, 'session');
  }

  async confirmEmailVerification(input: EmailVerificationConfirmInput): Promise<AuthSessionResponse> {
    const revision = this.sessionRevisionValue;
    const result = await this.postJson<AuthSessionResponse>(
      '/api/v1/auth/email-verification/confirm',
      input,
      'session',
    );
    this.setSessionCsrfIfCurrent(result.csrf_token, revision);
    return result;
  }

  async changePassword(input: PasswordChangeInput): Promise<void> {
    const revision = this.sessionRevisionValue;
    await this.postVoid('/api/v1/auth/password/change', input, 'session');
    this.clearSessionCsrfIfCurrent(revision);
  }

  async requestPasswordReset(input: PasswordResetRequestInput): Promise<AuthAcceptedResponse> {
    return this.postJson('/api/v1/auth/password-reset/request', input, 'anonymous');
  }

  async confirmPasswordReset(input: PasswordResetConfirmInput): Promise<void> {
    await this.postVoid('/api/v1/auth/password-reset/confirm', input, 'anonymous');
  }

  async updateProfile(input: ProfileUpdateInput): Promise<AuthUserResponse> {
    return this.patchJson('/api/v1/account/profile', input, 'session');
  }

  async setAvatar(input: AvatarUpdateInput): Promise<AuthUserResponse> {
    return this.putJson('/api/v1/account/avatar', input, 'session');
  }

  async deleteAvatar(): Promise<AuthUserResponse> {
    const response = await this.write('/api/v1/account/avatar', 'DELETE', undefined, 'session');
    return this.readJson<AuthUserResponse>(response);
  }

  async getAvatar(userId: string, version: number): Promise<Blob> {
    const path = `/api/v1/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(String(version))}`;
    const response = await this.fetcher(path, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) throw await this.readError(response);
    return response.blob();
  }

  async sessionRequest<T>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
    const response = await this.write(path, method, body, 'session');
    return this.readJson<T>(response);
  }

  setSessionCsrf(token: string): void {
    this.sessionCsrf = token;
    this.sessionRevisionValue += 1;
  }

  clearSessionCsrf(): void {
    this.sessionCsrf = null;
    this.sessionRevisionValue += 1;
  }

  onSessionFailure(listener: AuthSessionFailureListener): () => void {
    this.sessionFailureListeners.add(listener);
    return () => this.sessionFailureListeners.delete(listener);
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: ACCOUNT_CACHE,
    });
    return this.readJson<T>(response);
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    mode: 'anonymous' | 'session',
    reportSessionFailure = true,
  ): Promise<T> {
    const response = await this.write(path, 'POST', body, mode, reportSessionFailure);
    return this.readJson<T>(response);
  }

  private async patchJson<T>(path: string, body: unknown, mode: 'anonymous' | 'session'): Promise<T> {
    const response = await this.write(path, 'PATCH', body, mode);
    return this.readJson<T>(response);
  }

  private async putJson<T>(path: string, body: unknown, mode: 'anonymous' | 'session'): Promise<T> {
    const response = await this.write(path, 'PUT', body, mode);
    return this.readJson<T>(response);
  }

  private async postVoid(
    path: string,
    body: unknown,
    mode: 'anonymous' | 'session',
  ): Promise<void> {
    const response = await this.write(path, 'POST', body, mode);
    if (!response.ok) throw await this.readError(response);
  }

  private async write(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body: unknown | undefined,
    mode: 'anonymous' | 'session',
    reportSessionFailure = true,
  ): Promise<Response> {
    const headers = new Headers();
    if (body !== undefined) headers.set('content-type', 'application/json');
    const init: RequestInit = {
      method,
      headers,
      credentials: 'same-origin',
      cache: ACCOUNT_CACHE,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    if (mode === 'anonymous') {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = (await this.getCsrf()).csrf_token;
        const anonymousHeaders = new Headers(headers);
        anonymousHeaders.set('X-CSRF-Token', token);
        const response = await this.fetcher(path, { ...init, headers: anonymousHeaders });
        if (response.ok) return response;

        const error = await this.readError(response);
        if (attempt === 0 && error.status === 403 && error.code === 'AUTH_CSRF_INVALID') {
          if (this.anonymousCsrf === token) this.anonymousCsrf = null;
          continue;
        }
        throw error;
      }
      throw new AuthApiError(403, 'AUTH_CSRF_INVALID', '请求未能通过验证，请重试');
    }

    const revision = this.sessionRevisionValue;
    const token = this.sessionCsrf;
    if (!token) {
      const error = new AuthApiError(403, 'AUTH_CSRF_MISSING', '会话已更新，请重新确认操作');
      if (reportSessionFailure) this.notifySessionFailure(error, revision);
      throw error;
    }

    const sessionHeaders = new Headers(headers);
    sessionHeaders.set('X-CSRF-Token', token);
    const response = await this.fetcher(path, { ...init, headers: sessionHeaders });
    if (!response.ok) {
      const error = await this.readError(response);
      if (reportSessionFailure && (error.status === 401 || (error.status === 403 && error.code === 'AUTH_CSRF_INVALID'))) {
        this.notifySessionFailure(error, revision);
      }
      throw error;
    }
    return response;
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    if (!response.ok) throw await this.readError(response);
    try {
      return await response.json() as T;
    } catch {
      throw new AuthApiError(response.status, 'AUTH_BAD_RESPONSE', '账号服务返回了无效响应');
    }
  }

  private async readError(response: Response): Promise<AuthApiError> {
    let body: AuthErrorEnvelope | null = null;
    try {
      body = await response.json() as AuthErrorEnvelope;
    } catch {
      body = null;
    }
    const error = body && typeof body === 'object' ? body.error : undefined;
    return new AuthApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'AUTH_REQUEST_FAILED',
      typeof error?.message === 'string' ? error.message : '账号服务请求失败，请重试',
      typeof error?.request_id === 'string' ? error.request_id : null,
    );
  }

  private setSessionCsrfIfCurrent(token: string, expectedRevision: number): void {
    if (expectedRevision !== this.sessionRevisionValue) return;
    if (this.sessionCsrf === token) return;
    this.sessionCsrf = token;
    this.sessionRevisionValue += 1;
  }

  private clearSessionCsrfIfCurrent(expectedRevision: number): void {
    if (expectedRevision !== this.sessionRevisionValue) return;
    this.sessionCsrf = null;
    this.sessionRevisionValue += 1;
  }

  private notifySessionFailure(error: AuthApiError, sessionRevision: number): void {
    const failure: AuthSessionFailure = {
      status: error.status,
      code: error.code,
      sessionRevision,
    };
    for (const listener of [...this.sessionFailureListeners]) listener(failure);
  }
}

export const authApi = new AuthApi();
