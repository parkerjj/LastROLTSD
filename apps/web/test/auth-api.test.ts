import { describe, expect, it, vi } from 'vitest';
import { AuthApi, AuthApiError } from '../src/auth/api';
import type { AccountProfile, AuthSessionResponse } from '../src/auth/types';

const user: AccountProfile = {
  id: '10000',
  email: 'a@example.test',
  display_name: 'Player A',
  status: 'ACTIVE',
  admin: 1,
  email_verified_at: 1,
  created_at: 1,
  has_avatar: false,
  avatar_version: 0,
  avatar_url: '/api/v1/users/10000/avatar?v=0',
};

const session: AuthSessionResponse = {
  user,
  expires_at: 30_000,
  csrf_token: 'session-csrf-a',
  mail_availability: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AuthApi', () => {
  it('uses the global receiver for its default fetch transport', async () => {
    const originalFetch = globalThis.fetch;
    const receivers: unknown[] = [];
    const fetchMock = function (this: unknown): Promise<Response> {
      receivers.push(this);
      return Promise.resolve(jsonResponse({ csrf_token: 'anonymous-token' }));
    };
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    try {
      await new AuthApi().getCsrf();
      expect(receivers[0]).toBe(globalThis);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('keeps anonymous and session CSRF separate and retries only an invalid anonymous write once', async () => {
    let csrfCount = 0;
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/v1/auth/csrf') {
        csrfCount += 1;
        return jsonResponse({ csrf_token: `anonymous-${csrfCount}` });
      }
      if (path === '/api/v1/auth/login') return jsonResponse(session);
      if (path === '/api/v1/auth/password-reset/request') {
        const token = new Headers(init.headers).get('X-CSRF-Token');
        if (token === 'anonymous-1') {
          return jsonResponse({ error: { code: 'AUTH_CSRF_INVALID', message: 'token changed', request_id: 'req-1' } }, 403);
        }
        return jsonResponse({ accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null } }, 202);
      }
      if (path === '/api/v1/account/profile') {
        return jsonResponse({ user });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const fetcher = fetchMock as unknown as typeof fetch;
    const api = new AuthApi(fetcher);

    await api.getCsrf();
    await api.login({ email: user.email, password: 'secret' });
    await api.requestPasswordReset({ email: user.email });
    await api.updateProfile({ display_name: 'Player A' });

    const resetWrites = calls.filter((call) => call.path === '/api/v1/auth/password-reset/request');
    expect(resetWrites).toHaveLength(2);
    expect(new Headers(resetWrites[0]!.init.headers).get('X-CSRF-Token')).toBe('anonymous-1');
    expect(new Headers(resetWrites[1]!.init.headers).get('X-CSRF-Token')).toBe('anonymous-2');
    expect(new Headers(calls.find((call) => call.path === '/api/v1/account/profile')!.init.headers).get('X-CSRF-Token')).toBe('session-csrf-a');
    expect(calls.every((call) => call.init.credentials === 'same-origin')).toBe(true);
  });

  it('does not replay a session write after CSRF rejection and does not parse a 204 response', async () => {
    let profileWrites = 0;
    let logoutResponse: Response | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      if (path === '/api/v1/auth/csrf') return jsonResponse({ csrf_token: 'anonymous-token' });
      if (path === '/api/v1/auth/login') return jsonResponse(session);
      if (path === '/api/v1/account/profile') {
        profileWrites += 1;
        return jsonResponse({ error: { code: 'AUTH_CSRF_INVALID', message: 'session changed', request_id: 'req-2' } }, 403);
      }
      if (path === '/api/v1/auth/logout') {
        expect(init.body).toBe('{}');
        logoutResponse = new Response(null, { status: 204 });
        logoutResponse.json = vi.fn(async () => { throw new Error('204 must not be parsed'); });
        return logoutResponse;
      }
      if (path === '/api/v1/account/avatar') {
        expect(init.method).toBe('DELETE');
        expect(init.body).toBeUndefined();
        return jsonResponse({ user });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const fetcher = fetchMock as unknown as typeof fetch;
    const api = new AuthApi(fetcher);

    await api.login({ email: user.email, password: 'secret' });
    await expect(api.updateProfile({ display_name: 'Changed' })).rejects.toMatchObject({
      status: 403,
      code: 'AUTH_CSRF_INVALID',
    } satisfies Partial<AuthApiError>);
    await api.deleteAvatar();
    await api.logout();

    expect(profileWrites).toBe(1);
    expect(logoutResponse?.json).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === 'same-origin')).toBe(true);
  });
});
