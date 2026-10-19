import { AuthApiError, type AuthApiClient } from './api';
import { mountAvatarEditor, type AvatarEditor } from './avatar-editor';
import { mountSiteNav, siteNavMarkup } from '../nav';
import { tierBadge } from '../tier';
import type { AuthStore, AuthStoreState } from './store';
import type { AccountProfile } from './types';
import {
  authErrorMessage,
  clearPasswordFields,
  formatMailAvailability,
  formatTimestamp,
  initials,
  setText,
  validatePassword,
  value,
} from './utils';

const AUTH_PATHS = new Set([
  '/verify-email',
  '/reset-password',
  '/account',
]);

type Cleanup = () => void;

export function isAuthPage(pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  return AUTH_PATHS.has(normalized);
}

export function mountAuthPage(
  root: HTMLElement,
  path: string,
  api: AuthApiClient,
  store: AuthStore,
): Cleanup {
  const pathname = normalizePath(path);
  if (!isAuthPage(pathname)) return () => undefined;

  // Email links use a fragment; query support is kept for older links. Clear both
  // before navigation chrome or any page behavior can run.
  let actionToken = pathname === '/verify-email' || pathname === '/reset-password'
    ? takeActionToken(pathname)
    : null;
  let active = true;
  let identityEpoch = 0;
  const cleanups: Cleanup[] = [];
  let accountAvatarEditor: AvatarEditor | null = null;
  let accountAvatarEditorKey: string | null = null;
  let accountAvatarSaving = false;
  let accountAvatarSelected = false;
  let accountAvatarProcessing = false;
  let accountHasStoredAvatar = false;
  let renderState = (_state: Readonly<AuthStoreState>): void => undefined;

  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, listener as EventListener);
    cleanups.push(() => target.removeEventListener(type, listener as EventListener));
  };

  const clearDrafts = (): void => {
    clearPasswordFields(root);
    const name = root.querySelector<HTMLInputElement>('#auth-display-name');
    if (name) {
      name.value = '';
      delete name.dataset.dirty;
    }
    root.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => { input.value = ''; });
    accountAvatarEditor?.destroy();
    accountAvatarEditor = null;
    accountAvatarEditorKey = null;
    accountAvatarSaving = false;
    accountAvatarSelected = false;
    accountAvatarProcessing = false;
    const deleteConfirmation = root.querySelector<HTMLElement>('#account-avatar-delete-confirmation');
    if (deleteConfirmation) deleteConfirmation.hidden = true;
    const avatarStatus = root.querySelector<HTMLElement>('#account-avatar-status');
    if (avatarStatus) avatarStatus.textContent = '';
  };

  const unsubscribe = store.subscribe((state, event) => {
    if (!active) return;
    const identityChanged = event?.type === 'identity-changed' && event.clearDrafts;
    if (identityChanged) {
      identityEpoch += 1;
      clearDrafts();
    }
    renderState(state);
  });
  cleanups.push(unsubscribe);

  const page = pageMarkup(pathname);
  root.ownerDocument.title = `${page.title} · 露天商店.Ro`;
  root.innerHTML = shell(page.title, page.content);
  mountSiteNav(root, store, api);
  wirePasswordToggles(root, listen);

  const currentUserId = (): string | null => {
    const state = store.getState();
    return state.status === 'pending' || state.status === 'active' ? state.user.id : null;
  };

  const setFormStatus = (form: HTMLFormElement | null, message: string): void => {
    const status = form?.querySelector<HTMLElement>('[data-auth-status]');
    if (status) status.textContent = message;
  };

  const submitButton = (form: HTMLFormElement, busy: boolean): void => {
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) button.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
  };

  const handleError = authErrorMessage;

  const renderAccountState = (state: Readonly<AuthStoreState>): void => {
    const shell = root.querySelector<HTMLElement>('#account-content');
    const guide = root.querySelector<HTMLElement>('#account-login-guide');
    const unavailable = root.querySelector<HTMLElement>('#account-unavailable');
    const profile = root.querySelector<HTMLElement>('#account-profile');
    const retry = root.querySelector<HTMLButtonElement>('[data-auth-retry]');
    if (!shell || !guide || !unavailable || !profile || !retry) return;

    guide.hidden = true;
    unavailable.hidden = true;
    profile.hidden = true;
    retry.hidden = true;
    if (state.status !== 'pending' && state.status !== 'active') {
      accountAvatarEditor?.destroy();
      accountAvatarEditor = null;
      accountAvatarEditorKey = null;
      accountHasStoredAvatar = false;
    }
    if (state.status === 'loading') {
      shell.textContent = '正在读取账号状态…';
      return;
    }
    if (state.status === 'anonymous') {
      shell.textContent = '';
      guide.hidden = false;
      return;
    }
    if (state.status === 'error' || state.status === 'disabled') {
      shell.textContent = '';
      unavailable.hidden = false;
      unavailable.querySelector<HTMLElement>('[data-account-error]')!.textContent = state.message;
      retry.hidden = false;
      return;
    }

    shell.textContent = '';
    profile.hidden = false;
    const { user } = state;
    setText(root, '#account-id', user.id);
    setText(root, '#account-email', user.email);
    setText(root, '#account-created', formatTimestamp(user.created_at));
    renderEmailStatus(state, user);
    renderAccountTier(user);
    setText(root, '#account-avatar-placeholder', initials(user.display_name));

    setText(root, '#account-display-name', user.display_name);
    renderAccountAvatar(user);
    ensureAccountAvatarEditor(user);
    const passwordLink = root.querySelector<HTMLElement>('#account-password-link');
    if (passwordLink) passwordLink.hidden = user.status !== 'ACTIVE';
    const pendingMessage = root.querySelector<HTMLElement>('#account-pending-message');
    if (pendingMessage) pendingMessage.hidden = user.status !== 'PENDING_EMAIL';
  };

  // 删除头像沿用 AC-24 契约（版本更新，NULL 回默认头像）；紧凑布局下与「保存头像」并排，仅在已有头像时出现
  function renderAccountAvatar(user: AccountProfile): void {
    accountHasStoredAvatar = user.has_avatar;
    const image = root.querySelector<HTMLImageElement>('#account-avatar-image');
    if (image) {
      image.hidden = !user.has_avatar;
      image.alt = '账号头像';
      image.src = user.avatar_url;
    }
    const placeholder = root.querySelector<HTMLElement>('#account-avatar-placeholder');
    if (placeholder) {
      placeholder.hidden = user.has_avatar;
      placeholder.textContent = initials(user.display_name);
    }
    const remove = root.querySelector<HTMLButtonElement>('#account-avatar-delete');
    if (remove) remove.hidden = !user.has_avatar;
  }

  // 邮箱状态只展示三种形态：已验证 / 未验证 / 未验证且邮件发送额度用完（追加额度提示）
  function renderEmailStatus(state: Readonly<AuthStoreState>, user: AccountProfile): void {
    const target = root.querySelector<HTMLElement>('#account-verified');
    if (!target) return;
    const verified = user.status === 'ACTIVE';
    target.replaceChildren();
    const status = target.ownerDocument.createElement('span');
    status.textContent = verified ? '已验证' : '未验证';
    target.append(status);
    const quotaNote = state.status === 'pending' && state.mailAvailability
      ? formatMailAvailability(state.mailAvailability, 'verify')
      : '';
    if (!verified && quotaNote) {
      const note = target.ownerDocument.createElement('small');
      note.className = 'auth-email-status-note';
      note.textContent = quotaNote;
      target.append(note);
    }
  }

  // 账号等级与留言板共用同一套 admin 映射（0 萌新 / 1 正式 / 2 赞助 / >=100 管理员）
  function renderAccountTier(user: AccountProfile): void {
    setText(root, '#account-tier', tierBadge(user.admin).label);
  }

  function updateAvatarActions(selected: boolean, processing: boolean): void {
    accountAvatarSelected = selected;
    accountAvatarProcessing = processing;
    const save = root.querySelector<HTMLButtonElement>('#account-avatar-save');
    if (save) save.disabled = !selected || processing || accountAvatarSaving;
    const remove = root.querySelector<HTMLButtonElement>('#account-avatar-delete');
    if (remove) {
      remove.hidden = !accountHasStoredAvatar;
      remove.disabled = selected || processing || accountAvatarSaving;
    }
  }

  function ensureAccountAvatarEditor(user: AccountProfile): void {
    const container = root.querySelector<HTMLElement>('#account-avatar-editor');
    if (!container) return;
    const key = `${user.id}:${user.avatar_version}:${user.has_avatar ? user.avatar_url : ''}`;
    if (accountAvatarEditor && accountAvatarEditorKey === key) return;
    accountAvatarEditor?.destroy();
    accountAvatarEditor = null;
    accountAvatarEditorKey = key;
    accountAvatarEditor = mountAvatarEditor(container, {
      initialAvatarUrl: user.has_avatar ? user.avatar_url : null,
      compact: true,
      onChange: ({ selected, processing }) => {
        if (active) updateAvatarActions(selected, processing);
      },
    });
    accountAvatarEditor.setDisabled(accountAvatarSaving);
  }

  const renderVerifyState = (state: Readonly<AuthStoreState>): void => {
    const login = root.querySelector<HTMLFormElement>('#verify-login-form');
    const actions = root.querySelector<HTMLElement>('#verify-session-actions');
    const confirm = root.querySelector<HTMLButtonElement>('#verify-confirm');
    const logout = root.querySelector<HTMLButtonElement>('#verify-logout');
    if (!login || !actions || !confirm || !logout) return;
    login.hidden = true;
    actions.hidden = true;
    confirm.hidden = true;
    logout.hidden = true;

    if (!actionToken) {
      setText(root, '#verify-status', '请重新打开邮件链接。');
      return;
    }
    if (state.status === 'loading') {
      setText(root, '#verify-status', '正在读取登录状态…');
      return;
    }
    if (state.status === 'anonymous') {
      login.hidden = false;
      setText(root, '#verify-status', '请在此页登录邮箱对应的账号，再手动确认验证。');
      return;
    }
    if (state.status === 'pending') {
      actions.hidden = false;
      confirm.hidden = false;
      logout.hidden = false;
      setText(root, '#verify-status', `登录成功。请确认邮箱是 ${state.user.email}，再手动完成验证。`);
      return;
    }
    if (state.status === 'active') {
      setText(root, '#verify-status', '当前登录的账号已完成邮箱验证。');
      return;
    }
    setText(root, '#verify-status', state.message);
  };

  const retryButton = root.querySelector<HTMLButtonElement>('[data-auth-retry]');
  if (retryButton) {
    listen(retryButton, 'click', () => { void store.reconcile(); });
  }

  const verifyLoginForm = root.querySelector<HTMLFormElement>('#verify-login-form');
  if (verifyLoginForm) {
    listen(verifyLoginForm, 'submit', (event) => {
      event.preventDefault();
      if (verifyLoginForm.getAttribute('aria-busy') === 'true') return;
      const email = value(root, '#auth-email').trim();
      const password = value(root, '#auth-password');
      if (!email || !password) {
        setFormStatus(verifyLoginForm, '请填写邮箱和密码。');
        return;
      }
      const submittedEpoch = identityEpoch;
      submitButton(verifyLoginForm, true);
      void api.login({ email, password }).then((response) => {
        if (!active) return;
        if (identityEpoch !== submittedEpoch) {
          void store.reconcile();
          return;
        }
        store.setSession(response);
        setFormStatus(verifyLoginForm, '登录成功。请检查账号后手动确认验证。');
      }).catch((error: unknown) => {
        if (active && identityEpoch === submittedEpoch) setFormStatus(verifyLoginForm, handleError(error, '邮箱或密码不正确，或账号暂不可用。'));
      })
        .finally(() => { if (active) submitButton(verifyLoginForm, false); });
    });
  }

  const verifyConfirm = root.querySelector<HTMLButtonElement>('#verify-confirm');
  if (verifyConfirm) {
    listen(verifyConfirm, 'click', () => {
      const submittedToken = actionToken;
      const userId = currentUserId();
      const submittedEpoch = identityEpoch;
      if (!active || !submittedToken || !userId || verifyConfirm.disabled) return;
      verifyConfirm.disabled = true;
      void api.confirmEmailVerification({ token: submittedToken }).then((response) => {
        if (!active || actionToken !== submittedToken || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        actionToken = null;
        store.setSession(response);
        setText(root, '#verify-status', '邮箱已验证。');
      }).catch((error: unknown) => {
        if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        setText(root, '#verify-status', error instanceof AuthApiError && error.status === 403
          ? '无法使用当前账号完成验证，请确认登录的是邮箱对应的账号。'
          : handleError(error, '链接已失效，请登录后重新申请。'));
      }).finally(() => { if (active) verifyConfirm.disabled = false; });
    });
  }

  const verifyLogout = root.querySelector<HTMLButtonElement>('#verify-logout');
  if (verifyLogout) {
    listen(verifyLogout, 'click', () => {
      if (verifyLogout.disabled) return;
      verifyLogout.disabled = true;
      void store.logout().catch((error: unknown) => setText(root, '#verify-status', handleError(error, '退出失败，请重试。')))
        .finally(() => { if (active) verifyLogout.disabled = false; });
    });
  }

  const resetForm = root.querySelector<HTMLFormElement>('#reset-password-form');
  if (resetForm) {
    const resetStatus = root.querySelector<HTMLElement>('#reset-status');
    const resetCsrfButton = root.querySelector<HTMLButtonElement>('#reset-csrf-retry');
    const loadResetForm = async (): Promise<void> => {
      if (!actionToken) return;
      resetForm.hidden = true;
      if (resetCsrfButton) resetCsrfButton.hidden = true;
      setText(root, '#reset-status', '正在准备安全表单…');
      try {
        await api.getCsrf();
        if (!active || !actionToken) return;
        resetForm.hidden = false;
        setText(root, '#reset-status', '');
      } catch (error) {
        if (!active) return;
        setText(root, '#reset-status', handleError(error, '无法打开重置表单，请重试。'));
        if (resetCsrfButton) resetCsrfButton.hidden = false;
      }
    };
    if (actionToken) void loadResetForm();
    else {
      resetForm.hidden = true;
      setText(root, '#reset-status', '请重新打开邮件链接。');
    }
    if (resetCsrfButton) listen(resetCsrfButton, 'click', () => { void loadResetForm(); });
    listen(resetForm, 'submit', (event) => {
      event.preventDefault();
      if (resetForm.getAttribute('aria-busy') === 'true') return;
      const submittedToken = actionToken;
      const password = value(root, '#auth-password');
      const confirmation = value(root, '#auth-password-confirmation');
      if (!submittedToken) {
        setText(root, '#reset-status', '请重新打开邮件链接。');
        return;
      }
      const passwordError = validatePassword(password);
      if (passwordError) {
        setText(root, '#reset-status', passwordError);
        return;
      }
      if (password !== confirmation) {
        setText(root, '#reset-status', '两次输入的密码不一致。');
        return;
      }
      submitButton(resetForm, true);
      void api.confirmPasswordReset({ token: submittedToken, new_password: password, new_password_confirmation: confirmation })
        .then(() => {
          if (!active || actionToken !== submittedToken) return;
          actionToken = null;
          clearPasswordFields(resetForm);
          store.clear();
          resetForm.hidden = true;
          setText(root, '#reset-status', '密码已重置，请登录。');
        }).catch((error: unknown) => {
          if (active && actionToken === submittedToken) setText(root, '#reset-status', handleError(error, '链接已失效或申请失败，请重新申请。'));
        }).finally(() => { if (active) submitButton(resetForm, false); });
    });
  }

  const avatarSaveButton = root.querySelector<HTMLButtonElement>('#account-avatar-save');
  if (avatarSaveButton) {
    listen(avatarSaveButton, 'click', () => {
      const userId = currentUserId();
      const submittedEpoch = identityEpoch;
      const editor = accountAvatarEditor;
      if (!userId || !editor || accountAvatarSaving || avatarSaveButton.disabled) return;
      accountAvatarSaving = true;
      editor.setDisabled(true);
      updateAvatarActions(accountAvatarSelected, accountAvatarProcessing);
      setText(root, '#account-avatar-status', '正在处理并保存头像…');
      void (async () => {
        try {
          const avatarBase64 = await editor.getValue();
          if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
          if (avatarBase64 === null) {
            setText(root, '#account-avatar-status', '请先选择要保存的头像。');
            return;
          }
          const response = await api.setAvatar({ avatar_base64: avatarBase64 });
          if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
          renderAccountAvatar(response.user);
          accountAvatarEditorKey = null;
          ensureAccountAvatarEditor(response.user);
          setText(root, '#account-avatar-status', '头像已保存。');
          await store.reconcile();
        } catch (error) {
          if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
          const message = error instanceof DOMException && error.name === 'AbortError'
            ? '图片已更改，请重新保存。'
            : handleError(error, '头像保存失败，请重试。');
          setText(root, '#account-avatar-status', message);
        } finally {
          if (active && currentUserId() === userId && identityEpoch === submittedEpoch) {
            accountAvatarSaving = false;
            accountAvatarEditor?.setDisabled(false);
            updateAvatarActions(accountAvatarSelected, accountAvatarProcessing);
          }
        }
      })();
    });
  }

  const avatarDeleteButton = root.querySelector<HTMLButtonElement>('#account-avatar-delete');
  const avatarDeleteConfirmation = root.querySelector<HTMLElement>('#account-avatar-delete-confirmation');
  const avatarDeleteConfirmButton = root.querySelector<HTMLButtonElement>('#account-avatar-delete-confirm');
  const avatarDeleteCancelButton = root.querySelector<HTMLButtonElement>('#account-avatar-delete-cancel');
  if (avatarDeleteButton && avatarDeleteConfirmation && avatarDeleteConfirmButton && avatarDeleteCancelButton) {
    listen(avatarDeleteButton, 'click', () => {
      if (!avatarDeleteButton.disabled && accountHasStoredAvatar) avatarDeleteConfirmation.hidden = false;
    });
    listen(avatarDeleteCancelButton, 'click', () => {
      avatarDeleteConfirmation.hidden = true;
      avatarDeleteButton.focus();
    });
    listen(avatarDeleteConfirmButton, 'click', () => {
      const userId = currentUserId();
      const submittedEpoch = identityEpoch;
      if (!userId || !accountHasStoredAvatar || accountAvatarSaving) return;
      accountAvatarSaving = true;
      accountAvatarEditor?.setDisabled(true);
      updateAvatarActions(accountAvatarSelected, accountAvatarProcessing);
      setText(root, '#account-avatar-status', '正在删除头像…');
      void api.deleteAvatar().then(async (response) => {
        if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        renderAccountAvatar(response.user);
        accountAvatarEditorKey = null;
        ensureAccountAvatarEditor(response.user);
        avatarDeleteConfirmation.hidden = true;
        setText(root, '#account-avatar-status', '头像已删除。');
        await store.reconcile();
      }).catch((error: unknown) => {
        if (active && currentUserId() === userId && identityEpoch === submittedEpoch) {
          setText(root, '#account-avatar-status', handleError(error, '头像删除失败，请重试。'));
        }
      }).finally(() => {
        if (active && currentUserId() === userId && identityEpoch === submittedEpoch) {
          accountAvatarSaving = false;
          accountAvatarEditor?.setDisabled(false);
          updateAvatarActions(accountAvatarSelected, accountAvatarProcessing);
        }
      });
    });
  }

  if (pathname === '/account') renderState = renderAccountState;
  else if (pathname === '/verify-email') renderState = renderVerifyState;
  renderState(store.getState());

  return () => {
    if (!active) return;
    active = false;
    actionToken = null;
    accountAvatarEditor?.destroy();
    accountAvatarEditor = null;
    accountAvatarEditorKey = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
    root.replaceChildren();
  };
}

function pageMarkup(pathname: string): { title: string; content: string } {
  switch (pathname) {
    case '/verify-email': return { title: '验证邮箱', content: verifyMarkup() };
    case '/reset-password': return { title: '重置密码', content: resetMarkup() };
    case '/account': return { title: '我的账号', content: accountMarkup() };
    default: return { title: '我的账号', content: accountMarkup() };
  }
}

function shell(title: string, content: string): string {
  return `<div class="auth-page">
    <header class="site-header"><div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup(null)}
    </div></header>
    <main class="auth-main page-width"><section class="auth-card" aria-labelledby="auth-page-title">
      <p class="auth-eyebrow">LTSD 账号</p><h1 id="auth-page-title">${title}</h1>
      ${content}
    </section></main>
    <footer class="site-footer auth-page-footer"><div class="page-width footer-inner"><a href="/">返回露天商店.Ro</a><span>账号密码只用于本站账号服务。</span></div></footer>
  </div>`;
}

function verifyMarkup(): string {
  return `<p id="verify-status" class="auth-status" role="status" aria-live="polite"></p>
    <form id="verify-login-form" class="auth-form" novalidate hidden>
      ${emailField()}
      ${passwordField('auth-password', '密码', 'current-password')}
      <p class="auth-status" data-auth-status role="status" aria-live="polite"></p>
      <button type="submit">在此页登录</button>
    </form>
    <section id="verify-session-actions" class="auth-actions" hidden>
      <button id="verify-confirm" type="button" hidden>确认邮箱验证</button>
      <button id="verify-logout" class="auth-text-button" type="button" hidden>退出并使用其他账号登录</button>
    </section>
    <p class="auth-links"><button type="button" class="auth-text-button" data-open-login>登录</button> · <button type="button" class="auth-text-button" data-open-forgot>忘记密码</button></p>`;
}

function resetMarkup(): string {
  return `<p class="auth-intro">设置新密码后，现有会话会退出；请使用新密码重新登录。</p>
    <form id="reset-password-form" class="auth-form" novalidate hidden>
      ${passwordField('auth-password', '新密码', 'new-password')}
      ${passwordField('auth-password-confirmation', '确认新密码', 'new-password')}
      <p class="auth-help">密码长度为 5–256 个字符；可使用粘贴和自动填充。</p>
      <button type="submit">重置密码</button>
    </form>
    <p id="reset-status" class="auth-status" role="status" aria-live="polite"></p>
    <button id="reset-csrf-retry" class="secondary-button" type="button" hidden>重试</button>
    <p class="auth-links"><button type="button" class="auth-text-button" data-open-forgot>重新申请重置链接</button> · <button type="button" class="auth-text-button" data-open-login>登录</button></p>`;
}

function accountMarkup(): string {
  return `<p id="account-content" class="auth-intro" role="status" aria-live="polite">正在读取账号状态…</p>
    <section id="account-login-guide" class="auth-notice" hidden>
      <p>请先登录，查看和修改自己的账号资料。</p><button class="auth-button-link" type="button" data-open-login>登录账号</button>
    </section>
    <section id="account-unavailable" class="auth-notice" hidden>
      <p data-account-error>账号服务暂不可用。</p><button class="secondary-button" type="button" data-auth-retry>重试</button>
    </section>
    <section id="account-profile" hidden>
      <div class="auth-profile-summary">
        <span id="account-avatar-placeholder" class="auth-avatar-placeholder" aria-hidden="true"></span>
        <img id="account-avatar-image" class="auth-avatar-profile-image" alt="账号头像" hidden>
        <dl>
          <div><dt>账号 ID</dt><dd id="account-id"></dd></div>
          <div><dt>Email</dt><dd id="account-email"></dd></div>
          <div><dt>注册时间</dt><dd id="account-created"></dd></div>
          <div><dt>邮箱状态</dt><dd id="account-verified"></dd></div>
          <div><dt>账号等级</dt><dd id="account-tier"></dd></div>
        </dl>
      </div>
      <p id="account-pending-message" class="auth-notice" hidden>邮箱尚未验证，请打开验证邮件完成验证，晋级正式用户。</p>
      <div class="auth-profile-name-row">
        <span class="auth-profile-name-label">昵称</span>
        <span class="auth-profile-name-value" id="account-display-name"></span>
        <button class="secondary-button auth-profile-name-edit" type="button" data-open-name>修改昵称</button>
      </div>
      <section class="auth-avatar-section" aria-labelledby="account-avatar-title">
        <h2 id="account-avatar-title">头像</h2>
        <div id="account-avatar-editor"></div>
        <div class="auth-avatar-actions">
          <button id="account-avatar-save" type="button" disabled>保存头像</button>
          <button id="account-avatar-delete" class="secondary-button" type="button" hidden>删除头像</button>
          <div id="account-avatar-delete-confirmation" class="auth-avatar-delete-confirmation" hidden>
            <span>删除当前头像？</span>
            <button id="account-avatar-delete-confirm" type="button">确认删除</button>
            <button id="account-avatar-delete-cancel" class="secondary-button" type="button">取消</button>
          </div>
        </div>
        <p id="account-avatar-status" class="auth-status" role="status" aria-live="polite"></p>
      </section>
      <p id="account-password-link" class="auth-links"><button type="button" class="auth-text-button" data-open-password>修改密码</button> · <button type="button" class="auth-text-button" data-open-forgot>忘记密码</button></p>
    </section>`;
}

function emailField(): string {
  return '<label for="auth-email">邮箱<input id="auth-email" name="email" type="email" autocomplete="email" required></label>';
}

function passwordField(id: string, label: string, autocomplete: string): string {
  return `<label class="auth-password-label" for="${id}">${label}<span class="auth-password-control">
    <input id="${id}" name="${id}" data-password-input type="password" autocomplete="${autocomplete}" required>
    <button class="auth-password-toggle" type="button" data-password-toggle="${id}" data-password-label="${label}" aria-label="显示${label}" aria-pressed="false">显示</button>
  </span></label>`;
}

function wirePasswordToggles(
  root: HTMLElement,
  listen: <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void) => void,
): void {
  root.querySelectorAll<HTMLButtonElement>('[data-password-toggle]').forEach((button) => {
    listen(button, 'click', () => {
      const targetId = button.dataset.passwordToggle;
      const input = targetId ? root.querySelector<HTMLInputElement>(`#${targetId}`) : null;
      if (!input) return;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}密码`);
      button.textContent = visible ? '隐藏' : '显示';
    });
  });
}

function takeActionToken(pathname: string): string | null {
  const url = new URL(window.location.href);
  const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? url.searchParams.get('token');
  window.history.replaceState(window.history.state, '', pathname);
  return token && token.length > 0 ? token : null;
}

function normalizePath(path: string): string {
  const pathname = path.split(/[?#]/u, 1)[0] ?? path;
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
