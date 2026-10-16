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

function installAvatarCanvas(dom: JSDOM) {
  const drawImage = vi.fn();
  const context = { clearRect: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(dom.window, 'createImageBitmap', {
    configurable: true,
    value: vi.fn(async () => ({ width: 256, height: 256, close: vi.fn() })),
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => context,
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value(callback: BlobCallback) { callback(new Blob([new Uint8Array(12)], { type: 'image/webp' })); },
  });
  return { drawImage };
}

function selectAvatarFile(dom: JSDOM, input: HTMLInputElement, name = 'new.png'): void {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new dom.window.File(['synthetic pixels'], name, { type: 'image/png' })],
  });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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
  it('matches the retained account paths and leaves removed dialog routes and the game monitor route alone', () => {
    for (const path of ['/verify-email', '/reset-password', '/account']) {
      expect(isAuthPage(path)).toBe(true);
      expect(isAuthPage(`${path}/`)).toBe(true);
    }
    for (const removed of ['/register', '/login', '/check-email', '/forgot-password', '/account/password']) {
      expect(isAuthPage(removed)).toBe(false);
    }
    expect(isAuthPage('/accounts')).toBe(false);
  });

  it('offers independent avatar save and delete actions on the account page', () => {
    authStore.setSession(session());
    const { root, dispose } = mount('/account');
    try {
      expect(root.querySelector<HTMLElement>('#account-avatar-editor')).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>('#account-avatar-save')).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>('#account-avatar-delete')).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('keeps the old account avatar and editable preview after an upload failure', async () => {
    authStore.setSession(session());
    const save = vi.spyOn(authApi, 'setAvatar').mockRejectedValue(new Error('网络连接失败'));
    const { dom, root, dispose } = mount('/account');
    installAvatarCanvas(dom);
    try {
      const name = root.querySelector<HTMLInputElement>('#auth-display-name')!;
      name.value = '还没保存的昵称';
      name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      const file = root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')!;
      selectAvatarFile(dom, file);
      await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('#account-avatar-save')?.disabled).toBe(false));

      root.querySelector<HTMLButtonElement>('#account-avatar-save')!.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(root.querySelector<HTMLElement>('#account-avatar-status')?.textContent).toContain('网络连接失败'));

      expect(save.mock.calls[0]![0].avatar_base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
      expect(root.querySelector<HTMLCanvasElement>('#account-avatar-editor canvas')?.hidden).toBe(false);
      expect(file.disabled).toBe(false);
      expect(file.files?.[0]?.name).toBe('new.png');
      expect(name.value).toBe('还没保存的昵称');
      expect(root.querySelector<HTMLElement>('#account-avatar-placeholder')?.textContent).toBe('旧');
      expect(root.querySelector<HTMLImageElement>('#account-avatar-image')?.hidden).toBe(true);
      expect(root.querySelector<HTMLFormElement>('#profile-form [data-auth-status]')?.textContent).toBe('');
    } finally {
      dispose();
    }
  });

  it('freezes the avatar editor through a same-user PUT and reconciliation', async () => {
    authStore.setSession(session());
    let finishSave!: (response: { user: AuthSessionResponse['user'] }) => void;
    const save = vi.spyOn(authApi, 'setAvatar').mockImplementation(() => new Promise((resolve) => {
      finishSave = resolve;
    }));
    let finishReconcile!: () => void;
    const reconcile = vi.spyOn(authStore, 'reconcile').mockImplementation(() => new Promise((resolve) => {
      finishReconcile = resolve;
    }));
    const { dom, root, dispose } = mount('/account');
    const { drawImage } = installAvatarCanvas(dom);
    const decode = vi.fn(async () => ({ width: 512, height: 256, close: vi.fn() }));
    Object.defineProperty(dom.window, 'createImageBitmap', { configurable: true, value: decode });
    try {
      const file = root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')!;
      const saveButton = root.querySelector<HTMLButtonElement>('#account-avatar-save')!;
      selectAvatarFile(dom, file, 'first.png');
      await vi.waitFor(() => expect(saveButton.disabled).toBe(false));
      saveButton.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      const zoom = root.querySelector<HTMLInputElement>('#account-avatar-editor [data-avatar-zoom]')!;
      const crop = root.querySelector<HTMLCanvasElement>('#account-avatar-editor [data-avatar-crop]')!;
      const cancel = root.querySelector<HTMLButtonElement>('#account-avatar-editor [data-avatar-cancel]')!;
      expect(file.disabled).toBe(true);
      expect(zoom.disabled).toBe(true);
      expect(cancel.disabled).toBe(true);
      expect(crop.tabIndex).toBe(-1);

      const drawCount = drawImage.mock.calls.length;
      const decodeCount = decode.mock.calls.length;
      selectAvatarFile(dom, file, 'second.png');
      zoom.value = '2';
      zoom.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      crop.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }));
      crop.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 24, clientY: 12, bubbles: true }));
      const keydown = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      crop.dispatchEvent(keydown);
      cancel.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      expect(decode).toHaveBeenCalledTimes(decodeCount);
      expect(drawImage).toHaveBeenCalledTimes(drawCount);
      expect(keydown.defaultPrevented).toBe(false);
      expect(crop.hidden).toBe(false);

      const savedUser = {
        ...session().user,
        has_avatar: true,
        avatar_version: 1,
        avatar_url: '/api/v1/users/10000/avatar?v=1',
      };
      finishSave({ user: savedUser });
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
      expect(root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')?.disabled).toBe(true);
      finishReconcile();
      await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')?.disabled).toBe(false));
      expect(root.querySelector<HTMLImageElement>('#account-avatar-image')?.getAttribute('src')).toBe(savedUser.avatar_url);
    } finally {
      dispose();
    }
  });

  it('cancels a local avatar draft without changing the stored account avatar', async () => {
    const current = session();
    current.user.has_avatar = true;
    current.user.avatar_version = 4;
    current.user.avatar_url = '/api/v1/users/10000/avatar?v=4';
    authStore.setSession(current);
    const save = vi.spyOn(authApi, 'setAvatar');
    const remove = vi.spyOn(authApi, 'deleteAvatar');
    const { dom, root, dispose } = mount('/account');
    installAvatarCanvas(dom);
    try {
      const file = root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')!;
      selectAvatarFile(dom, file);
      await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('#account-avatar-save')?.disabled).toBe(false));
      root.querySelector<HTMLButtonElement>('#account-avatar-editor [data-avatar-cancel]')!.click();

      expect(root.querySelector<HTMLCanvasElement>('#account-avatar-editor canvas')?.hidden).toBe(true);
      expect(root.querySelector<HTMLButtonElement>('#account-avatar-save')?.disabled).toBe(true);
      expect(root.querySelector<HTMLImageElement>('#account-avatar-image')?.getAttribute('src')).toBe(current.user.avatar_url);
      expect(root.querySelector<HTMLButtonElement>('#account-avatar-delete')?.hidden).toBe(false);
      root.querySelector<HTMLButtonElement>('#account-avatar-save')!.click();
      expect(save).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('requires a small confirmation before deleting the stored avatar', async () => {
    const current = session();
    current.user.has_avatar = true;
    current.user.avatar_version = 4;
    current.user.avatar_url = '/api/v1/users/10000/avatar?v=4';
    authStore.setSession(current);
    const deletedUser = { ...current.user, has_avatar: false, avatar_version: 5, avatar_url: '/api/v1/users/10000/avatar?v=5' };
    const remove = vi.spyOn(authApi, 'deleteAvatar').mockResolvedValue({ user: deletedUser });
    vi.spyOn(authStore, 'reconcile').mockResolvedValue();
    const { root, dispose } = mount('/account');
    try {
      const removeButton = root.querySelector<HTMLButtonElement>('#account-avatar-delete')!;
      const confirmation = root.querySelector<HTMLElement>('#account-avatar-delete-confirmation')!;
      removeButton.click();
      expect(confirmation.hidden).toBe(false);
      root.querySelector<HTMLButtonElement>('#account-avatar-delete-cancel')!.click();
      expect(confirmation.hidden).toBe(true);
      expect(remove).not.toHaveBeenCalled();

      removeButton.click();
      root.querySelector<HTMLButtonElement>('#account-avatar-delete-confirm')!.click();
      await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(root.querySelector<HTMLElement>('#account-avatar-status')?.textContent).toBe('头像已删除。'));
      expect(confirmation.hidden).toBe(true);
      expect(root.querySelector<HTMLImageElement>('#account-avatar-image')?.hidden).toBe(true);
      expect(root.querySelector<HTMLElement>('#account-avatar-placeholder')?.hidden).toBe(false);
    } finally {
      dispose();
    }
  });

  it('clears an old avatar draft when identity changes during a save request', async () => {
    authStore.setSession(session());
    let finishSave!: (response: { user: AuthSessionResponse['user'] }) => void;
    const save = vi.spyOn(authApi, 'setAvatar').mockImplementation(() => new Promise((resolve) => {
      finishSave = resolve;
    }));
    const { dom, root, dispose } = mount('/account');
    installAvatarCanvas(dom);
    try {
      const file = root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')!;
      selectAvatarFile(dom, file);
      await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('#account-avatar-save')?.disabled).toBe(false));
      root.querySelector<HTMLButtonElement>('#account-avatar-save')!.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      const next = session();
      next.user.id = '10001';
      next.user.email = 'other@example.test';
      next.user.display_name = 'B号';
      authStore.setSession(next);
      expect(root.querySelector<HTMLInputElement>('#account-avatar-editor input[type="file"]')?.files?.length ?? 0).toBe(0);
      expect(root.querySelector<HTMLCanvasElement>('#account-avatar-editor canvas')?.hidden).toBe(true);
      expect(root.querySelector<HTMLInputElement>('#auth-display-name')?.value).toBe('B号');

      finishSave({ user: { ...session().user, avatar_version: 1, has_avatar: true, avatar_url: '/api/v1/users/10000/avatar?v=1' } });
      await Promise.resolve();
      await Promise.resolve();
      expect(root.querySelector<HTMLElement>('#account-avatar-placeholder')?.textContent).toBe('B');
      expect(root.querySelector<HTMLImageElement>('#account-avatar-image')?.hidden).toBe(true);
      expect(root.querySelector<HTMLElement>('#account-avatar-status')?.textContent).toBe('');
    } finally {
      dispose();
    }
  });

  it('lets a pending user update their profile and hides the password change entry', async () => {
    authStore.setSession(session());
    const update = vi.spyOn(authApi, 'updateProfile').mockResolvedValue({ user: { ...session().user, display_name: '新昵称' } });
    const reconcile = vi.spyOn(authStore, 'reconcile').mockResolvedValue();
    const { dom, root, dispose } = mount('/account');
    try {
      expect(root.querySelector<HTMLFormElement>('#profile-form')).not.toBeNull();
      expect(root.textContent).toContain('待验证');
      expect(root.querySelector<HTMLElement>('#account-password-link')?.hidden).toBe(true);
      const name = root.querySelector<HTMLInputElement>('#auth-display-name')!;
      name.value = '新昵称';
      submit(dom, root.querySelector<HTMLFormElement>('#profile-form')!);
      await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ display_name: '新昵称' }));
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    } finally {
      dispose();
    }
  });

  it('shows a login guide for 401 account state and a manual retry for unavailable service', async () => {
    vi.spyOn(authStore, 'bootstrap').mockResolvedValue();
    vi.spyOn(authStore, 'getState').mockReturnValue({ status: 'anonymous' });
    const anonymous = mount('/account');
    try {
      expect(anonymous.root.querySelector('button[data-open-login]')).not.toBeNull();
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

    const auth = installDom('/account');
    await import('../src/main').catch(() => undefined);
    expect(mainMocks.initAnalytics).not.toHaveBeenCalled();
    expect(mainMocks.track).not.toHaveBeenCalled();
    expect(auth.dom.window.document.getElementById('LA_COLLECT')).toBeNull();
    expect(mainMocks.mountAuthPage).toHaveBeenCalledWith(auth.root, '/account', expect.anything(), expect.anything());

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
