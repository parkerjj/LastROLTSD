import { authApi, AuthApiError, type AuthApiClient } from './api';
import { mountAuthDialogs } from './dialogs';
import { authStore, type AuthStore, type AuthStoreState } from './store';

interface MountedAuthNav {
  slot: HTMLElement;
  store: AuthStore;
  unsubscribe: () => void;
  onClick: (event: Event) => void;
}

const mountedByRoot = new WeakMap<ParentNode, MountedAuthNav>();
const visitDocuments = new WeakSet<Document>();

export function mountAuthNav(root: ParentNode, store: AuthStore = authStore, api: AuthApiClient = authApi): void {
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
    void store.logout().then(() => {
      // 退出后触发器随 replaceChildren 重建，把焦点归还到匿名态账号按钮
      slot.querySelector<HTMLElement>('.account-trigger')?.focus();
    }).catch((error: unknown) => {
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
  mountAuthDialogs(slot.ownerDocument, store, api);
  installVisitTriggers(slot.ownerDocument, store);
  void store.bootstrap();
}

function renderAuthNav(slot: HTMLElement, state: Readonly<AuthStoreState>): void {
  slot.replaceChildren();

  if (state.status === 'loading') {
    appendMessage(slot, '账号加载中…');
    return;
  }
  if (state.status === 'anonymous') {
    slot.append(anonymousMenu(slot.ownerDocument));
    return;
  }
  if (state.status === 'disabled') {
    appendMessage(slot, state.message || '账号服务暂不可用');
    return;
  }
  if (state.status === 'error') {
    appendMessage(slot, state.message);
    slot.append(anonymousMenu(slot.ownerDocument));
    return;
  }

  slot.append(signedInMenu(slot.ownerDocument, state));
  if (state.refreshError) appendMessage(slot, state.refreshError);
}

function anonymousMenu(doc: Document): HTMLElement {
  const menu = doc.createElement('div');
  menu.className = 'account-menu';

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'account-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.append(phIcon(doc, 'ph-user'), textSpan(doc, '', '账号'), phIcon(doc, 'ph-caret-down', 'caret'));

  const panel = doc.createElement('div');
  panel.className = 'account-panel';
  panel.setAttribute('role', 'menu');

  const eyebrow = doc.createElement('p');
  eyebrow.className = 'account-panel-eyebrow';
  eyebrow.textContent = 'LTSD 账号';

  const login = doc.createElement('button');
  login.type = 'button';
  login.className = 'account-panel-primary';
  login.setAttribute('role', 'menuitem');
  login.dataset.openLogin = '';
  login.append(phIcon(doc, 'ph-user'), doc.createTextNode('登录'));

  const register = doc.createElement('button');
  register.type = 'button';
  register.className = 'account-panel-item';
  register.setAttribute('role', 'menuitem');
  register.dataset.openRegister = '';
  register.append(phIcon(doc, 'ph-pencil-simple'), doc.createTextNode('注册'));

  const forgot = doc.createElement('button');
  forgot.type = 'button';
  forgot.className = 'account-panel-item';
  forgot.setAttribute('role', 'menuitem');
  forgot.dataset.openForgot = '';
  forgot.append(phIcon(doc, 'ph-key'), doc.createTextNode('账号找回'));

  panel.append(eyebrow, login, panelSep(doc), register, forgot);
  menu.append(trigger, panel);
  wireExpandedState(menu, trigger);
  return menu;
}

function signedInMenu(doc: Document, state: Readonly<AuthStoreState> & { status: 'pending' | 'active' }): HTMLElement {
  const { user } = state;
  const menu = doc.createElement('div');
  menu.className = 'account-menu';

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'account-trigger signed-in';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', `账号：${user.display_name}`);
  trigger.append(avatarContent(doc, user, 'account-avatar'));
  const name = doc.createElement('span');
  name.className = 'name';
  name.textContent = user.display_name;
  trigger.append(name, phIcon(doc, 'ph-caret-down', 'caret'));

  const panel = doc.createElement('div');
  panel.className = 'account-panel';
  panel.setAttribute('role', 'menu');

  const me = doc.createElement('div');
  me.className = 'account-panel-me';
  me.append(avatarContent(doc, user, 'account-panel-avatar'));
  const meText = doc.createElement('span');
  const meName = doc.createElement('strong');
  meName.textContent = user.display_name;
  const meMail = doc.createElement('small');
  meMail.textContent = state.status === 'pending' ? `${user.email} · 邮箱待验证` : user.email;
  meText.append(meName, meMail);
  me.append(meText);

  const settings = doc.createElement('a');
  settings.className = 'account-panel-item';
  settings.setAttribute('role', 'menuitem');
  settings.href = '/account';
  settings.append(phIcon(doc, 'ph-gear-six'), doc.createTextNode('账号设置'));

  // 与个人中心一致：邮箱未验证（pending）时不提供修改密码入口
  const panelItems: HTMLElement[] = [me, panelSep(doc), settings];
  if (state.status === 'active') {
    const password = doc.createElement('button');
    password.type = 'button';
    password.className = 'account-panel-item';
    password.setAttribute('role', 'menuitem');
    password.dataset.openPassword = '';
    password.append(phIcon(doc, 'ph-password'), doc.createTextNode('修改密码'));
    panelItems.push(password);
  }
  const logout = doc.createElement('button');
  logout.type = 'button';
  logout.className = 'account-panel-item';
  logout.setAttribute('role', 'menuitem');
  logout.dataset.authLogout = '';
  logout.append(phIcon(doc, 'ph-sign-out'), doc.createTextNode('退出登录'));
  panelItems.push(logout);

  panel.append(...panelItems);
  menu.append(trigger, panel);
  wireExpandedState(menu, trigger);
  return menu;
}

/**
 * 面板显隐由 CSS :hover / :focus-within 控制，这里让 aria-expanded 与可见状态
 * 保持同步，避免读屏器在面板可见时仍听到"已折叠"。
 */
function wireExpandedState(menu: HTMLElement, trigger: HTMLButtonElement): void {
  const setExpanded = (expanded: boolean): void => {
    trigger.setAttribute('aria-expanded', String(expanded));
  };
  menu.addEventListener('mouseenter', () => setExpanded(true));
  menu.addEventListener('mouseleave', () => setExpanded(false));
  menu.addEventListener('focusin', () => setExpanded(true));
  menu.addEventListener('focusout', (event) => {
    // 鸭子判断：测试运行在 node 环境，不引用全局 Node（参考本文件 onClick 写法）
    const next = event.relatedTarget;
    const staysInside = next !== null
      && typeof next === 'object'
      && 'nodeType' in next
      && menu.contains(next as Node);
    if (!staysInside) setExpanded(false);
  });
}

function avatarContent(doc: Document, user: { has_avatar: boolean; avatar_url: string; display_name: string }, cls: string): HTMLElement {
  if (user.has_avatar && isSameOriginAvatarUrl(user.avatar_url, doc)) {
    const image = doc.createElement('img');
    image.className = cls;
    image.alt = '';
    image.src = user.avatar_url;
    return image;
  }
  const fallback = doc.createElement('span');
  fallback.className = cls;
  fallback.setAttribute('aria-hidden', 'true');
  const icon = doc.createElement('i');
  icon.className = 'ph ph-user-circle';
  fallback.append(icon);
  return fallback;
}

function panelSep(doc: Document): HTMLElement {
  const sep = doc.createElement('span');
  sep.className = 'account-panel-sep';
  sep.setAttribute('aria-hidden', 'true');
  return sep;
}

function phIcon(doc: Document, name: string, extraClass?: string): HTMLElement {
  const icon = doc.createElement('i');
  icon.className = extraClass ? `ph ${name} ${extraClass}` : `ph ${name}`;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function textSpan(doc: Document, cls: string, text: string): HTMLElement {
  const span = doc.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  return span;
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
