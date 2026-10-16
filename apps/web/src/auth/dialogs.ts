import { authApi, type AuthApiClient } from './api';
import { mountAvatarEditor, type AvatarEditor } from './avatar-editor';
import { authStore, type AuthStore } from './store';
import type { AuthSessionResponse, RegisterInput } from './types';
import {
  acceptedMessage,
  authErrorMessage,
  parseDisplayName,
  validatePassword,
} from './utils';

type DialogName = 'login' | 'register' | 'success' | 'forgot' | 'password';

const ALL_OPEN_CLASSES = ['login-open', 'register-open', 'success-open', 'forgot-open', 'password-open'];
const mountedDocuments = new WeakSet<Document>();

export function mountAuthDialogs(
  doc: Document,
  store: AuthStore = authStore,
  api: AuthApiClient = authApi,
): () => void {
  if (mountedDocuments.has(doc)) return () => undefined;
  mountedDocuments.add(doc);

  const host = doc.createElement('div');
  host.id = 'auth-dialogs';
  host.innerHTML = loginDialogMarkup() + registerDialogMarkup() + successDialogMarkup() + forgotDialogMarkup() + passwordDialogMarkup();
  doc.body.append(host);

  const loginDialog = host.querySelector<HTMLElement>('[data-login-scrim]')!;
  const registerDialog = host.querySelector<HTMLElement>('[data-register-scrim]')!;
  const successDialog = host.querySelector<HTMLElement>('[data-success-scrim]')!;
  const forgotDialog = host.querySelector<HTMLElement>('[data-forgot-scrim]')!;
  const passwordDialog = host.querySelector<HTMLElement>('[data-password-scrim]')!;
  const loginForm = host.querySelector<HTMLFormElement>('#dialog-login-form')!;
  const registerForm = host.querySelector<HTMLFormElement>('#dialog-register-form')!;
  const forgotForm = host.querySelector<HTMLFormElement>('#dialog-forgot-form')!;
  const passwordForm = host.querySelector<HTMLFormElement>('#dialog-password-form')!;
  const passwordSuccess = host.querySelector<HTMLElement>('[data-password-success]')!;
  const retryAutologinButton = host.querySelector<HTMLButtonElement>('[data-retry-autologin]')!;

  let openName: DialogName | null = null;
  let lastTrigger: HTMLElement | null = null;
  // 修改密码成功态展示中：此时本地会话已清（服务端已吊销全部会话），
  // identity-changed 不得关闭浮层，否则用户看不到成功提示
  let passwordSuccessShown = false;
  let registerEditor: AvatarEditor | null = null;
  let registerAvatarProcessing = false;
  let autologinRetry: { email: string; password: string } | null = null;
  let active = true;

  const setStatus = (dialog: HTMLElement, message: string, kind: 'info' | 'error', withIcon = false): void => {
    const status = dialog.querySelector<HTMLElement>('[data-dialog-status]');
    if (!status) return;
    status.hidden = false;
    status.className = `login-dialog-status${kind === 'error' ? ' error' : ''}${withIcon ? ' with-icon' : ''}`;
    if (withIcon) {
      const icon = doc.createElement('i');
      icon.className = `ph ${kind === 'error' ? 'ph-warning' : 'ph-envelope-simple'}`;
      icon.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.textContent = message;
      status.replaceChildren(icon, text);
    } else {
      status.textContent = message;
    }
  };

  const hideStatus = (dialog: HTMLElement): void => {
    const status = dialog.querySelector<HTMLElement>('[data-dialog-status]');
    if (!status) return;
    status.hidden = true;
    status.textContent = '';
  };

  const setBusy = (form: HTMLFormElement, busy: boolean, label?: string): void => {
    const submit = form.querySelector<HTMLButtonElement>('.login-dialog-submit');
    if (submit) {
      submit.disabled = busy;
      if (label !== undefined) submit.textContent = label;
    }
    form.setAttribute('aria-busy', String(busy));
  };

  const ensureRegisterEditor = (): AvatarEditor => {
    if (!registerEditor) {
      const container = host.querySelector<HTMLElement>('#register-avatar-editor')!;
      registerEditor = mountAvatarEditor(container, {
        compact: true,
        onChange: ({ processing }) => {
          registerAvatarProcessing = processing;
          const submit = registerForm.querySelector<HTMLButtonElement>('.login-dialog-submit');
          if (submit && registerForm.getAttribute('aria-busy') !== 'true') submit.disabled = processing;
        },
      });
    }
    return registerEditor;
  };

  const resetPasswordToggles = (dialog: HTMLElement): void => {
    dialog.querySelectorAll<HTMLButtonElement>('[data-toggle-password]').forEach((button) => {
      const wrap = button.closest('.login-field, .form-input-wrap');
      const input = wrap?.querySelector<HTMLInputElement>('input');
      if (input) input.type = 'password';
      button.setAttribute('aria-label', '显示密码');
      const icon = button.querySelector('i');
      if (icon) icon.className = 'ph ph-eye';
    });
  };

  const clearRegisterFieldErrors = (): void => {
    registerDialog.querySelectorAll('.form-field.is-error').forEach((field) => {
      field.classList.remove('is-error');
      field.querySelector('input')?.removeAttribute('aria-invalid');
    });
  };

  const cleanupDialog = (name: DialogName): void => {
    if (name === 'login') {
      loginForm.reset();
      hideStatus(loginDialog);
      setBusy(loginForm, false, '登录');
      resetPasswordToggles(loginDialog);
    } else if (name === 'register') {
      registerForm.reset();
      clearRegisterFieldErrors();
      hideStatus(registerDialog);
      setBusy(registerForm, false, '注册');
      resetPasswordToggles(registerDialog);
      retryAutologinButton.hidden = true;
      retryAutologinButton.disabled = false;
      autologinRetry = null;
      registerEditor?.reset();
      registerEditor?.setDisabled(false);
    } else if (name === 'forgot') {
      forgotForm.reset();
      hideStatus(forgotDialog);
      setBusy(forgotForm, false);
      resetPasswordToggles(forgotDialog);
    } else if (name === 'password') {
      passwordForm.reset();
      hideStatus(passwordDialog);
      setBusy(passwordForm, false, '确认修改');
      resetPasswordToggles(passwordDialog);
      // 成功态复位：表单重新可见，成功提示隐藏
      passwordForm.hidden = false;
      passwordSuccess.hidden = true;
      passwordSuccessShown = false;
    }
  };

  const focusFirstField = (name: DialogName): void => {
    const dialog = name === 'login' ? loginDialog
      : name === 'register' ? registerDialog
        : name === 'forgot' ? forgotDialog
          : name === 'password' ? passwordDialog
            : successDialog;
    const input = dialog.querySelector<HTMLInputElement>('input');
    (input ?? dialog.querySelector<HTMLElement>('.login-dialog-close'))?.focus();
  };

  const openDialog = (name: DialogName, trigger: HTMLElement | null): void => {
    if (!active || openName === name) return;
    const previous = openName;
    if (previous === null) lastTrigger = trigger;
    openName = name;
    doc.body.classList.remove(...ALL_OPEN_CLASSES);
    doc.body.classList.add(`${name}-open`, 'auth-dialog-open');
    if (previous !== null) cleanupDialog(previous);
    if (name === 'register') ensureRegisterEditor();
    focusFirstField(name);
  };

  const closeDialog = (restoreFocus = true): void => {
    if (openName === null) return;
    const closing = openName;
    openName = null;
    doc.body.classList.remove(...ALL_OPEN_CLASSES, 'auth-dialog-open');
    cleanupDialog(closing);
    if (restoreFocus) {
      if (lastTrigger && lastTrigger.isConnected) lastTrigger.focus();
      // 身份切换（如注册成功后跳成功浮层）会让原触发器脱离 DOM，
      // 此时把焦点归还到顶栏重建后的账号触发器，避免焦点落到 body
      else doc.querySelector<HTMLElement>('.account-trigger')?.focus();
    }
    lastTrigger = null;
  };

  const openSuccess = (email: string): void => {
    const target = successDialog.querySelector<HTMLElement>('[data-success-email]');
    if (target) target.textContent = `当前账号邮箱：${email}`;
    openDialog('success', null);
  };

  const onLoginSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (loginForm.getAttribute('aria-busy') === 'true') return;
    const email = loginForm.querySelector<HTMLInputElement>('#dialogLoginEmail')!.value.trim();
    const password = loginForm.querySelector<HTMLInputElement>('#dialogLoginPassword')!.value;
    if (!email || !password) {
      setStatus(loginDialog, '请填写邮箱和密码。', 'error');
      return;
    }
    setBusy(loginForm, true, '正在登录…');
    setStatus(loginDialog, '正在登录…', 'info');
    void api.login({ email, password }).then((response: AuthSessionResponse) => {
      if (!active) return;
      // 迟到响应守卫：浮层已切换/关闭时仅同步会话状态，不误关当前浮层
      store.setSession(response);
      if (openName === 'login') closeDialog();
    }).catch((error: unknown) => {
      if (active && openName === 'login') setStatus(loginDialog, authErrorMessage(error, '邮箱或密码不正确，或账号暂不可用。'), 'error');
    }).finally(() => {
      if (active && openName === 'login') setBusy(loginForm, false, '登录');
    });
  };

  const onRegisterSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (registerForm.getAttribute('aria-busy') === 'true') return;
    const emailInput = registerForm.querySelector<HTMLInputElement>('#dialogRegisterEmail')!;
    const nameInput = registerForm.querySelector<HTMLInputElement>('#dialogRegisterName')!;
    const passwordInput = registerForm.querySelector<HTMLInputElement>('#dialogRegisterPassword')!;
    const confirmationInput = registerForm.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!;
    const email = emailInput.value.trim();
    const displayName = parseDisplayName(nameInput.value);
    const password = passwordInput.value;
    const confirmation = confirmationInput.value;
    clearRegisterFieldErrors();

    const markFieldError = (input: HTMLInputElement): void => {
      const field = input.closest('.form-field');
      field?.classList.add('is-error');
      input.setAttribute('aria-invalid', 'true');
    };

    if (!email || !displayName) {
      if (!email) markFieldError(emailInput);
      if (!displayName) markFieldError(nameInput);
      setStatus(registerDialog, '请填写邮箱和昵称/主要游戏角色名（1–32 个字符）。', 'error');
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      markFieldError(passwordInput);
      setStatus(registerDialog, passwordError, 'error');
      return;
    }
    if (password !== confirmation) {
      markFieldError(confirmationInput);
      setStatus(registerDialog, '两次输入的密码不一致。', 'error');
      return;
    }
    if (registerAvatarProcessing) {
      setStatus(registerDialog, '请等待图片读取完成后再注册。', 'error');
      return;
    }

    const editor = ensureRegisterEditor();
    editor.setDisabled(true);
    setBusy(registerForm, true, '正在创建账号…');
    setStatus(registerDialog, '正在创建账号…', 'info');
    retryAutologinButton.hidden = true;
    autologinRetry = null;
    void (async () => {
      let session: AuthSessionResponse | null = null;
      try {
        const avatarBase64 = await editor.getValue();
        if (!active) return;
        const input: RegisterInput = { email, display_name: displayName, password, password_confirmation: confirmation };
        if (avatarBase64 !== null) input.avatar_base64 = avatarBase64;
        await api.register(input);
        if (!active) return;
        try {
          session = await api.login({ email, password });
        } catch {
          if (!active) return;
          autologinRetry = { email, password };
          retryAutologinButton.hidden = false;
          setStatus(registerDialog, '注册请求已受理，但自动登录失败。请在登录页面使用相同邮箱和密码重试。', 'error');
          return;
        }
      } catch (error) {
        if (!active) return;
        const message = error instanceof DOMException && error.name === 'AbortError'
          ? '图片已更改，请重新提交。'
          : authErrorMessage(error, '注册暂未完成，请重试。');
        setStatus(registerDialog, message, 'error');
      } finally {
        if (active) {
          editor.setDisabled(false);
          setBusy(registerForm, false, '注册');
        }
      }
      if (!active || !session) return;
      store.setSession(session);
      openSuccess(email);
    })();
  };

  const onForgotSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (forgotForm.getAttribute('aria-busy') === 'true') return;
    const email = forgotForm.querySelector<HTMLInputElement>('#dialogForgotEmail')!.value.trim();
    if (!email) {
      setStatus(forgotDialog, '请填写邮箱。', 'error', true);
      return;
    }
    setBusy(forgotForm, true);
    setStatus(forgotDialog, '正在提交申请…', 'info', true);
    void api.requestPasswordReset({ email }).then((response) => {
      if (active && openName === 'forgot') setStatus(forgotDialog, acceptedMessage(response, 'reset'), 'info', true);
    }).catch((error: unknown) => {
      if (active && openName === 'forgot') setStatus(forgotDialog, authErrorMessage(error, '申请暂未完成，请稍后重试。'), 'error', true);
    }).finally(() => {
      if (active && openName === 'forgot') setBusy(forgotForm, false);
    });
  };

  const onRetryAutologin = (): void => {
    const retry = autologinRetry;
    if (!retry || retryAutologinButton.disabled) return;
    retryAutologinButton.disabled = true;
    setStatus(registerDialog, '正在登录…', 'info');
    void api.login(retry).then((session) => {
      if (!active) return;
      store.setSession(session);
      openSuccess(retry.email);
    }).catch(() => {
      if (active) setStatus(registerDialog, '注册请求已受理，但自动登录失败。请在登录页面使用相同邮箱和密码重试。', 'error');
    }).finally(() => {
      if (active) retryAutologinButton.disabled = false;
    });
  };

  const onPasswordSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (passwordForm.getAttribute('aria-busy') === 'true') return;
    const currentPassword = passwordForm.querySelector<HTMLInputElement>('#dialogCurrentPassword')!.value;
    const newPassword = passwordForm.querySelector<HTMLInputElement>('#dialogNewPassword')!.value;
    const confirmation = passwordForm.querySelector<HTMLInputElement>('#dialogNewPasswordConfirmation')!.value;
    if (store.getState().status === 'pending') {
      setStatus(passwordDialog, '请先完成邮箱验证后再修改密码。', 'error');
      return;
    }
    if (store.getState().status !== 'active') {
      setStatus(passwordDialog, '登录状态已失效，请重新登录。', 'error');
      return;
    }
    if (!currentPassword) {
      setStatus(passwordDialog, '请填写当前密码。', 'error');
      return;
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setStatus(passwordDialog, passwordError, 'error');
      return;
    }
    if (newPassword !== confirmation) {
      setStatus(passwordDialog, '两次输入的新密码不一致。', 'error');
      return;
    }
    setBusy(passwordForm, true, '正在修改…');
    setStatus(passwordDialog, '正在修改密码…', 'info');
    void api.changePassword({ current_password: currentPassword, new_password: newPassword, new_password_confirmation: confirmation })
      .then(() => {
        if (!active) return;
        // 后端修改成功即吊销该账号全部会话：无论浮层是否仍开着都要清掉本地残留状态。
        // 成功态展示期间 identity-changed 不关闭浮层（见 store 订阅），保证用户看到提示。
        passwordSuccessShown = openName === 'password';
        store.clear();
        if (openName !== 'password') return;
        hideStatus(passwordDialog);
        passwordForm.hidden = true;
        passwordSuccess.hidden = false;
        passwordSuccess.querySelector<HTMLElement>('[data-password-relogin]')?.focus();
      }).catch((error: unknown) => {
        if (active && openName === 'password') {
          setStatus(passwordDialog, authErrorMessage(error, '密码修改未完成，请重试。'), 'error');
        }
      }).finally(() => {
        if (active && openName === 'password') setBusy(passwordForm, false, '确认修改');
      });
  };

  const onPasswordRelogin = (): void => {
    // 本地会话已在改密成功时清除（服务端已吊销全部会话），这里直接引导重新登录。
    openDialog('login', null);
  };

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!target || typeof target !== 'object' || !('nodeType' in target) || target.nodeType !== 1) return;
    const element = target as Element;

    const openLogin = element.closest<HTMLElement>('[data-open-login], [data-switch-login]');
    if (openLogin) {
      event.preventDefault();
      openDialog('login', openLogin.hasAttribute('data-open-login') ? openLogin : null);
      return;
    }
    const openRegister = element.closest<HTMLElement>('[data-open-register]');
    if (openRegister) {
      event.preventDefault();
      openDialog('register', openRegister);
      return;
    }
    const openForgot = element.closest<HTMLElement>('[data-open-forgot]');
    if (openForgot) {
      event.preventDefault();
      openDialog('forgot', openForgot);
      return;
    }
    const openPassword = element.closest<HTMLElement>('[data-open-password]');
    if (openPassword) {
      event.preventDefault();
      openDialog('password', openPassword);
      return;
    }
    if (element.closest('[data-close-login], [data-close-register], [data-close-success], [data-close-forgot], [data-close-password]')) {
      closeDialog();
      return;
    }
    if (element.closest('[data-password-relogin]')) {
      onPasswordRelogin();
      return;
    }
    if (element.closest('[data-retry-autologin]')) {
      onRetryAutologin();
      return;
    }
    const toggle = element.closest<HTMLButtonElement>('[data-toggle-password]');
    if (toggle) {
      const wrap = toggle.closest('.login-field, .form-input-wrap');
      const input = wrap?.querySelector<HTMLInputElement>('input');
      if (!input) return;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
      const icon = toggle.querySelector('i');
      if (icon) icon.className = visible ? 'ph ph-eye-slash' : 'ph ph-eye';
      return;
    }
    const scrim = element.closest('[data-login-scrim], [data-register-scrim], [data-success-scrim], [data-forgot-scrim], [data-password-scrim]');
    if (scrim && !element.closest('.login-dialog')) closeDialog();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && openName !== null) {
      event.preventDefault();
      closeDialog();
    }
  };

  const onRegisterInput = (event: Event): void => {
    const target = event.target;
    if (!target || typeof target !== 'object' || !('nodeType' in target) || target.nodeType !== 1) return;
    const field = (target as Element).closest('.form-field.is-error');
    if (!field) return;
    field.classList.remove('is-error');
    (target as Element).removeAttribute('aria-invalid');
  };

  const unsubscribe = store.subscribe((_state, event) => {
    if (!active) return;
    if (event?.type === 'identity-changed' && event.clearDrafts) {
      // 修改密码成功态：本地会话清理由 onPasswordSubmit 主动发起，浮层保留展示成功提示
      if (passwordSuccessShown) return;
      const hadDialogOpen = openName !== null;
      closeDialog(false);
      if (hadDialogOpen) doc.querySelector<HTMLElement>('.account-trigger')?.focus();
    }
  });

  loginForm.addEventListener('submit', onLoginSubmit);
  registerForm.addEventListener('submit', onRegisterSubmit);
  registerForm.addEventListener('input', onRegisterInput);
  forgotForm.addEventListener('submit', onForgotSubmit);
  passwordForm.addEventListener('submit', onPasswordSubmit);
  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeydown);

  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    loginForm.removeEventListener('submit', onLoginSubmit);
    registerForm.removeEventListener('submit', onRegisterSubmit);
    registerForm.removeEventListener('input', onRegisterInput);
    forgotForm.removeEventListener('submit', onForgotSubmit);
    passwordForm.removeEventListener('submit', onPasswordSubmit);
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKeydown);
    registerEditor?.destroy();
    registerEditor = null;
    openName = null;
    doc.body.classList.remove(...ALL_OPEN_CLASSES, 'auth-dialog-open');
    host.remove();
    mountedDocuments.delete(doc);
  };
}

function loginDialogMarkup(): string {
  return `<div class="login-scrim" data-login-scrim>
    <section class="login-dialog" role="dialog" aria-modal="true" aria-labelledby="dialogLoginTitle">
      <button type="button" class="login-dialog-close" data-close-login aria-label="关闭登录浮层"><i class="ph ph-x" aria-hidden="true"></i></button>
      <p class="login-dialog-eyebrow">LTSD 账号</p>
      <h2 class="login-dialog-title" id="dialogLoginTitle">密码登录</h2>
      <p class="login-dialog-sub">登录后查看账号资料与邮箱验证状态。</p>
      <form id="dialog-login-form" novalidate>
        <div class="login-fields">
          <div class="login-field"><label class="login-field-label" for="dialogLoginEmail">邮箱</label>
            <input id="dialogLoginEmail" name="email" type="email" autocomplete="username" placeholder="your@email.com"></div>
          <div class="login-field"><label class="login-field-label" for="dialogLoginPassword">密码</label>
            <input id="dialogLoginPassword" name="password" type="password" autocomplete="current-password" placeholder="请输入密码">
            <button type="button" class="login-field-toggle" data-toggle-password aria-label="显示密码"><i class="ph ph-eye" aria-hidden="true"></i></button>
            <button type="button" class="login-field-forgot" data-open-forgot>忘记密码？</button></div>
        </div>
        <p class="login-dialog-status" data-dialog-status role="status" aria-live="polite" hidden></p>
        <button type="submit" class="login-dialog-submit">登录</button>
      </form>
      <p class="login-dialog-note">在城市之间，快速找到你要的装备与词条。</p>
    </section>
  </div>`;
}

function registerDialogMarkup(): string {
  const passwordField = (id: string, label: string, placeholder: string): string =>
    `<label class="form-field"><span class="form-field-label">${label}</span>
      <span class="form-input-wrap"><input id="${id}" type="password" autocomplete="new-password" placeholder="${placeholder}">
      <button type="button" class="login-field-toggle" data-toggle-password aria-label="显示密码"><i class="ph ph-eye" aria-hidden="true"></i></button></span></label>`;
  return `<div class="register-scrim" data-register-scrim>
    <section class="login-dialog register-dialog" role="dialog" aria-modal="true" aria-labelledby="dialogRegisterTitle">
      <button type="button" class="login-dialog-close" data-close-register aria-label="关闭注册浮层"><i class="ph ph-x" aria-hidden="true"></i></button>
      <p class="login-dialog-eyebrow">LTSD 账号</p>
      <h2 class="login-dialog-title" id="dialogRegisterTitle">注册账号</h2>
      <p class="login-dialog-sub">创建账号后，可在不同设备查看和管理自己的资料。</p>
      <form id="dialog-register-form" class="register-form-grid" novalidate>
        <label class="form-field"><span class="form-field-label">邮箱</span>
          <input id="dialogRegisterEmail" type="email" autocomplete="email" placeholder="your@email.com"></label>
        <label class="form-field"><span class="form-field-label">昵称/主要游戏角色名</span>
          <input id="dialogRegisterName" type="text" autocomplete="nickname" placeholder="常用游戏角色名"></label>
        <p class="form-help">可填写常用游戏角色名，允许重名。</p>
        <div id="register-avatar-editor"></div>
        <div class="register-two-col">
          ${passwordField('dialogRegisterPassword', '密码', '请输入密码')}
          ${passwordField('dialogRegisterPasswordConfirmation', '确认密码', '再输一次')}
        </div>
        <p class="form-help">密码长度为 5–256 个字符；可使用粘贴和自动填充。</p>
        <p class="login-dialog-status" data-dialog-status role="status" aria-live="polite" hidden></p>
        <button type="button" class="dialog-secondary" data-retry-autologin hidden>点击重试</button>
        <button type="submit" class="login-dialog-submit">注册</button>
      </form>
      <p class="login-dialog-note">注册后会向邮箱发送验证邮件，需先完成邮箱验证。已有账号？<button type="button" class="auth-text-button" data-switch-login>登录</button></p>
    </section>
  </div>`;
}

function successDialogMarkup(): string {
  return `<div class="success-scrim" data-success-scrim>
    <section class="login-dialog success-dialog" role="dialog" aria-modal="true" aria-labelledby="dialogSuccessTitle">
      <button type="button" class="login-dialog-close" data-close-success aria-label="关闭注册完成浮层"><i class="ph ph-x" aria-hidden="true"></i></button>
      <span class="success-icon" aria-hidden="true"><i class="ph ph-envelope-simple"></i></span>
      <p class="login-dialog-eyebrow">LTSD 账号</p>
      <h2 class="login-dialog-title" id="dialogSuccessTitle">注册完成</h2>
      <p class="login-dialog-sub">注册完成，请检查邮箱并完成验证</p>
      <p class="success-email"><i class="ph ph-envelope-simple" aria-hidden="true"></i><span data-success-email>当前账号邮箱：</span></p>
      <p class="success-tip">验证邮件可能被归入垃圾邮件文件夹；请在邮箱中点击验证链接完成验证，验证完成后即可使用账号找回等功能。</p>
      <div class="success-actions">
        <button type="button" class="login-dialog-submit" data-close-success>我已完成验证，返回首页</button>
        <button type="button" class="dialog-secondary" data-close-success>先逛逛，稍后再验证</button>
      </div>
    </section>
  </div>`;
}

function forgotDialogMarkup(): string {
  return `<div class="forgot-scrim" data-forgot-scrim>
    <section class="login-dialog" role="dialog" aria-modal="true" aria-labelledby="dialogForgotTitle">
      <button type="button" class="login-dialog-close" data-close-forgot aria-label="关闭账号找回浮层"><i class="ph ph-x" aria-hidden="true"></i></button>
      <p class="login-dialog-eyebrow">LTSD 账号</p>
      <h2 class="login-dialog-title" id="dialogForgotTitle">找回密码</h2>
      <p class="login-dialog-sub">如果该邮箱对应可恢复的账号，你会收到重置邮件。</p>
      <form id="dialog-forgot-form" novalidate>
        <div class="login-fields">
          <div class="login-field"><label class="login-field-label" for="dialogForgotEmail">邮箱</label>
            <input id="dialogForgotEmail" name="email" type="email" autocomplete="email" placeholder="your@email.com"></div>
        </div>
        <p class="login-dialog-status" data-dialog-status role="status" aria-live="polite" hidden></p>
        <button type="submit" class="login-dialog-submit">申请重置密码</button>
      </form>
      <p class="login-dialog-note">想起来了？<button type="button" class="auth-text-button" data-switch-login>返回登录</button></p>
    </section>
  </div>`;
}

function passwordDialogMarkup(): string {
  const passwordField = (id: string, label: string, placeholder: string, autocomplete: string): string =>
    `<div class="login-field"><label class="login-field-label" for="${id}">${label}</label>
      <input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" placeholder="${placeholder}">
      <button type="button" class="login-field-toggle" data-toggle-password aria-label="显示密码"><i class="ph ph-eye" aria-hidden="true"></i></button></div>`;
  return `<div class="password-scrim" data-password-scrim>
    <section class="login-dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="dialogPasswordTitle">
      <button type="button" class="login-dialog-close" data-close-password aria-label="关闭修改密码浮层"><i class="ph ph-x" aria-hidden="true"></i></button>
      <p class="login-dialog-eyebrow">LTSD 账号</p>
      <h2 class="login-dialog-title" id="dialogPasswordTitle">修改密码</h2>
      <p class="login-dialog-sub">修改成功后，当前账号的所有登录会话都会退出。</p>
      <form id="dialog-password-form" novalidate>
        <div class="login-fields">
          ${passwordField('dialogCurrentPassword', '当前密码', '请输入当前密码', 'current-password')}
          ${passwordField('dialogNewPassword', '新密码', '5–256 个字符', 'new-password')}
          ${passwordField('dialogNewPasswordConfirmation', '确认新密码', '再输一次新密码', 'new-password')}
        </div>
        <p class="login-dialog-status" data-dialog-status role="status" aria-live="polite" hidden></p>
        <button type="submit" class="login-dialog-submit">确认修改</button>
      </form>
      <div class="password-success" data-password-success hidden>
        <span class="success-icon" aria-hidden="true"><i class="ph ph-check-circle"></i></span>
        <p class="password-success-text">密码已修改，当前账号的所有登录会话均已退出。</p>
        <button type="button" class="login-dialog-submit" data-password-relogin>使用新密码重新登录</button>
      </div>
      <p class="login-dialog-note">新密码长度为 5–256 个字符；可使用粘贴和自动填充。</p>
    </section>
  </div>`;
}
