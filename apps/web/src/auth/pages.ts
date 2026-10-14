import { AuthApiError, type AuthApiClient } from './api';
import { mountAvatarEditor, type AvatarEditor } from './avatar-editor';
import { mountAuthNav } from './nav';
import type { AuthStore, AuthStoreState } from './store';
import type { AccountProfile, AuthAcceptedResponse, MailAvailability, RegisterInput } from './types';

const AUTH_PATHS = new Set([
  '/register',
  '/login',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/account',
  '/account/password',
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
  let pollTimer: number | undefined;
  let pollCount = 0;
  let pollingStopped = false;
  let pollCycleActive = false;
  let pollInFlight = false;
  let pollUserId: string | null = null;
  let pollOwnerEpoch = 0;
  let identityEpoch = 0;
  const cleanups: Cleanup[] = [];
  let registerAvatarEditor: AvatarEditor | null = null;
  let registerAvatarProcessing = false;
  let accountAvatarEditor: AvatarEditor | null = null;
  let accountAvatarEditorKey: string | null = null;
  let accountAvatarSaving = false;
  let accountHasStoredAvatar = false;
  let accountAvatarSelected = false;
  let accountAvatarProcessing = false;
  let renderState = (_state: Readonly<AuthStoreState>): void => undefined;
  const doc = root.ownerDocument;

  const cancelPollTimer = (): void => {
    if (pollTimer !== undefined) {
      doc.defaultView?.clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const stopPollCycle = (): void => {
    pollCycleActive = false;
    pollUserId = null;
    cancelPollTimer();
  };

  const stopPolling = (): void => {
    pollingStopped = true;
    stopPollCycle();
  };

  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, listener as EventListener);
    cleanups.push(() => target.removeEventListener(type, listener as EventListener));
  };

  const listenDocument = (type: 'visibilitychange' | 'pagehide', listener: EventListener): void => {
    const target = type === 'pagehide' ? root.ownerDocument.defaultView : root.ownerDocument;
    if (!target) return;
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  };

  const clearDrafts = (): void => {
    clearPasswordFields(root);
    const name = root.querySelector<HTMLInputElement>('#auth-display-name');
    if (name) {
      name.value = '';
      delete name.dataset.dirty;
    }
    root.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => { input.value = ''; });
    registerAvatarEditor?.reset();
    registerAvatarEditor?.setDisabled(false);
    const registerForm = root.querySelector<HTMLFormElement>('#register-form');
    if (registerForm) submitButton(registerForm, false);
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
    const pollCycleStarted = pollCycleActive || pollTimer !== undefined || pollInFlight;
    if (pathname === '/verify-email' && pollCycleStarted && (identityChanged || !canPoll(state))) stopPollCycle();
  });
  cleanups.push(unsubscribe);

  const page = pageMarkup(pathname);
  root.ownerDocument.title = `${page.title} · 露天商店.Ro`;
  root.innerHTML = shell(page.title, page.content);
  mountAuthNav(root, store);
  wirePasswordToggles(root, listen);

  const registerAvatarContainer = root.querySelector<HTMLElement>('#register-avatar-editor');
  if (registerAvatarContainer) {
    registerAvatarEditor = mountAvatarEditor(registerAvatarContainer, {
      onChange: ({ processing }) => {
        registerAvatarProcessing = processing;
        const submit = root.querySelector<HTMLButtonElement>('#register-form button[type="submit"]');
        if (submit) submit.disabled = processing;
      },
    });
  }

  const visibilityChanged = (): void => {
    if (doc.visibilityState !== 'visible') stopPolling();
  };
  listenDocument('visibilitychange', visibilityChanged);
  listenDocument('pagehide', stopPolling);

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

  const handleError = (error: unknown, fallback: string): string => {
    if (error instanceof AuthApiError && error.status === 401) return '登录状态已失效，请重新登录。';
    if (error instanceof AuthApiError && error.status === 503) return '账号服务暂不可用，请重试。';
    return error instanceof Error ? error.message : fallback;
  };

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
    setText(root, '#account-verified', user.email_verified_at === null ? '待验证' : formatTimestamp(user.email_verified_at));
    setText(root, '#account-status-label', user.status === 'PENDING_EMAIL' ? '待验证' : '已验证');
    setText(root, '#account-avatar-placeholder', initials(user.display_name));
    renderMailAvailability(root.querySelector<HTMLElement>('#account-mail-availability'), state.mailAvailability, 'verify');

    const name = root.querySelector<HTMLInputElement>('#auth-display-name');
    if (name && !name.dataset.dirty) name.value = user.display_name;
    renderAccountAvatar(user);
    ensureAccountAvatarEditor(user);
    const deleteAvatar = root.querySelector<HTMLButtonElement>('#account-avatar-delete');
    if (deleteAvatar) deleteAvatar.hidden = !user.has_avatar;
    const passwordLink = root.querySelector<HTMLElement>('#account-password-link');
    if (passwordLink) passwordLink.hidden = user.status !== 'ACTIVE';
    const pendingMessage = root.querySelector<HTMLElement>('#account-pending-message');
    if (pendingMessage) pendingMessage.hidden = user.status !== 'PENDING_EMAIL';
  };

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
      onChange: ({ selected, processing }) => {
        if (active) updateAvatarActions(selected, processing);
      },
    });
    accountAvatarEditor.setDisabled(accountAvatarSaving);
  }

  const renderPasswordPage = (state: Readonly<AuthStoreState>): void => {
    const form = root.querySelector<HTMLFormElement>('#password-change-form');
    const guide = root.querySelector<HTMLElement>('#password-login-guide');
    const pending = root.querySelector<HTMLElement>('#password-pending-guide');
    const unavailable = root.querySelector<HTMLElement>('#password-unavailable');
    if (!form || !guide || !pending || !unavailable) return;
    form.hidden = true;
    guide.hidden = true;
    pending.hidden = true;
    unavailable.hidden = true;
    if (state.status === 'loading') {
      unavailable.hidden = false;
      setText(root, '#password-state-message', '正在读取账号状态…');
    } else if (state.status === 'anonymous') {
      guide.hidden = false;
    } else if (state.status === 'pending') {
      pending.hidden = false;
      renderMailAvailability(root.querySelector<HTMLElement>('#password-mail-availability'), state.mailAvailability, 'verify');
    } else if (state.status === 'active') {
      form.hidden = false;
    } else {
      unavailable.hidden = false;
      setText(root, '#password-state-message', state.message);
    }
  };

  const renderVerifyState = (state: Readonly<AuthStoreState>): void => {
    const login = root.querySelector<HTMLFormElement>('#verify-login-form');
    const actions = root.querySelector<HTMLElement>('#verify-session-actions');
    const confirm = root.querySelector<HTMLButtonElement>('#verify-confirm');
    const request = root.querySelector<HTMLButtonElement>('#verify-request');
    const logout = root.querySelector<HTMLButtonElement>('#verify-logout');
    if (!login || !actions || !confirm || !request || !logout) return;
    login.hidden = true;
    actions.hidden = true;
    confirm.hidden = true;
    request.hidden = true;
    logout.hidden = true;

    if (!actionToken) {
      setText(root, '#verify-status', '请重新打开邮件链接。');
      if (state.status === 'pending') {
        actions.hidden = false;
        request.hidden = false;
        renderMailAvailability(root.querySelector<HTMLElement>('#verify-mail-availability'), state.mailAvailability, 'verify');
      }
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
      request.hidden = false;
      logout.hidden = false;
      setText(root, '#verify-status', '登录成功。请确认这是邮箱对应的账号，再手动完成验证。');
      renderMailAvailability(root.querySelector<HTMLElement>('#verify-mail-availability'), state.mailAvailability, 'verify');
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

  const registerForm = root.querySelector<HTMLFormElement>('#register-form');
  if (registerForm) {
    listen(registerForm, 'submit', (event) => {
      event.preventDefault();
      if (registerForm.getAttribute('aria-busy') === 'true') return;
      const email = value(root, '#auth-email').trim();
      const displayName = parseDisplayName(value(root, '#auth-display-name'));
      const password = value(root, '#auth-password');
      const confirmation = value(root, '#auth-password-confirmation');
      if (!email || !displayName) {
        setFormStatus(registerForm, '请填写邮箱和昵称/主要游戏角色名（1–32 个字符）。');
        return;
      }
      const passwordError = validatePassword(password);
      if (passwordError) {
        setFormStatus(registerForm, passwordError);
        return;
      }
      if (password !== confirmation) {
        setFormStatus(registerForm, '两次输入的密码不一致。');
        return;
      }
      if (registerAvatarProcessing) {
        setFormStatus(registerForm, '请等待图片读取完成后再注册。');
        return;
      }
      const submittedEpoch = identityEpoch;
      registerAvatarEditor?.setDisabled(true);
      submitButton(registerForm, true);
      void (async () => {
        try {
          const avatarBase64 = await (registerAvatarEditor?.getValue() ?? Promise.resolve(null));
          if (!active || identityEpoch !== submittedEpoch) return;
          const input: RegisterInput = { email, display_name: displayName, password, password_confirmation: confirmation };
          if (avatarBase64 !== null) input.avatar_base64 = avatarBase64;
          const response = await api.register(input);
          if (!active || identityEpoch !== submittedEpoch) return;
          clearPasswordFields(registerForm);
          registerAvatarEditor?.reset();
          setFormStatus(registerForm, acceptedMessage(response, 'register'));
        } catch (error) {
          if (!active || identityEpoch !== submittedEpoch) return;
          const message = error instanceof DOMException && error.name === 'AbortError'
            ? '图片已更改，请重新提交。'
            : handleError(error, '注册暂未完成，请重试。');
          setFormStatus(registerForm, message);
        } finally {
          if (active && identityEpoch === submittedEpoch) {
            registerAvatarEditor?.setDisabled(false);
            submitButton(registerForm, false);
          }
        }
      })();
    });
  }

  const loginForm = root.querySelector<HTMLFormElement>('#login-form');
  if (loginForm) {
    listen(loginForm, 'submit', (event) => {
      event.preventDefault();
      if (loginForm.getAttribute('aria-busy') === 'true') return;
      const email = value(root, '#auth-email').trim();
      const password = value(root, '#auth-password');
      if (!email || !password) {
        setFormStatus(loginForm, '请填写邮箱和密码。');
        return;
      }
      const submittedEpoch = identityEpoch;
      submitButton(loginForm, true);
      void api.login({ email, password }).then((response) => {
        if (!active) return;
        if (identityEpoch !== submittedEpoch) {
          void store.reconcile();
          return;
        }
        store.setSession(response);
        setFormStatus(loginForm, response.user.status === 'PENDING_EMAIL' ? '登录成功，请验证邮箱后继续。' : '登录成功。');
      }).catch((error: unknown) => {
        if (active && identityEpoch === submittedEpoch) setFormStatus(loginForm, handleError(error, '邮箱或密码不正确，或账号暂不可用。'));
      })
        .finally(() => { if (active) submitButton(loginForm, false); });
    });
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

  const verifyRequest = root.querySelector<HTMLButtonElement>('#verify-request');
  if (verifyRequest) {
    listen(verifyRequest, 'click', () => {
      const userId = currentUserId();
      const submittedEpoch = identityEpoch;
      if (!userId || verifyRequest.disabled) return;
      verifyRequest.disabled = true;
      void api.requestEmailVerification().then((response) => {
        if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        if ('verified' in response) {
          setText(root, '#verify-status', '当前账号已验证。');
          stopPollCycle();
          return;
        }
        setText(root, '#verify-status', acceptedMessage(response, 'verify'));
        renderMailAvailability(root.querySelector<HTMLElement>('#verify-mail-availability'), response.mail_availability, 'verify');
        if (response.mail_availability.code === 'AVAILABLE') {
          if (doc.visibilityState === 'visible' && pollCount < 3) {
            pollingStopped = false;
            pollCycleActive = true;
            pollUserId = userId;
            pollOwnerEpoch = submittedEpoch;
            startPolling();
          }
        } else {
          stopPollCycle();
        }
      }).catch((error: unknown) => {
        if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        setText(root, '#verify-status', handleError(error, '验证邮件申请暂未完成，请重试。'));
      }).finally(() => { if (active) verifyRequest.disabled = false; });
    });
  }

  const verifyManualCheck = root.querySelector<HTMLButtonElement>('#verify-check');
  if (verifyManualCheck) {
    listen(verifyManualCheck, 'click', () => {
      if (verifyManualCheck.disabled) return;
      verifyManualCheck.disabled = true;
      void store.reconcile().catch((error: unknown) => setText(root, '#verify-status', handleError(error, '检查失败，请重试。')))
        .finally(() => { if (active) verifyManualCheck.disabled = false; });
    });
  }

  const forgotForm = root.querySelector<HTMLFormElement>('#forgot-form');
  if (forgotForm) {
    listen(forgotForm, 'submit', (event) => {
      event.preventDefault();
      if (forgotForm.getAttribute('aria-busy') === 'true') return;
      const email = value(root, '#auth-email').trim();
      if (!email) {
        setFormStatus(forgotForm, '请填写邮箱。');
        return;
      }
      submitButton(forgotForm, true);
      void api.requestPasswordReset({ email }).then((response) => {
        if (active) setFormStatus(forgotForm, acceptedMessage(response, 'reset'));
      }).catch((error: unknown) => setFormStatus(forgotForm, handleError(error, '申请暂未完成，请稍后重试。')))
        .finally(() => { if (active) submitButton(forgotForm, false); });
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

  const profileForm = root.querySelector<HTMLFormElement>('#profile-form');
  if (profileForm) {
    const displayName = root.querySelector<HTMLInputElement>('#auth-display-name')!;
    listen(displayName, 'input', () => { displayName.dataset.dirty = 'true'; });
    listen(profileForm, 'submit', (event) => {
      event.preventDefault();
      if (profileForm.getAttribute('aria-busy') === 'true') return;
      const userId = currentUserId();
      const submittedEpoch = identityEpoch;
      const parsedName = parseDisplayName(displayName.value);
      if (!userId) {
        setFormStatus(profileForm, '请先登录后再修改资料。');
        return;
      }
      if (!parsedName) {
        setFormStatus(profileForm, '昵称/主要游戏角色名需为 1–32 个字符。');
        return;
      }
      submitButton(profileForm, true);
      void api.updateProfile({ display_name: parsedName }).then(async (response) => {
        if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        await store.reconcile();
        if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
        displayName.value = response.user.display_name;
        delete displayName.dataset.dirty;
        setFormStatus(profileForm, '资料已保存。');
      }).catch((error: unknown) => {
        if (active && currentUserId() === userId && identityEpoch === submittedEpoch) {
          setFormStatus(profileForm, handleError(error, '资料保存失败，请检查后重试。'));
        }
      }).finally(() => { if (active) submitButton(profileForm, false); });
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

  const passwordForm = root.querySelector<HTMLFormElement>('#password-change-form');
  if (passwordForm) {
    listen(passwordForm, 'submit', (event) => {
      event.preventDefault();
      if (passwordForm.getAttribute('aria-busy') === 'true') return;
      const userId = currentUserId();
      const submittedEpoch = identityEpoch;
      const currentPassword = value(root, '#auth-current-password');
      const newPassword = value(root, '#auth-password');
      const confirmation = value(root, '#auth-password-confirmation');
      if (!userId || store.getState().status !== 'active') {
        setFormStatus(passwordForm, '请先验证邮箱并登录后再修改密码。');
        return;
      }
      if (!currentPassword) {
        setFormStatus(passwordForm, '请填写当前密码。');
        return;
      }
      const passwordError = validatePassword(newPassword);
      if (passwordError) {
        setFormStatus(passwordForm, passwordError);
        return;
      }
      if (newPassword !== confirmation) {
        setFormStatus(passwordForm, '两次输入的新密码不一致。');
        return;
      }
      submitButton(passwordForm, true);
      void api.changePassword({ current_password: currentPassword, new_password: newPassword, new_password_confirmation: confirmation })
        .then(() => {
          if (!active || currentUserId() !== userId || identityEpoch !== submittedEpoch) return;
          store.clear();
          clearPasswordFields(passwordForm);
          setFormStatus(passwordForm, '密码已更新，请重新登录。');
        }).catch((error: unknown) => {
          if (active && currentUserId() === userId && identityEpoch === submittedEpoch) setFormStatus(passwordForm, handleError(error, '请求结果暂未确认，请重新登录检查密码状态。'));
        }).finally(() => { if (active) submitButton(passwordForm, false); });
    });
  }

  if (pathname === '/account') renderState = renderAccountState;
  else if (pathname === '/account/password') renderState = renderPasswordPage;
  else if (pathname === '/verify-email') renderState = renderVerifyState;
  renderState(store.getState());

  function startPolling(): void {
    const userId = pollUserId;
    const ownerEpoch = pollOwnerEpoch;
    if (!pollCycleActive || !userId || pollingStopped || pollTimer !== undefined || pollCount >= 3
      || doc.visibilityState !== 'visible' || identityEpoch !== ownerEpoch || currentUserId() !== userId
      || !canPoll(store.getState())) return;
    pollTimer = doc.defaultView!.setTimeout(() => {
      pollTimer = undefined;
      if (!active || !pollCycleActive || pollingStopped || doc.visibilityState !== 'visible' || pollCount >= 3
        || identityEpoch !== ownerEpoch || currentUserId() !== userId || !canPoll(store.getState())) {
        stopPollCycle();
        return;
      }
      pollCount += 1;
      pollInFlight = true;
      void store.reconcile().finally(() => {
        pollInFlight = false;
        if (!active || !pollCycleActive || pollingStopped || identityEpoch !== ownerEpoch
          || currentUserId() !== userId || !canPoll(store.getState()) || pollCount >= 3) {
          stopPollCycle();
          return;
        }
        startPolling();
      });
    }, 120_000);
  }

  return () => {
    if (!active) return;
    active = false;
    actionToken = null;
    stopPolling();
    registerAvatarEditor?.destroy();
    registerAvatarEditor = null;
    accountAvatarEditor?.destroy();
    accountAvatarEditor = null;
    accountAvatarEditorKey = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
    root.replaceChildren();
  };
}

function pageMarkup(pathname: string): { title: string; content: string } {
  switch (pathname) {
    case '/register': return { title: '注册账号', content: registerMarkup() };
    case '/login': return { title: '登录账号', content: loginMarkup() };
    case '/verify-email': return { title: '验证邮箱', content: verifyMarkup() };
    case '/forgot-password': return { title: '找回密码', content: forgotMarkup() };
    case '/reset-password': return { title: '重置密码', content: resetMarkup() };
    case '/account/password': return { title: '修改密码', content: passwordMarkup() };
    default: return { title: '我的账号', content: accountMarkup() };
  }
}

function shell(title: string, content: string): string {
  return `<div class="auth-page">
    <header class="site-header auth-page-header"><div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      <nav class="auth-page-links" aria-label="站点导航"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a></nav>
      <div class="auth-nav-slot" data-auth-nav aria-label="账号入口"></div>
    </div></header>
    <main class="auth-main page-width"><section class="auth-card" aria-labelledby="auth-page-title">
      <p class="auth-eyebrow">LTSD 账号</p><h1 id="auth-page-title">${title}</h1>
      ${content}
    </section></main>
    <footer class="site-footer auth-page-footer"><div class="page-width footer-inner"><a href="/">返回露天商店.Ro</a><span>账号密码只用于本站账号服务。</span></div></footer>
  </div>`;
}

function registerMarkup(): string {
  return `<p class="auth-intro">创建账号后，可在不同设备查看和管理自己的资料。</p>
    <form id="register-form" class="auth-form" novalidate>
      ${emailField()}
      <label for="auth-display-name">昵称/主要游戏角色名<input id="auth-display-name" name="display_name" autocomplete="nickname" required></label>
      <p class="auth-help">可填写常用游戏角色名，允许重名。</p>
      <div id="register-avatar-editor"></div>
      <p class="auth-help">头像会用于站内公开展示。</p>
      ${passwordField('auth-password', '密码', 'new-password')}
      ${passwordField('auth-password-confirmation', '确认密码', 'new-password')}
      <p class="auth-help">密码长度为 5–256 个字符；可使用粘贴和自动填充。</p>
      <p class="auth-status" data-auth-status role="status" aria-live="polite"></p>
      <button type="submit">注册</button>
    </form>
    <p class="auth-links">已有账号？ <a href="/login">登录</a> · <a href="/forgot-password">忘记密码</a></p>`;
}

function loginMarkup(): string {
  return `<p class="auth-intro">登录后查看账号资料与邮箱验证状态。</p>
    <form id="login-form" class="auth-form" novalidate>
      ${emailField()}
      ${passwordField('auth-password', '密码', 'current-password')}
      <p class="auth-status" data-auth-status role="status" aria-live="polite"></p>
      <button type="submit">登录</button>
    </form>
    <p class="auth-links"><a href="/register">注册账号</a> · <a href="/forgot-password">忘记密码</a></p>`;
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
      <div id="verify-mail-availability" class="auth-notice" aria-live="polite"></div>
      <button id="verify-confirm" type="button" hidden>确认邮箱验证</button>
      <button id="verify-request" class="secondary-button" type="button" hidden>重新发送验证邮件</button>
      <button id="verify-check" class="secondary-button" type="button">检查发送状态</button>
      <button id="verify-logout" class="auth-text-button" type="button" hidden>退出并使用其他账号登录</button>
    </section>
    <p class="auth-links"><a href="/login">登录</a> · <a href="/forgot-password">忘记密码</a></p>`;
}

function forgotMarkup(): string {
  return `<p class="auth-intro">如果该邮箱对应可恢复的账号，你会收到重置邮件。</p>
    <form id="forgot-form" class="auth-form" novalidate>
      ${emailField()}
      <p class="auth-status" data-auth-status role="status" aria-live="polite"></p>
      <button type="submit">申请重置密码</button>
    </form>
    <p class="auth-links"><a href="/login">返回登录</a></p>`;
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
    <p class="auth-links"><a href="/forgot-password">重新申请重置链接</a> · <a href="/login">登录</a></p>`;
}

function accountMarkup(): string {
  return `<p id="account-content" class="auth-intro" role="status" aria-live="polite">正在读取账号状态…</p>
    <section id="account-login-guide" class="auth-notice" hidden>
      <p>请先登录，查看和修改自己的账号资料。</p><a class="auth-button-link" href="/login">登录账号</a>
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
        </dl>
      </div>
      <p id="account-status-label" class="auth-state-label"></p>
      <p id="account-pending-message" class="auth-notice" hidden>邮箱尚待验证。<a href="/verify-email">前往邮箱验证</a></p>
      <div id="account-mail-availability" class="auth-notice" aria-live="polite"></div>
      <form id="profile-form" class="auth-form" novalidate>
        <label for="auth-display-name">昵称/主要游戏角色名<input id="auth-display-name" name="display_name" autocomplete="nickname" required></label>
        <p class="auth-help">可填写常用游戏角色名，保存后立即更新站内显示。</p>
        <p class="auth-status" data-auth-status role="status" aria-live="polite"></p>
        <button type="submit">保存资料</button>
      </form>
      <section class="auth-avatar-section" aria-labelledby="account-avatar-title">
        <h2 id="account-avatar-title">头像</h2>
        <p class="auth-help">头像会用于站内公开展示。图片只在本机裁剪，保存后仅保留压缩后的 WebP。</p>
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
      <p id="account-password-link" class="auth-links"><a href="/account/password">修改密码</a> · <a href="/forgot-password">忘记密码</a></p>
    </section>`;
}

function passwordMarkup(): string {
  return `<p class="auth-intro">修改账号密码后，所有现有会话都会退出。</p>
    <section id="password-login-guide" class="auth-notice" hidden>请先登录。<a href="/login">登录账号</a></section>
    <section id="password-pending-guide" class="auth-notice" hidden>
      <p>请先验证邮箱后再修改密码。</p><div id="password-mail-availability"></div>
      <a href="/verify-email">前往邮箱验证</a> · <a href="/forgot-password">通过邮件重置密码</a>
    </section>
    <section id="password-unavailable" class="auth-notice" hidden><p id="password-state-message"></p></section>
    <form id="password-change-form" class="auth-form" novalidate hidden>
      ${passwordField('auth-current-password', '当前密码', 'current-password')}
      ${passwordField('auth-password', '新密码', 'new-password')}
      ${passwordField('auth-password-confirmation', '确认新密码', 'new-password')}
      <p class="auth-help">新密码长度为 5–256 个字符；可使用粘贴和自动填充。</p>
      <p class="auth-status" data-auth-status role="status" aria-live="polite"></p>
      <button type="submit">修改密码</button>
    </form>
    <p class="auth-links"><a href="/account">返回账号资料</a></p>`;
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
      button.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}${button.dataset.passwordToggle === 'auth-current-password' ? '当前密码' : '密码'}`);
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

function parseDisplayName(value: string): string | null {
  const name = value.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 32 ? name : null;
}

function validatePassword(value: string): string | null {
  const length = Array.from(value).length;
  if (length < 5 || length > 256) return '密码长度需为 5–256 个字符。';
  return null;
}

function acceptedMessage(response: AuthAcceptedResponse, purpose: 'register' | 'verify' | 'reset'): string {
  const base = purpose === 'register'
    ? '申请已受理，正在等待发送。请检查邮箱；已有账号可以登录或申请密码重置。'
    : purpose === 'reset'
      ? '如果该邮箱对应可恢复的账号，申请已受理，正在等待发送。'
      : '已受理，正在等待发送。';
  const availability = formatMailAvailability(response.mail_availability, purpose);
  return availability ? `${base} ${availability}` : base;
}

function renderMailAvailability(target: HTMLElement | null, availability: MailAvailability | null, purpose: 'verify' | 'reset'): void {
  if (target) target.textContent = availability ? formatMailAvailability(availability, purpose) : '';
}

function formatMailAvailability(availability: MailAvailability, purpose: 'register' | 'verify' | 'reset'): string {
  if (availability.code === 'MAIL_DAILY_QUOTA') {
    const restoreTime = availability.retry_at === null ? '' : `预计当地恢复时间：${formatTimestamp(availability.retry_at)}。`;
    if (purpose === 'register') return `今天邮件发送数量已达到上限，请明天重新申请。${restoreTime}服务商日额度按 UTC 恢复。`;
    return purpose === 'verify'
      ? `今天发送邮件的数量已达到上限，请明天重新登录账号，再进行 Email 身份验证。${restoreTime}服务商日额度按 UTC 恢复。已收到的有效验证链接仍可使用。`
      : `今天发送邮件的数量已达到上限，请明天重新申请密码重置。${restoreTime}服务商日额度按 UTC 恢复。`;
  }
  if (availability.code === 'MAIL_MONTHLY_QUOTA') {
    return purpose === 'verify'
      ? '本月邮件发送额度已用完，请待额度恢复后重试。'
      : '本月邮件发送额度已用完，请待额度恢复后重试；额度恢复后重新申请密码重置。';
  }
  return '';
}

function canPoll(state: Readonly<AuthStoreState>): boolean {
  return state.status === 'pending'
    && state.mailAvailability?.code !== 'MAIL_DAILY_QUOTA'
    && state.mailAvailability?.code !== 'MAIL_MONTHLY_QUOTA';
}

function setText(root: ParentNode, selector: string, text: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) element.textContent = text;
}

function value(root: ParentNode, selector: string): string {
  return root.querySelector<HTMLInputElement>(selector)?.value ?? '';
}

function clearPasswordFields(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('[data-password-input]').forEach((input) => {
    input.value = '';
    input.type = 'password';
    const toggle = input.parentElement?.querySelector<HTMLButtonElement>('[data-password-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', `显示${toggle.dataset.passwordLabel ?? '密码'}`);
      toggle.textContent = '显示';
    }
  });
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间暂不可用' : date.toLocaleString();
}

function initials(displayName: string): string {
  return Array.from(displayName.trim())[0] ?? '用';
}

