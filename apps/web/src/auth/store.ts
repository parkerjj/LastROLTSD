import { authApi, AuthApiError, type AuthApiClient, type AuthSessionFailure } from './api';
import type { AccountProfile, AuthSessionResponse, MailAvailability } from './types';

const AUTH_CHANNEL_NAME = 'ltsd-auth-state-v1';
const VISIT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export type AuthStoreState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'pending'; user: AccountProfile; expiresAt: number; mailAvailability: MailAvailability | null; refreshError?: string }
  | { status: 'active'; user: AccountProfile; expiresAt: number; mailAvailability: null; refreshError?: string }
  | { status: 'disabled'; message: string; user?: AccountProfile }
  | { status: 'error'; message: string };

export interface AuthIdentityChangedEvent {
  readonly type: 'identity-changed';
  readonly previousUserId: string | null;
  readonly userId: string | null;
  readonly clearDrafts: true;
}

export type AuthStoreEvent = AuthIdentityChangedEvent;
export type AuthStoreListener = (state: Readonly<AuthStoreState>, event?: AuthStoreEvent) => void;

export type AuthStoreApi = Pick<
  AuthApiClient,
  | 'me'
  | 'refreshSession'
  | 'logout'
  | 'setSessionCsrf'
  | 'clearSessionCsrf'
  | 'onSessionFailure'
  | 'sessionRevision'
>;

export interface AuthStoreOptions {
  now?: () => number;
  broadcastChannel?: BroadcastChannel | null;
}

export class AuthStore {
  private state: AuthStoreState = { status: 'loading' };
  private readonly listeners = new Set<AuthStoreListener>();
  private readonly now: () => number;
  private readonly channel: BroadcastChannel | null;
  private readonly removeSessionFailureListener: () => void;
  private generation = 0;
  private currentUserId: string | null = null;
  private currentSessionCsrf: string | null = null;
  private bootstrapComplete = false;
  private bootstrapInFlight: Promise<void> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileDirty = false;
  private lastRefreshAt: number | null = null;

  constructor(private readonly api: AuthStoreApi, options: AuthStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.channel = options.broadcastChannel === undefined
      ? createAuthBroadcastChannel()
      : options.broadcastChannel;
    this.channel?.addEventListener('message', this.handleBroadcast);
    this.removeSessionFailureListener = api.onSessionFailure((failure) => {
      void this.handleSessionFailure(failure);
    });
  }

  getState(): Readonly<AuthStoreState> {
    return this.state;
  }

  subscribe(listener: AuthStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bootstrap(): Promise<void> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    if (this.bootstrapComplete && this.state.status !== 'error' && this.state.status !== 'disabled') {
      return Promise.resolve();
    }

    const generation = this.generation;
    this.state = { status: 'loading' };
    this.emit();
    const operation = this.loadBootstrap(generation);
    const tracked = operation.finally(() => {
      this.bootstrapInFlight = null;
    });
    this.bootstrapInFlight = tracked;
    return tracked;
  }

  refreshForVisit(force = false): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.hasSession()) return Promise.resolve();
    if (!force && this.lastRefreshAt !== null && this.now() - this.lastRefreshAt < VISIT_REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }

    const generation = this.generation;
    const operation = this.refreshSession(generation);
    const tracked = operation.finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = tracked;
    return tracked;
  }

  setSession(response: AuthSessionResponse): void {
    this.generation += 1;
    this.bootstrapComplete = true;
    this.lastRefreshAt = this.now();
    this.adoptSession(response, true);
  }

  initializeFromBootstrap(response: AuthSessionResponse | null): void {
    this.generation += 1;
    this.bootstrapComplete = true;
    if (response) {
      this.lastRefreshAt = this.now();
      this.adoptSession(response, false);
      return;
    }
    this.transitionToAnonymous(false);
  }

  clear(): void {
    this.transitionToAnonymous(true);
  }

  async logout(): Promise<void> {
    const generation = ++this.generation;
    this.bootstrapComplete = true;
    try {
      await this.api.logout();
      if (generation === this.generation) this.clear();
      else await this.reconcile();
    } catch (error) {
      if (generation === this.generation && isStatus(error, 401)) this.clear();
      else await this.reconcile();
      throw error;
    }
  }

  reconcile(): Promise<void> {
    this.generation += 1;
    this.api.clearSessionCsrf();
    if (this.reconcileInFlight) {
      this.reconcileDirty = true;
      return this.reconcileInFlight;
    }

    const operation = this.reconcileLatest();
    const tracked = operation.finally(() => {
      this.reconcileInFlight = null;
    });
    this.reconcileInFlight = tracked;
    return tracked;
  }

  private async reconcileLatest(): Promise<void> {
    do {
      this.reconcileDirty = false;
      await this.loadReconciledSession(this.generation);
    } while (this.reconcileDirty);
  }

  private async loadBootstrap(generation: number): Promise<void> {
    try {
      const response = await this.api.me();
      if (generation !== this.generation) return;
      this.adoptSession(response, false);
      this.bootstrapComplete = true;
      await this.refreshForVisit(true);
    } catch (error) {
      if (generation !== this.generation) return;
      if (isStatus(error, 401)) {
        this.transitionToAnonymous(true);
        this.bootstrapComplete = true;
        return;
      }
      this.setBootstrapFailure(error);
    }
  }

  private async refreshSession(generation: number): Promise<void> {
    try {
      const response = await this.api.refreshSession();
      if (generation !== this.generation) return;
      if (this.currentSessionCsrf !== response.csrf_token) {
        this.currentSessionCsrf = response.csrf_token;
        this.api.setSessionCsrf(response.csrf_token);
      }
      this.lastRefreshAt = this.now();
      const current = this.state;
      if (current.status === 'pending' || current.status === 'active') {
        const { refreshError: _refreshError, ...withoutRefreshError } = current;
        this.state = { ...withoutRefreshError, expiresAt: response.expires_at };
        this.emit();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (isStatus(error, 401)) {
        this.transitionToAnonymous(false);
        return;
      }
      if (isCsrfFailure(error)) {
        await this.reconcile();
        return;
      }
      this.keepSessionWithError(error);
    }
  }

  private async loadReconciledSession(generation: number): Promise<void> {
    try {
      const response = await this.api.me();
      if (generation !== this.generation) return;
      this.adoptSession(response, false);
      this.bootstrapComplete = true;
    } catch (error) {
      if (generation !== this.generation) return;
      if (isStatus(error, 401)) {
        this.transitionToAnonymous(false);
        return;
      }
      this.keepSessionWithError(error);
    }
  }

  private adoptSession(response: AuthSessionResponse, announceIdentityChange: boolean): void {
    const previousUserId = this.currentUserId;
    const identityChanged = previousUserId !== response.user.id
      || this.currentSessionCsrf !== response.csrf_token;
    if (identityChanged) this.generation += 1;
    if (this.currentSessionCsrf !== response.csrf_token) {
      this.currentSessionCsrf = response.csrf_token;
      this.api.setSessionCsrf(response.csrf_token);
    }
    this.currentUserId = response.user.id;
    this.bootstrapComplete = true;
    this.state = sessionState(response);
    const event: AuthIdentityChangedEvent | undefined = identityChanged
      ? { type: 'identity-changed', previousUserId, userId: response.user.id, clearDrafts: true }
      : undefined;
    this.emit(event);
    if (identityChanged && announceIdentityChange) this.broadcastIdentityChange();
  }

  private transitionToAnonymous(announceIdentityChange: boolean): void {
    const previousUserId = this.currentUserId;
    const hadIdentity = previousUserId !== null || this.currentSessionCsrf !== null;
    this.generation += 1;
    this.currentUserId = null;
    this.currentSessionCsrf = null;
    this.api.clearSessionCsrf();
    this.bootstrapComplete = true;
    this.lastRefreshAt = null;
    this.state = { status: 'anonymous' };
    const event: AuthIdentityChangedEvent | undefined = hadIdentity
      ? { type: 'identity-changed', previousUserId, userId: null, clearDrafts: true }
      : undefined;
    this.emit(event);
    if (hadIdentity && announceIdentityChange) this.broadcastIdentityChange();
  }

  private setBootstrapFailure(error: unknown): void {
    const message = errorMessage(error);
    if (isStatus(error, 503) || (error instanceof AuthApiError && error.code === 'AUTH_DISABLED')) {
      this.state = { status: 'disabled', message };
    } else {
      this.state = { status: 'error', message };
    }
    this.bootstrapComplete = false;
    this.emit();
  }

  private keepSessionWithError(error: unknown): void {
    const current = this.state;
    if (current.status === 'pending' || current.status === 'active') {
      this.state = { ...current, refreshError: errorMessage(error) };
      this.emit();
      return;
    }
    this.setBootstrapFailure(error);
  }

  private async handleSessionFailure(failure: AuthSessionFailure): Promise<void> {
    if (failure.sessionRevision !== this.api.sessionRevision) return;
    if (failure.status === 401) {
      this.clear();
      return;
    }
    if (failure.status === 403 && (failure.code === 'AUTH_CSRF_INVALID' || failure.code === 'AUTH_CSRF_MISSING')) {
      await this.reconcile();
    }
  }

  private readonly handleBroadcast = (event: MessageEvent<unknown>): void => {
    if (!isAuthStateChangedMessage(event.data)) return;
    void this.reconcile();
  };

  private broadcastIdentityChange(): void {
    try {
      this.channel?.postMessage({ type: 'auth-state-changed' });
    } catch {
      // Cross-tab sync is advisory; server-side revocation remains authoritative.
    }
  }

  private hasSession(): boolean {
    return this.currentUserId !== null && (this.state.status === 'pending' || this.state.status === 'active');
  }

  private emit(event?: AuthStoreEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state, event);
      } catch {
        // A view subscriber must not interrupt session reconciliation.
      }
    }
  }
}

function sessionState(response: AuthSessionResponse): AuthStoreState {
  if (response.user.status === 'DISABLED') {
    return { status: 'disabled', user: response.user, message: '账号已停用' };
  }
  if (response.user.status === 'PENDING_EMAIL') {
    return {
      status: 'pending',
      user: response.user,
      expiresAt: response.expires_at,
      mailAvailability: response.mail_availability,
    };
  }
  return {
    status: 'active',
    user: response.user,
    expiresAt: response.expires_at,
    mailAvailability: null,
  };
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof AuthApiError && error.status === status;
}

function isCsrfFailure(error: unknown): boolean {
  return error instanceof AuthApiError
    && error.status === 403
    && (error.code === 'AUTH_CSRF_INVALID' || error.code === 'AUTH_CSRF_MISSING');
}

function errorMessage(error: unknown): string {
  return error instanceof AuthApiError
    ? error.message
    : '账号状态暂不可用，请稍后重试';
}

function isAuthStateChangedMessage(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && 'type' in value
    && value.type === 'auth-state-changed'
    && Object.keys(value).length === 1;
}

function createAuthBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (typeof globalThis.BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(AUTH_CHANNEL_NAME);
  } catch {
    return null;
  }
}

export const authStore = new AuthStore(authApi);
