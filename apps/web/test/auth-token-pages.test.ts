import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../src/auth/api';
import { AuthStore, authStore, type AuthStoreApi } from '../src/auth/store';
import type { AuthSessionResponse } from '../src/auth/types';
import { mountAuthPage } from '../src/auth/pages';

let restoreDom: (() => void) | undefined;

function session(status: 'ACTIVE' | 'PENDING_EMAIL' = 'PENDING_EMAIL'): AuthSessionResponse {
  return {
    user: {
      id: '10000', email: 'player@example.test', display_name: '玩家', status,
      permission_level: status === 'ACTIVE' ? 1 : 0,
      email_verified_at: status === 'ACTIVE' ? 1 : null, created_at: 1,
      has_avatar: false, avatar_version: 0, avatar_url: '/api/v1/users/10000/avatar?v=0',
    },
    expires_at: 30_000, csrf_token: 'session-csrf',
    mail_availability: status === 'PENDING_EMAIL' ? { code: 'AVAILABLE', retry_at: null } : null,
  };
}

function mount(path: string, store: AuthStore = authStore) {
  const dom = new JSDOM('<div id="app"></div>', { url: `http://localhost${path}` });
  const previousDocument = globalThis.document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  restoreDom = () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    dom.window.close();
    restoreDom = undefined;
  };
  if (store === authStore) vi.spyOn(authStore, 'bootstrap').mockResolvedValue();
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const dispose = mountAuthPage(root, dom.window.location.pathname, authApi, store);
  return { dom, root, dispose };
}

function submit(dom: JSDOM, form: HTMLFormElement): void {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  restoreDom?.();
  authStore.clear();
  vi.restoreAllMocks();
});

describe('auth token pages', () => {
  it('clears a reset token from the URL before loading the form and only consumes it on submit', async () => {
    const csrf = vi.spyOn(authApi, 'getCsrf').mockResolvedValue({ csrf_token: 'anonymous-csrf' });
    const confirm = vi.spyOn(authApi, 'confirmPasswordReset').mockResolvedValue();
    const clear = vi.spyOn(authStore, 'clear');
    const { dom, root, dispose } = mount('/reset-password?token=reset-secret&return_to=%2Faccount');
    try {
      expect(dom.window.location.href).toBe('http://localhost/reset-password');
      expect(csrf).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(root.querySelector('#reset-password-form')).not.toBeNull());
      const password = root.querySelector<HTMLInputElement>('#auth-password')!;
      const confirmation = root.querySelector<HTMLInputElement>('#auth-password-confirmation')!;
      password.value = 'newpass';
      confirmation.value = 'newpass';
      submit(dom, root.querySelector<HTMLFormElement>('#reset-password-form')!);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith({
        token: 'reset-secret', new_password: 'newpass', new_password_confirmation: 'newpass',
      }));
      expect(clear).toHaveBeenCalledTimes(1);
      expect(root.textContent).toContain('请登录');
      expect(dom.window.localStorage.length).toBe(0);
      expect(dom.window.sessionStorage.length).toBe(0);
      expect(Array.from(root.querySelectorAll('a')).every((link) => !link.href.includes('reset-secret'))).toBe(true);
    } finally {
      dispose();
    }
  });

  it('keeps a verification token through inline login and waits for an explicit confirmation click', async () => {
    const login = vi.spyOn(authApi, 'login').mockResolvedValue(session());
    const confirm = vi.spyOn(authApi, 'confirmEmailVerification').mockResolvedValue(session('ACTIVE'));
    const { dom, root, dispose } = mount('/verify-email#token=verify-secret');
    try {
      expect(dom.window.location.href).toBe('http://localhost/verify-email');
      expect(root.querySelector<HTMLFormElement>('#verify-login-form')).not.toBeNull();
      expect(confirm).not.toHaveBeenCalled();

      root.querySelector<HTMLInputElement>('#auth-email')!.value = 'player@example.test';
      const password = root.querySelector<HTMLInputElement>('#auth-password')!;
      password.value = 'player-pass';
      root.querySelector<HTMLButtonElement>('[data-password-toggle="auth-password"]')!.click();
      expect(password.type).toBe('text');
      submit(dom, root.querySelector<HTMLFormElement>('#verify-login-form')!);
      await vi.waitFor(() => expect(login).toHaveBeenCalledWith({ email: 'player@example.test', password: 'player-pass' }));
      await vi.waitFor(() => expect(authStore.getState().status).toBe('pending'));
      expect(password.value).toBe('');
      expect(password.type).toBe('password');
      expect(confirm).not.toHaveBeenCalled();

      root.querySelector<HTMLButtonElement>('#verify-confirm')!.click();
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith({ token: 'verify-secret' }));
      expect(root.textContent).toContain('邮箱已验证');
      expect(dom.window.localStorage.length).toBe(0);
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      dispose();
    }
  });

  it('shows the pending account email without resend or polling controls', async () => {
    const refreshSession = vi.fn(async () => ({ expires_at: 30_000, csrf_token: 'session-csrf' }));
    const storeApi: AuthStoreApi = {
      me: vi.fn(async () => session()),
      refreshSession,
      logout: vi.fn(async () => undefined),
      setSessionCsrf: vi.fn(),
      clearSessionCsrf: vi.fn(),
      onSessionFailure: vi.fn(() => () => undefined),
      sessionRevision: 0,
    };
    const store = new AuthStore(storeApi, { broadcastChannel: null });
    const request = vi.spyOn(authApi, 'requestEmailVerification').mockResolvedValue({
      accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null },
    });
    const reconcile = vi.spyOn(store, 'reconcile').mockResolvedValue();
    const { dom, root, dispose } = mount('/verify-email#token=verify-secret', store);
    const scheduled: Array<() => void> = [];
    const originalSetTimeout = dom.window.setTimeout;
    dom.window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      if (delay === 120_000 && typeof callback === 'function') scheduled.push(callback as () => void);
      return 1;
    }) as typeof dom.window.setTimeout;
    try {
      await store.bootstrap();
      expect(store.getState().status).toBe('pending');
      const refreshCount = refreshSession.mock.calls.length;
      expect(root.querySelector('#verify-request')).toBeNull();
      expect(root.querySelector('#verify-check')).toBeNull();
      expect(root.querySelector<HTMLElement>('#verify-status')?.textContent).toContain('player@example.test');
      expect(request).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(refreshSession).toHaveBeenCalledTimes(refreshCount);
      expect(scheduled).toHaveLength(0);
    } finally {
      dom.window.setTimeout = originalSetTimeout;
      dispose();
    }
  });
});
