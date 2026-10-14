import { AuthApiError } from './api';
import { authStore, type AuthStore, type AuthStoreState } from './store';

interface MountedAuthNav {
  slot: HTMLElement;
  store: AuthStore;
  unsubscribe: () => void;
  onClick: (event: Event) => void;
}

const mountedByRoot = new WeakMap<ParentNode, MountedAuthNav>();
const visitDocuments = new WeakSet<Document>();

export function mountAuthNav(root: ParentNode, store: AuthStore = authStore): void {
  const slot = root.querySelector<HTMLElement>('[data-auth-nav]');
  if (!slot) return;

  const previous = mountedByRoot.get(root);
  if (previous?.slot === slot && previous.store === store) return;
  if (previous) {
    previous.unsubscribe();
    previous.slot.removeEventListener('click', previous.onClick);
  }

  const render = (): void => renderAuthNav(slot, store.getState());
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!target || typeof target !== 'object' || !('nodeType' in target) || target.nodeType !== 1) return;
    const button = (target as Element).closest<HTMLButtonElement>('[data-auth-logout]');
    if (!button || button.disabled) return;
    button.disabled = true;
    void store.logout().catch((error: unknown) => {
      if (button.isConnected) button.disabled = false;
      const status = slot.querySelector<HTMLElement>('[data-auth-message]');
      const message = error instanceof AuthApiError && error.status === 401
        ? '登录状态已失效，请重新登录'
        : error instanceof AuthApiError
          ? error.message
          : '退出失败，请重试';
      if (status) status.textContent = message;
      else appendMessage(slot, message);
    });
  };

  slot.addEventListener('click', onClick);
  const unsubscribe = store.subscribe(render);
  mountedByRoot.set(root, { slot, store, unsubscribe, onClick });
  render();
  installVisitTriggers(slot.ownerDocument, store);
  void store.bootstrap();
}

function renderAuthNav(slot: HTMLElement, state: Readonly<AuthStoreState>): void {
  const doc = slot.ownerDocument;
  slot.replaceChildren();

  if (state.status === 'loading') {
    appendMessage(slot, '账号加载中…');
    return;
  }
  if (state.status === 'anonymous') {
    appendLink(slot, '/login', '登录');
    appendLink(slot, '/register', '注册');
    return;
  }
  if (state.status === 'disabled') {
    appendMessage(slot, state.message || '账号服务暂不可用');
    return;
  }
  if (state.status === 'error') {
    appendMessage(slot, state.message);
    appendLink(slot, '/login', '登录');
    appendLink(slot, '/register', '注册');
    return;
  }

  const account = doc.createElement('a');
  account.className = 'nav-item auth-nav-item auth-nav-account';
  account.href = '/account';
  account.setAttribute('aria-label', `账号：${state.user.display_name}`);
  if (state.user.has_avatar && isSameOriginAvatarUrl(state.user.avatar_url, doc)) {
    const avatar = doc.createElement('img');
    avatar.className = 'auth-nav-avatar';
    avatar.alt = '';
    avatar.src = state.user.avatar_url;
    account.append(avatar);
  } else {
    const fallback = doc.createElement('i');
    fallback.className = 'ph ph-user-circle auth-nav-avatar-fallback';
    fallback.setAttribute('aria-hidden', 'true');
    account.append(fallback);
  }
  const name = doc.createElement('span');
  name.className = 'auth-nav-name';
  name.textContent = state.user.display_name;
  account.append(name);
  slot.append(account);

  if (state.status === 'pending') {
    const pending = doc.createElement('span');
    pending.className = 'auth-nav-state';
    pending.textContent = '待验证';
    slot.append(pending);
  }

  const logout = doc.createElement('button');
  logout.type = 'button';
  logout.className = 'nav-item auth-nav-item auth-nav-logout';
  logout.dataset.authLogout = '';
  logout.textContent = '退出';
  slot.append(logout);

  if (state.refreshError) appendMessage(slot, state.refreshError);
}

function appendLink(slot: HTMLElement, href: string, label: string): void {
  const link = slot.ownerDocument.createElement('a');
  link.className = 'nav-item auth-nav-item';
  link.href = href;
  link.textContent = label;
  slot.append(link);
}

function appendMessage(slot: HTMLElement, message: string): void {
  const status = slot.ownerDocument.createElement('span');
  status.className = 'auth-nav-message';
  status.dataset.authMessage = '';
  status.setAttribute('role', 'status');
  status.textContent = message;
  slot.append(status);
}

function isSameOriginAvatarUrl(value: string, doc: Document): boolean {
  try {
    const url = new URL(value, doc.baseURI);
    return url.origin === new URL(doc.baseURI).origin && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

function installVisitTriggers(doc: Document, store: AuthStore): void {
  if (visitDocuments.has(doc)) return;
  visitDocuments.add(doc);

  const refreshAfterInteraction = (event: Event): void => {
    if (event.isTrusted) void store.refreshForVisit();
  };
  doc.addEventListener('click', refreshAfterInteraction, { capture: true, passive: true });
  doc.addEventListener('keydown', refreshAfterInteraction, { capture: true });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') void store.refreshForVisit();
  });
}
