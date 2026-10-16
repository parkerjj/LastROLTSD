import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, authApi } from '../src/auth/api';
import { mountAuthDialogs } from '../src/auth/dialogs';
import { AuthStore, type AuthStoreApi } from '../src/auth/store';
import type { AuthAcceptedResponse, AuthSessionResponse } from '../src/auth/types';

let restoreDom: (() => void) | undefined;

function session(
  status: 'ACTIVE' | 'PENDING_EMAIL' = 'PENDING_EMAIL',
  id = '10000',
  email = 'player@example.test',
): AuthSessionResponse {
  return {
    user: {
      id, email, display_name: '主号', status,
      email_verified_at: status === 'ACTIVE' ? 1 : null, created_at: 1,
      has_avatar: false, avatar_version: 0, avatar_url: `/api/v1/users/${id}/avatar?v=0`,
    },
    expires_at: 30_000, csrf_token: 'session-csrf',
    mail_availability: status === 'PENDING_EMAIL' ? { code: 'AVAILABLE', retry_at: null } : null,
  };
}

function storeApiStub(): AuthStoreApi {
  return {
    me: vi.fn(async () => { throw new AuthApiError(401, 'AUTH_UNAUTHENTICATED', '请先登录'); }),
    refreshSession: vi.fn(async () => ({ expires_at: 30_000, csrf_token: 'session-csrf' })),
    logout: vi.fn(async () => undefined),
    setSessionCsrf: vi.fn(),
    clearSessionCsrf: vi.fn(),
    onSessionFailure: vi.fn(() => () => undefined),
    sessionRevision: 0,
  };
}

function mount() {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/' });
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
  const doc = dom.window.document;
  const store = new AuthStore(storeApiStub(), { broadcastChannel: null });
  const dispose = mountAuthDialogs(doc, store, authApi);
  const open = (kind: 'login' | 'register' | 'forgot' | 'password'): HTMLButtonElement => {
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    if (kind === 'login') trigger.dataset.openLogin = '';
    else if (kind === 'register') trigger.dataset.openRegister = '';
    else if (kind === 'forgot') trigger.dataset.openForgot = '';
    else trigger.dataset.openPassword = '';
    doc.body.append(trigger);
    trigger.click();
    return trigger;
  };
  return { dom, doc, store, dispose, open };
}

function submit(dom: JSDOM, form: HTMLFormElement): void {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

function dialogStatus(doc: Document, scrim: string): HTMLElement {
  return doc.querySelector<HTMLElement>(`[data-${scrim}-scrim] [data-dialog-status]`)!;
}

afterEach(() => {
  restoreDom?.();
  vi.restoreAllMocks();
});

describe('auth dialogs', () => {
  it('opens the login dialog from a trigger and closes it via button, Escape, and scrim click', () => {
    const { dom, doc, dispose, open } = mount();
    try {
      const trigger = open('login');
      expect(doc.body.classList.contains('login-open')).toBe(true);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(true);
      expect(doc.activeElement).toBe(doc.querySelector('#dialogLoginEmail'));

      doc.querySelector<HTMLButtonElement>('[data-close-login]')!.click();
      expect(doc.body.classList.contains('login-open')).toBe(false);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);
      expect(doc.activeElement).toBe(trigger);

      open('login');
      doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(doc.body.classList.contains('login-open')).toBe(false);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);

      open('login');
      doc.querySelector<HTMLElement>('[data-login-scrim] .login-dialog')!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
      expect(doc.body.classList.contains('login-open')).toBe(true);
      doc.querySelector<HTMLElement>('[data-login-scrim]')!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
      expect(doc.body.classList.contains('login-open')).toBe(false);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);
    } finally {
      dispose();
    }
  });

  it('switches from register to login and clears the register draft', () => {
    const { doc, dispose, open } = mount();
    try {
      open('register');
      expect(doc.body.classList.contains('register-open')).toBe(true);
      doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!.value = 'typed@example.test';
      doc.querySelector<HTMLButtonElement>('[data-register-scrim] [data-switch-login]')!.click();
      expect(doc.body.classList.contains('register-open')).toBe(false);
      expect(doc.body.classList.contains('login-open')).toBe(true);

      open('register');
      expect(doc.body.classList.contains('register-open')).toBe(true);
      expect(doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!.value).toBe('');
    } finally {
      dispose();
    }
  });

  it('opens the forgot dialog from the login dialog field button', () => {
    const { doc, dispose, open } = mount();
    try {
      open('login');
      doc.querySelector<HTMLButtonElement>('[data-login-scrim] [data-open-forgot]')!.click();
      expect(doc.body.classList.contains('login-open')).toBe(false);
      expect(doc.body.classList.contains('forgot-open')).toBe(true);
      expect(doc.activeElement).toBe(doc.querySelector('#dialogForgotEmail'));
    } finally {
      dispose();
    }
  });

  it('validates fields before calling the password change api', async () => {
    const change = vi.spyOn(authApi, 'changePassword').mockResolvedValue(undefined);
    const { dom, doc, store, dispose, open } = mount();
    try {
      store.setSession(session('ACTIVE'));
      open('password');
      expect(doc.body.classList.contains('password-open')).toBe(true);
      expect(doc.activeElement).toBe(doc.querySelector('#dialogCurrentPassword'));

      const form = doc.querySelector<HTMLFormElement>('#dialog-password-form')!;
      submit(dom, form);
      expect(change).not.toHaveBeenCalled();
      expect(dialogStatus(doc, 'password').textContent).toBe('请填写当前密码。');

      doc.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value = 'oldpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPassword')!.value = 'newpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value = 'different';
      submit(dom, form);
      expect(change).not.toHaveBeenCalled();
      expect(dialogStatus(doc, 'password').textContent).toBe('两次输入的新密码不一致。');
      expect(change).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('submits the password change and offers re-login on success', async () => {
    const change = vi.spyOn(authApi, 'changePassword').mockResolvedValue(undefined);
    const { dom, doc, store, dispose, open } = mount();
    try {
      store.setSession(session('ACTIVE'));
      open('password');
      const form = doc.querySelector<HTMLFormElement>('#dialog-password-form')!;
      doc.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value = 'oldpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPassword')!.value = 'newpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value = 'newpass';
      submit(dom, form);

      await vi.waitFor(() => expect(change).toHaveBeenCalledWith({
        current_password: 'oldpass',
        new_password: 'newpass',
        new_password_confirmation: 'newpass',
      }));

      // 成功即吊销全部会话：本地状态立刻清空，但浮层保留展示成功提示
      await vi.waitFor(() => expect(store.getState().status).toBe('anonymous'));
      const success = doc.querySelector<HTMLElement>('[data-password-success]')!;
      await vi.waitFor(() => expect(success.hidden).toBe(false));
      expect(form.hidden).toBe(true);
      expect(doc.body.classList.contains('password-open')).toBe(true);

      doc.querySelector<HTMLButtonElement>('[data-password-relogin]')!.click();
      expect(doc.body.classList.contains('password-open')).toBe(false);
      expect(doc.body.classList.contains('login-open')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('resets the password dialog after closing from the success state', async () => {
    const change = vi.spyOn(authApi, 'changePassword').mockResolvedValue(undefined);
    const { dom, doc, store, dispose, open } = mount();
    try {
      store.setSession(session('ACTIVE'));
      open('password');
      const form = doc.querySelector<HTMLFormElement>('#dialog-password-form')!;
      doc.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value = 'oldpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPassword')!.value = 'newpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value = 'newpass';
      submit(dom, form);
      await vi.waitFor(() => expect(doc.querySelector<HTMLElement>('[data-password-success]')!.hidden).toBe(false));

      doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(doc.body.classList.contains('password-open')).toBe(false);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);
      expect(form.hidden).toBe(false);
      expect(doc.querySelector<HTMLElement>('[data-password-success]')!.hidden).toBe(true);
      expect(form.querySelector<HTMLButtonElement>('.login-dialog-submit')!.textContent).toBe('确认修改');
    } finally {
      dispose();
    }
  });

  it('blocks pending users with a verification message before calling the api', async () => {
    const change = vi.spyOn(authApi, 'changePassword');
    const { dom, doc, store, dispose, open } = mount();
    try {
      store.setSession(session());
      open('password');
      const form = doc.querySelector<HTMLFormElement>('#dialog-password-form')!;
      doc.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value = 'oldpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPassword')!.value = 'newpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value = 'newpass';
      submit(dom, form);

      expect(dialogStatus(doc, 'password').textContent).toBe('请先完成邮箱验证后再修改密码。');
      expect(change).not.toHaveBeenCalled();
      expect(doc.body.classList.contains('password-open')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('keeps the password dialog open with an error when the change fails', async () => {
    const change = vi.spyOn(authApi, 'changePassword').mockRejectedValue(
      new AuthApiError(400, 'AUTH_PASSWORD_INVALID', '密码格式不正确'),
    );
    const { dom, doc, store, dispose, open } = mount();
    try {
      store.setSession(session('ACTIVE'));
      open('password');
      const form = doc.querySelector<HTMLFormElement>('#dialog-password-form')!;
      doc.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value = 'oldpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPassword')!.value = 'newpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value = 'newpass';
      submit(dom, form);

      await vi.waitFor(() => expect(dialogStatus(doc, 'password').textContent).toBe('密码格式不正确'));
      expect(change).toHaveBeenCalledTimes(1);
      expect(doc.body.classList.contains('password-open')).toBe(true);
      expect(form.hidden).toBe(false);
      const submitButton = form.querySelector<HTMLButtonElement>('.login-dialog-submit')!;
      expect(submitButton.disabled).toBe(false);
      expect(submitButton.textContent).toBe('确认修改');
    } finally {
      dispose();
    }
  });

  it('preserves a newer session when the password change completes', async () => {
    let finishChange!: () => void;
    const change = vi.spyOn(authApi, 'changePassword').mockImplementation(
      () => new Promise<void>((resolve) => { finishChange = resolve; }),
    );
    const { dom, doc, store, dispose, open } = mount();
    try {
      store.setSession(session('ACTIVE'));
      open('password');
      const form = doc.querySelector<HTMLFormElement>('#dialog-password-form')!;
      doc.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value = 'oldpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPassword')!.value = 'newpass';
      doc.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value = 'newpass';
      submit(dom, form);
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1));

      // 改密请求仍在进行时，另一个账号登录（本页/其它标签页对账后的本地状态）
      store.setSession(session('ACTIVE', '20000', 'other@example.test'));

      finishChange();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      // 不得清掉更新的会话，也不展示属于原账号的成功态
      expect(store.getState()).toMatchObject({ status: 'active', user: { id: '20000' } });
      expect(doc.querySelector<HTMLElement>('[data-password-success]')!.hidden).toBe(true);
    } finally {
      dispose();
    }
  });

  it('requires an email and password before calling the login api', () => {
    const login = vi.spyOn(authApi, 'login');
    const { dom, doc, dispose, open } = mount();
    try {
      open('login');
      submit(dom, doc.querySelector<HTMLFormElement>('#dialog-login-form')!);
      expect(login).not.toHaveBeenCalled();
      const status = dialogStatus(doc, 'login');
      expect(status.hidden).toBe(false);
      expect(status.textContent).toBe('请填写邮箱和密码。');
      expect(status.classList.contains('error')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('shows a submitting state, stores the session, and closes on login success', async () => {
    let finishLogin!: (response: AuthSessionResponse) => void;
    const login = vi.spyOn(authApi, 'login').mockImplementation(() => new Promise((resolve) => {
      finishLogin = resolve;
    }));
    const { dom, doc, store, dispose, open } = mount();
    try {
      open('login');
      doc.querySelector<HTMLInputElement>('#dialogLoginEmail')!.value = ' player@example.test ';
      doc.querySelector<HTMLInputElement>('#dialogLoginPassword')!.value = 'password';
      const form = doc.querySelector<HTMLFormElement>('#dialog-login-form')!;
      submit(dom, form);
      expect(login).toHaveBeenCalledWith({ email: 'player@example.test', password: 'password' });
      expect(form.getAttribute('aria-busy')).toBe('true');
      const submitButton = form.querySelector<HTMLButtonElement>('.login-dialog-submit')!;
      expect(submitButton.disabled).toBe(true);
      expect(submitButton.textContent).toBe('正在登录…');
      expect(dialogStatus(doc, 'login').textContent).toBe('正在登录…');

      finishLogin(session('ACTIVE'));
      await vi.waitFor(() => expect(doc.body.classList.contains('login-open')).toBe(false));
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);
      expect(store.getState().status).toBe('active');
    } finally {
      dispose();
    }
  });

  it('keeps the dialog open with an error status when login fails', async () => {
    const login = vi.spyOn(authApi, 'login').mockRejectedValue(
      new AuthApiError(503, 'AUTH_UNAVAILABLE', '账号服务暂不可用'),
    );
    const { dom, doc, dispose, open } = mount();
    try {
      open('login');
      doc.querySelector<HTMLInputElement>('#dialogLoginEmail')!.value = 'player@example.test';
      doc.querySelector<HTMLInputElement>('#dialogLoginPassword')!.value = 'wrong-password';
      const form = doc.querySelector<HTMLFormElement>('#dialog-login-form')!;
      submit(dom, form);
      await vi.waitFor(() => expect(dialogStatus(doc, 'login').textContent).toBe('账号服务暂不可用，请重试。'));
      expect(login).toHaveBeenCalledTimes(1);
      expect(doc.body.classList.contains('login-open')).toBe(true);
      expect(dialogStatus(doc, 'login').classList.contains('error')).toBe(true);
      const submitButton = form.querySelector<HTMLButtonElement>('.login-dialog-submit')!;
      expect(submitButton.disabled).toBe(false);
      expect(submitButton.textContent).toBe('登录');
      expect(form.getAttribute('aria-busy')).toBe('false');
    } finally {
      dispose();
    }
  });

  it('marks invalid register fields and clears the mark on input', () => {
    const register = vi.spyOn(authApi, 'register');
    const { dom, doc, dispose, open } = mount();
    try {
      open('register');
      const email = doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!;
      const name = doc.querySelector<HTMLInputElement>('#dialogRegisterName')!;
      const password = doc.querySelector<HTMLInputElement>('#dialogRegisterPassword')!;
      const confirmation = doc.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!;
      const form = doc.querySelector<HTMLFormElement>('#dialog-register-form')!;
      const fieldOf = (input: HTMLInputElement) => input.closest('.form-field')!;

      submit(dom, form);
      expect(register).not.toHaveBeenCalled();
      expect(fieldOf(email).classList.contains('is-error')).toBe(true);
      expect(fieldOf(name).classList.contains('is-error')).toBe(true);
      expect(email.getAttribute('aria-invalid')).toBe('true');
      expect(dialogStatus(doc, 'register').textContent).toBe('请填写邮箱和昵称/主要游戏角色名（1–32 个字符）。');

      email.value = 'player@example.test';
      email.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      expect(fieldOf(email).classList.contains('is-error')).toBe(false);
      expect(email.hasAttribute('aria-invalid')).toBe(false);

      name.value = '主号';
      password.value = '短';
      confirmation.value = '短';
      submit(dom, form);
      expect(register).not.toHaveBeenCalled();
      expect(fieldOf(password).classList.contains('is-error')).toBe(true);
      expect(dialogStatus(doc, 'register').textContent).toBe('密码长度需为 5–256 个字符。');

      password.value = 'password';
      password.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      confirmation.value = '不一致的密码';
      submit(dom, form);
      expect(register).not.toHaveBeenCalled();
      expect(fieldOf(password).classList.contains('is-error')).toBe(false);
      expect(fieldOf(confirmation).classList.contains('is-error')).toBe(true);
      expect(dialogStatus(doc, 'register').textContent).toBe('两次输入的密码不一致。');
    } finally {
      dispose();
    }
  });

  it('registers, auto-logs in, and opens the success dialog with the account email', async () => {
    const register = vi.spyOn(authApi, 'register').mockResolvedValue({
      accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null },
    });
    const login = vi.spyOn(authApi, 'login').mockResolvedValue(session());
    const { dom, doc, store, dispose, open } = mount();
    try {
      open('register');
      expect(doc.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')?.accept)
        .toBe('image/jpeg,image/png,image/webp');
      const email = doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!;
      const name = doc.querySelector<HTMLInputElement>('#dialogRegisterName')!;
      const password = doc.querySelector<HTMLInputElement>('#dialogRegisterPassword')!;
      const confirmation = doc.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!;
      email.value = 'player@example.test';
      name.value = '  主号  ';
      password.value = '🙂'.repeat(256);
      confirmation.value = password.value;
      const toggle = doc.querySelector<HTMLButtonElement>('[data-register-scrim] [data-toggle-password]')!;
      toggle.click();
      expect(password.type).toBe('text');
      expect(toggle.getAttribute('aria-label')).toBe('隐藏密码');

      submit(dom, doc.querySelector<HTMLFormElement>('#dialog-register-form')!);
      await vi.waitFor(() => expect(register).toHaveBeenCalledWith({
        email: 'player@example.test',
        display_name: '主号',
        password: '🙂'.repeat(256),
        password_confirmation: '🙂'.repeat(256),
      }));
      expect(register.mock.calls[0]![0].avatar_base64).toBeUndefined();
      await vi.waitFor(() => expect(login).toHaveBeenCalledWith({
        email: 'player@example.test', password: '🙂'.repeat(256),
      }));
      expect(register.mock.invocationCallOrder[0]!).toBeLessThan(login.mock.invocationCallOrder[0]!);
      await vi.waitFor(() => expect(doc.body.classList.contains('success-open')).toBe(true));
      expect(doc.body.classList.contains('register-open')).toBe(false);
      expect(doc.querySelector<HTMLElement>('[data-success-email]')?.textContent)
        .toBe('当前账号邮箱：player@example.test');
      // 「返回首页」是真正导航回首页的链接，「先逛逛」仅关闭浮层
      const home = doc.querySelector<HTMLAnchorElement>('[data-success-scrim] .success-actions a');
      expect(home?.getAttribute('href')).toBe('/');
      expect(home?.textContent).toBe('我已完成验证，返回首页');
      expect(doc.querySelector<HTMLButtonElement>('[data-success-scrim] .success-actions button[data-close-success]')).not.toBeNull();
      expect(store.getState()).toMatchObject({ status: 'pending', user: { email: 'player@example.test' } });
      expect(password.value).toBe('');
      expect(password.type).toBe('password');
      expect(confirmation.value).toBe('');

      doc.querySelector<HTMLButtonElement>('[data-success-scrim] [data-close-success]')!.click();
      expect(doc.body.classList.contains('success-open')).toBe(false);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);
    } finally {
      dispose();
    }
  });

  it('retries a failed auto-login in place and still reaches the success dialog', async () => {
    const register = vi.spyOn(authApi, 'register').mockResolvedValue({
      accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null },
    });
    const login = vi.spyOn(authApi, 'login')
      .mockRejectedValueOnce(new Error('网络连接失败'))
      .mockResolvedValue(session());
    const { dom, doc, store, dispose, open } = mount();
    try {
      open('register');
      doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!.value = 'player@example.test';
      doc.querySelector<HTMLInputElement>('#dialogRegisterName')!.value = '主号';
      doc.querySelector<HTMLInputElement>('#dialogRegisterPassword')!.value = 'password';
      doc.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!.value = 'password';
      submit(dom, doc.querySelector<HTMLFormElement>('#dialog-register-form')!);

      const retry = doc.querySelector<HTMLButtonElement>('[data-retry-autologin]')!;
      await vi.waitFor(() => expect(retry.hidden).toBe(false));
      expect(dialogStatus(doc, 'register').textContent)
        .toBe('注册请求已受理，但自动登录失败。请在登录页面使用相同邮箱和密码重试。');
      expect(doc.body.classList.contains('register-open')).toBe(true);

      retry.click();
      await vi.waitFor(() => expect(doc.body.classList.contains('success-open')).toBe(true));
      expect(login).toHaveBeenCalledTimes(2);
      expect(login.mock.calls[1]![0]).toEqual({ email: 'player@example.test', password: 'password' });
      expect(doc.querySelector<HTMLElement>('[data-success-email]')?.textContent)
        .toBe('当前账号邮箱：player@example.test');
      expect(store.getState().status).toBe('pending');
    } finally {
      dispose();
    }
  });

  it('skips auto-login when the session identity changed during registration', async () => {
    let finishRegister!: (response: AuthAcceptedResponse) => void;
    const register = vi.spyOn(authApi, 'register').mockImplementation(
      () => new Promise((resolve) => { finishRegister = resolve; }),
    );
    const login = vi.spyOn(authApi, 'login');
    const { dom, doc, store, dispose, open } = mount();
    try {
      open('register');
      doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!.value = 'player@example.test';
      doc.querySelector<HTMLInputElement>('#dialogRegisterName')!.value = '主号';
      doc.querySelector<HTMLInputElement>('#dialogRegisterPassword')!.value = 'password';
      doc.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!.value = 'password';
      submit(dom, doc.querySelector<HTMLFormElement>('#dialog-register-form')!);
      await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));

      // 注册请求仍在进行时，另一个账号登录，本地身份发生变化
      store.setSession(session('ACTIVE', '20000', 'other@example.test'));

      finishRegister({ accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null } });
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      // 不再用注册凭证自动登录，也不弹注册完成浮层
      expect(login).not.toHaveBeenCalled();
      expect(doc.body.classList.contains('success-open')).toBe(false);
      expect(store.getState()).toMatchObject({ status: 'active', user: { id: '20000' } });
    } finally {
      dispose();
    }
  });

  it('walks the forgot dialog through empty, submitting, and accepted states', async () => {
    let finishRequest!: (response: AuthAcceptedResponse) => void;
    const request = vi.spyOn(authApi, 'requestPasswordReset').mockImplementation(
      () => new Promise((resolve) => { finishRequest = resolve; }),
    );
    const { dom, doc, dispose, open } = mount();
    try {
      open('forgot');
      const form = doc.querySelector<HTMLFormElement>('#dialog-forgot-form')!;
      const email = doc.querySelector<HTMLInputElement>('#dialogForgotEmail')!;

      submit(dom, form);
      expect(request).not.toHaveBeenCalled();
      expect(dialogStatus(doc, 'forgot').textContent).toBe('请填写邮箱。');
      expect(dialogStatus(doc, 'forgot').querySelector('.ph-warning')).not.toBeNull();

      email.value = 'player@example.test';
      submit(dom, form);
      expect(request).toHaveBeenCalledWith({ email: 'player@example.test' });
      expect(dialogStatus(doc, 'forgot').textContent).toBe('正在提交申请…');
      expect(form.getAttribute('aria-busy')).toBe('true');

      finishRequest({ accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null } });
      await vi.waitFor(() => expect(dialogStatus(doc, 'forgot').textContent).toContain('申请已受理'));
      expect(dialogStatus(doc, 'forgot').querySelector('.ph-envelope-simple')).not.toBeNull();
      expect(form.getAttribute('aria-busy')).toBe('false');
      expect(doc.body.classList.contains('forgot-open')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('closes any open dialog when the session identity changes', () => {
    const { doc, store, dispose, open } = mount();
    try {
      open('forgot');
      expect(doc.body.classList.contains('forgot-open')).toBe(true);
      store.setSession(session());
      expect(doc.body.classList.contains('forgot-open')).toBe(false);
      expect(doc.body.classList.contains('auth-dialog-open')).toBe(false);
    } finally {
      dispose();
    }
  });

  it('returns focus to the rebuilt account trigger after a login identity change', () => {
    const { doc, store, dispose, open } = mount();
    try {
      open('login');
      const rebuiltTrigger = doc.createElement('button');
      rebuiltTrigger.className = 'account-trigger';
      doc.body.append(rebuiltTrigger);

      store.setSession(session('ACTIVE'));

      expect(doc.body.classList.contains('login-open')).toBe(false);
      expect(doc.activeElement).toBe(rebuiltTrigger);
    } finally {
      dispose();
    }
  });

  it('returns focus to the account trigger when the success dialog closes', async () => {
    const register = vi.spyOn(authApi, 'register').mockResolvedValue({
      accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null },
    });
    const login = vi.spyOn(authApi, 'login').mockResolvedValue(session());
    const { dom, doc, dispose, open } = mount();
    try {
      const rebuiltTrigger = doc.createElement('button');
      rebuiltTrigger.className = 'account-trigger';
      doc.body.append(rebuiltTrigger);
      open('register');
      doc.querySelector<HTMLInputElement>('#dialogRegisterEmail')!.value = 'player@example.test';
      doc.querySelector<HTMLInputElement>('#dialogRegisterName')!.value = '主号';
      doc.querySelector<HTMLInputElement>('#dialogRegisterPassword')!.value = 'password';
      doc.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!.value = 'password';
      submit(dom, doc.querySelector<HTMLFormElement>('#dialog-register-form')!);
      await vi.waitFor(() => expect(doc.body.classList.contains('success-open')).toBe(true));

      doc.querySelector<HTMLButtonElement>('[data-success-scrim] [data-close-success]')!.click();
      expect(doc.activeElement).toBe(rebuiltTrigger);
    } finally {
      dispose();
    }
  });
});
