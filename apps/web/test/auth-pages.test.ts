import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, authApi } from '../src/auth/api';
import { AuthStore, authStore, type AuthStoreApi } from '../src/auth/store';
import type { AuthSessionResponse } from '../src/auth/types';
import { isAuthPage, mountAuthPage } from '../src/auth/pages';

const mainMocks = vi.hoisted(() => ({
  initAnalytics: vi.fn(() => {
    const script = document.createElement('script');
    script.id = 'LA_COLLECT';
    document.head.append(script);
  }),
  track: vi.fn(),
  mountAuthPage: vi.fn(),
  mountAccountsPage: vi.fn(),
}));

let restoreDom: (() => void) | undefined;

function session(status: 'ACTIVE' | 'PENDING_EMAIL' = 'PENDING_EMAIL'): AuthSessionResponse {
  return {
    user: {
      id: '10000', email: 'player@example.test', display_name: '旧昵称', status,
      email_verified_at: status === 'ACTIVE' ? 1 : null, created_at: 1,
      has_avatar: false, avatar_version: 0, avatar_url: '/api/v1/users/10000/avatar?v=0',
    },
    expires_at: 30_000, csrf_token: 'session-csrf',
    mail_availability: status === 'PENDING_EMAIL' ? { code: 'AVAILABLE', retry_at: null } : null,
  };
}

function installDom(path: string) {
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
  return { dom, root: dom.window.document.querySelector<HTMLElement>('#app')! };
}

function mount(path: string, store: AuthStore = authStore) {
  const page = installDom(path);
  if (store === authStore) vi.spyOn(authStore, 'bootstrap').mockResolvedValue();
  const dispose = mountAuthPage(page.root, path, authApi, store);
  return { ...page, dispose };
}

function submit(dom: JSDOM, form: HTMLFormElement): void {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  restoreDom?.();
  authStore.clear();
  vi.restoreAllMocks();
  vi.doUnmock('../src/analytics');
  vi.doUnmock('../src/auth/pages');
  vi.doUnmock('../src/accounts-page');
  vi.resetModules();
  vi.clearAllMocks();
});

describe('auth pages', () => {
  it('matches only the seven account paths and leaves the game monitor route alone', () => {
    for (const path of ['/register', '/login', '/verify-email', '/forgot-password', '/reset-password', '/account', '/account/password']) {
      expect(isAuthPage(path)).toBe(true);
      expect(isAuthPage(`${path}/`)).toBe(true);
    }
    expect(isAuthPage('/accounts')).toBe(false);
  });

  it('requires a display name and matching password while allowing 256 emoji', async () => {
    const register = vi.spyOn(authApi, 'register').mockResolvedValue({
      accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null },
    });
    const { dom, root, dispose } = mount('/register');
    try {
      const email = root.querySelector<HTMLInputElement>('#auth-email')!;
      const name = root.querySelector<HTMLInputElement>('#auth-display-name')!;
      const password = root.querySelector<HTMLInputElement>('#auth-password')!;
      const confirmation = root.querySelector<HTMLInputElement>('#auth-password-confirmation')!;
      const form = root.querySelector<HTMLFormElement>('#register-form')!;
      email.value = 'player@example.test';
      password.value = '🙂'.repeat(256);
      confirmation.value = password.value;
      submit(dom, form);
      await Promise.resolve();
      expect(register).not.toHaveBeenCalled();

      name.value = '  主号  ';
      confirmation.value = '不一致的密码';
      submit(dom, form);
      await Promise.resolve();
      expect(register).not.toHaveBeenCalled();

      confirmation.value = password.value;
      expect(password.maxLength).toBe(-1);
      root.querySelector<HTMLButtonElement>('[data-password-toggle="auth-password"]')!.click();
      expect(password.type).toBe('text');
      submit(dom, form);
      await vi.waitFor(() => expect(register).toHaveBeenCalledWith({
        email: 'player@example.test',
        display_name: '主号',
        password: '🙂'.repeat(256),
        password_confirmation: '🙂'.repeat(256),
      }));
      await vi.waitFor(() => expect(root.textContent).toContain('已受理，正在等待发送'));
      expect(password.value).toBe('');
      expect(password.type).toBe('password');
      expect(confirmation.value).toBe('');
    } finally {
      dispose();
    }
  });

  it('lets a pending user update their profile and keeps password change gated', async () => {
    authStore.setSession(session());
    const update = vi.spyOn(authApi, 'updateProfile').mockResolvedValue({ user: { ...session().user, display_name: '新昵称' } });
    const reconcile = vi.spyOn(authStore, 'reconcile').mockResolvedValue();
    const { dom, root, dispose } = mount('/account');
    try {
      expect(root.querySelector<HTMLFormElement>('#profile-form')).not.toBeNull();
      expect(root.textContent).toContain('待验证');
      const name = root.querySelector<HTMLInputElement>('#auth-display-name')!;
      name.value = '新昵称';
      submit(dom, root.querySelector<HTMLFormElement>('#profile-form')!);
      await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ display_name: '新昵称' }));
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    } finally {
      dispose();
    }

    const passwordPage = mount('/account/password');
    try {
      expect(passwordPage.root.querySelector<HTMLFormElement>('#password-change-form')?.hidden).toBe(true);
      expect(passwordPage.root.textContent).toContain('请先验证邮箱');
      expect(passwordPage.root.querySelector('a[href="/forgot-password"]')).not.toBeNull();
    } finally {
      passwordPage.dispose();
    }
  });

  it('shows a login guide for 401 account state and a manual retry for unavailable service', async () => {
    vi.spyOn(authStore, 'bootstrap').mockResolvedValue();
    vi.spyOn(authStore, 'getState').mockReturnValue({ status: 'anonymous' });
    const anonymous = mount('/account');
    try {
      expect(anonymous.root.querySelector('a[href="/login"]')).not.toBeNull();
    } finally {
      anonymous.dispose();
    }

    let serviceAvailable = false;
    const me = vi.fn(async () => {
      if (!serviceAvailable) throw new AuthApiError(503, 'AUTH_UNAVAILABLE', '账号服务暂不可用');
      return session();
    });
    const storeApi: AuthStoreApi = {
      me,
      refreshSession: vi.fn(async () => ({ expires_at: 30_000, csrf_token: 'session-csrf' })),
      logout: vi.fn(async () => undefined),
      setSessionCsrf: vi.fn(),
      clearSessionCsrf: vi.fn(),
      onSessionFailure: vi.fn(() => () => undefined),
      sessionRevision: 0,
    };
    const store = new AuthStore(storeApi, { broadcastChannel: null });
    const unavailable = mount('/account', store);
    try {
      await store.bootstrap();
      expect(store.getState()).toMatchObject({ status: 'disabled', message: '账号服务暂不可用' });
      expect(me).toHaveBeenCalledTimes(1);
      const retry = unavailable.root.querySelector<HTMLButtonElement>('[data-auth-retry]')!;
      expect(retry.hidden).toBe(false);

      serviceAvailable = true;
      retry.click();
      await vi.waitFor(() => expect(store.getState().status).toBe('pending'));
      expect(me).toHaveBeenCalledTimes(2);
      expect(unavailable.root.querySelector<HTMLElement>('#account-profile')?.hidden).toBe(false);
    } finally {
      unavailable.dispose();
    }
  });

  it('does not clear a same-user session refreshed while a password change is pending', async () => {
    authStore.setSession(session('ACTIVE'));
    let finishChange!: () => void;
    const change = vi.spyOn(authApi, 'changePassword').mockImplementation(() => new Promise((resolve) => {
      finishChange = resolve;
    }));
    const clear = vi.spyOn(authStore, 'clear');
    const { dom, root, dispose } = mount('/account/password');
    try {
      root.querySelector<HTMLInputElement>('#auth-current-password')!.value = 'oldpass';
      root.querySelector<HTMLInputElement>('#auth-password')!.value = 'newpass';
      root.querySelector<HTMLInputElement>('#auth-password-confirmation')!.value = 'newpass';
      submit(dom, root.querySelector<HTMLFormElement>('#password-change-form')!);
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1));

      authStore.setSession({ ...session('ACTIVE'), csrf_token: 'new-session-csrf' });
      finishChange();
      await Promise.resolve();
      await Promise.resolve();

      expect(clear).not.toHaveBeenCalled();
      expect(authStore.getState().status).toBe('active');
    } finally {
      dispose();
    }
  });

  it('routes auth pages before analytics while keeping /accounts on its existing page', async () => {
    vi.doMock('../src/analytics', () => ({
      AnalyticsEvent: { Search: 'search', ItemHistory: 'history', MapOpen: 'map', QqGroupCopy: 'copy', AutocompleteSelect: 'select', CopyCommand: 'command' },
      initAnalytics: mainMocks.initAnalytics,
      track: mainMocks.track,
    }));
    vi.doMock('../src/auth/pages', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/auth/pages')>()),
      mountAuthPage: mainMocks.mountAuthPage,
    }));
    vi.doMock('../src/accounts-page', () => ({ mountAccountsPage: mainMocks.mountAccountsPage }));

    const auth = installDom('/register');
    await import('../src/main').catch(() => undefined);
    expect(mainMocks.initAnalytics).not.toHaveBeenCalled();
    expect(mainMocks.track).not.toHaveBeenCalled();
    expect(auth.dom.window.document.getElementById('LA_COLLECT')).toBeNull();
    expect(mainMocks.mountAuthPage).toHaveBeenCalledWith(auth.root, '/register', expect.anything(), expect.anything());

    vi.resetModules();
    vi.clearAllMocks();
    restoreDom?.();
    const accounts = installDom('/accounts');
    await import('../src/main');
    expect(mainMocks.initAnalytics).toHaveBeenCalledTimes(1);
    expect(mainMocks.mountAccountsPage).toHaveBeenCalledTimes(1);
    accounts.dom.window.close();
  });
});
