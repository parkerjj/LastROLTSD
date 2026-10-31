import { describe, expect, it, vi } from 'vitest';
import { AuthApi, AuthApiError } from '../src/auth/api';
import { AuthStore, type AuthStoreApi } from '../src/auth/store';
import type { AccountProfile, AuthSessionResponse } from '../src/auth/types';

function profile(id: string, displayName: string): AccountProfile {
  return {
    id,
    email: `${id}@example.test`,
    display_name: displayName,
    status: 'ACTIVE',
    permission_level: 1,
    email_verified_at: 1,
    created_at: 1,
    has_avatar: false,
    avatar_version: 0,
    avatar_url: `/api/v1/users/${id}/avatar?v=0`,
  };
}

function session(id = '10000', displayName = 'Player A'): AuthSessionResponse {
  return {
    user: profile(id, displayName),
    expires_at: 30_000,
    csrf_token: `session-csrf-${id}`,
    mail_availability: null,
  };
}

function makeApi(overrides: Partial<AuthStoreApi> = {}): AuthStoreApi {
  return {
    me: vi.fn(async () => session()),
    refreshSession: vi.fn(async () => ({ expires_at: 60_000, csrf_token: 'refreshed-csrf' })),
    logout: vi.fn(async () => undefined),
    setSessionCsrf: vi.fn(),
    clearSessionCsrf: vi.fn(),
    onSessionFailure: vi.fn(() => () => undefined),
    sessionRevision: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AuthStore', () => {
  it('restores the session in memory and refreshes it once after bootstrap', async () => {
    const api = makeApi();
    const store = new AuthStore(api, { broadcastChannel: null });

    await store.bootstrap();

    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.refreshSession).toHaveBeenCalledTimes(1);
    expect(api.setSessionCsrf).toHaveBeenCalledWith('session-csrf-10000');
    expect(api.setSessionCsrf).toHaveBeenCalledWith('refreshed-csrf');
    expect(store.getState()).toMatchObject({ status: 'active', user: { id: '10000' }, expiresAt: 60_000 });
  });

  it('hydrates authenticated and anonymous HTML bootstrap states without calling me()', async () => {
    const authenticatedApi = makeApi();
    const authenticatedStore = new AuthStore(authenticatedApi, { broadcastChannel: null });
    authenticatedStore.initializeFromBootstrap(session());
    await authenticatedStore.bootstrap();
    expect(authenticatedStore.getState()).toMatchObject({ status: 'active', user: { id: '10000' }, expiresAt: 30_000 });
    expect(authenticatedApi.me).not.toHaveBeenCalled();

    const anonymousApi = makeApi();
    const anonymousStore = new AuthStore(anonymousApi, { broadcastChannel: null });
    anonymousStore.initializeFromBootstrap(null);
    await anonymousStore.bootstrap();
    expect(anonymousStore.getState().status).toBe('anonymous');
    expect(anonymousApi.me).not.toHaveBeenCalled();
  });

  it('treats an expired me session as anonymous and confines a disabled service to account state', async () => {
    const unauthorized = makeApi({
      me: vi.fn(async () => { throw new AuthApiError(401, 'AUTH_UNAUTHENTICATED', '请先登录'); }),
    });
    const anonymousStore = new AuthStore(unauthorized, { broadcastChannel: null });
    await anonymousStore.bootstrap();
    expect(anonymousStore.getState().status).toBe('anonymous');
    expect(unauthorized.refreshSession).not.toHaveBeenCalled();

    const unavailable = makeApi({
      me: vi.fn(async () => { throw new AuthApiError(503, 'AUTH_UNAVAILABLE', '账号服务暂不可用'); }),
    });
    const disabledStore = new AuthStore(unavailable, { broadcastChannel: null });
    await disabledStore.bootstrap();
    expect(disabledStore.getState()).toMatchObject({ status: 'disabled' });
  });

  it('coalesces three visit refreshes into one request', async () => {
    const pending = deferred<{ expires_at: number; csrf_token: string }>();
    const api = makeApi({ refreshSession: vi.fn(() => pending.promise) });
    const store = new AuthStore(api, { broadcastChannel: null });
    store.setSession(session());

    const refreshes = [store.refreshForVisit(true), store.refreshForVisit(true), store.refreshForVisit(true)];
    expect(api.refreshSession).toHaveBeenCalledTimes(1);
    pending.resolve({ expires_at: 90_000, csrf_token: 'session-csrf-10000' });
    await Promise.all(refreshes);

    expect(store.getState()).toMatchObject({ status: 'active', expiresAt: 90_000 });
  });

  it('does not rebroadcast a logout received from another tab', async () => {
    const sentMessages: unknown[] = [];
    const channel = Object.assign(new EventTarget(), {
      postMessage: (message: unknown) => sentMessages.push(message),
    }) as unknown as BroadcastChannel;
    const api = makeApi({
      me: vi.fn(async () => { throw new AuthApiError(401, 'AUTH_UNAUTHENTICATED', '请先登录'); }),
    });
    const store = new AuthStore(api, { broadcastChannel: channel });
    store.setSession(session());
    expect(sentMessages).toHaveLength(1);

    channel.dispatchEvent(new MessageEvent('message', { data: { type: 'auth-state-changed' } }));
    await vi.waitFor(() => expect(store.getState().status).toBe('anonymous'));

    expect(sentMessages).toHaveLength(1);
  });

  it('discards an outdated reconcile and coalesces a later tab change into the latest identity query', async () => {
    const oldIdentityResponse = deferred<AuthSessionResponse>();
    let serverCookieIdentity = '10000';
    let meCalls = 0;
    const api = makeApi({
      me: vi.fn(async () => {
        meCalls += 1;
        if (meCalls === 1) return oldIdentityResponse.promise;
        return session(serverCookieIdentity, serverCookieIdentity === '10000' ? 'Player A' : 'Player B');
      }),
    });
    const sentMessages: unknown[] = [];
    const channel = Object.assign(new EventTarget(), {
      postMessage: (message: unknown) => sentMessages.push(message),
    }) as unknown as BroadcastChannel;
    const store = new AuthStore(api, { broadcastChannel: channel });
    store.setSession(session('10000', 'Player A'));

    let profileDraft = 'unsaved A profile';
    let avatarPreview: string | null = 'blob:old-a-preview';
    const identityEvents: Array<{ previousUserId: string | null; userId: string | null }> = [];
    store.subscribe((_state, event) => {
      if (event?.type !== 'identity-changed') return;
      identityEvents.push(event);
      if (event.clearDrafts) {
        profileDraft = '';
        avatarPreview = null;
      }
    });

    channel.dispatchEvent(new MessageEvent('message', { data: { type: 'auth-state-changed' } }));
    expect(meCalls).toBe(1);
    serverCookieIdentity = '20000';
    channel.dispatchEvent(new MessageEvent('message', { data: { type: 'auth-state-changed' } }));
    oldIdentityResponse.resolve(session('10000', 'Player A'));

    await vi.waitFor(() => expect(store.getState()).toMatchObject({ status: 'active', user: { id: '20000' } }));

    expect(meCalls).toBe(2);
    expect(serverCookieIdentity).toBe('20000');
    expect(profileDraft).toBe('');
    expect(avatarPreview).toBeNull();
    expect(identityEvents).toContainEqual({ previousUserId: '10000', userId: '20000', type: 'identity-changed', clearDrafts: true });
    expect(sentMessages).toHaveLength(1);
  });

  it('ignores a late me response after logout and clears drafts when another tab changes A to B', async () => {
    const delayed = deferred<AuthSessionResponse>();
    const delayedLogout = deferred<void>();
    const lateApi = makeApi({
      me: vi.fn(() => delayed.promise),
      logout: vi.fn(() => delayedLogout.promise),
    });
    const lateStore = new AuthStore(lateApi, { broadcastChannel: null });
    const bootstrap = lateStore.bootstrap();
    const logout = lateStore.logout();
    delayed.resolve(session());
    await bootstrap;
    delayedLogout.resolve();
    await logout;
    expect(lateStore.getState().status).toBe('anonymous');
    expect(lateApi.refreshSession).not.toHaveBeenCalled();

    let currentUserId = '10000';
    const serverNames: Record<string, string> = { '10000': 'Player A', '20000': 'Player B' };
    let profileWrites = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      if (path === '/api/v1/auth/me') return jsonResponse(session(currentUserId, serverNames[currentUserId]));
      if (path === '/api/v1/auth/session/refresh') {
        return jsonResponse({ expires_at: 60_000, csrf_token: `session-csrf-${currentUserId}` });
      }
      if (path === '/api/v1/account/profile') {
        profileWrites += 1;
        const token = new Headers(init.headers).get('X-CSRF-Token');
        if (token !== `session-csrf-${currentUserId}`) {
          return jsonResponse({ error: { code: 'AUTH_CSRF_INVALID', message: '会话已更新', request_id: 'req-3' } }, 403);
        }
        const body = JSON.parse(String(init.body)) as { display_name: string };
        serverNames[currentUserId] = body.display_name;
        return jsonResponse({ user: profile(currentUserId, body.display_name) });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as unknown as typeof fetch;
    const api = new AuthApi(fetcher);
    const store = new AuthStore(api, { broadcastChannel: null });
    await store.bootstrap();

    let draft = 'unsaved A profile';
    let avatarPreview: string | null = 'blob:old-a-preview';
    const identityEvents: Array<{ previousUserId: string | null; userId: string | null; clearDrafts: true }> = [];
    store.subscribe((_state, event) => {
      if (event?.type !== 'identity-changed') return;
      identityEvents.push(event);
      if (event.clearDrafts) {
        draft = '';
        avatarPreview = null;
      }
    });

    currentUserId = '20000';
    await expect(api.updateProfile({ display_name: 'A edit must not reach B' })).rejects.toMatchObject({
      status: 403,
      code: 'AUTH_CSRF_INVALID',
    });
    await vi.waitFor(() => expect(store.getState()).toMatchObject({ status: 'active', user: { id: '20000' } }));

    expect(profileWrites).toBe(1);
    expect(serverNames).toEqual({ '10000': 'Player A', '20000': 'Player B' });
    expect(draft).toBe('');
    expect(avatarPreview).toBeNull();
    expect(identityEvents).toContainEqual({ previousUserId: '10000', userId: '20000', clearDrafts: true, type: 'identity-changed' });
  });
});
