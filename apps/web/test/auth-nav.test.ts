import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../src/auth/api';
import { mountAuthNav } from '../src/auth/nav';
import { AuthStore, type AuthStoreApi } from '../src/auth/store';
import type { AuthSessionResponse } from '../src/auth/types';
import { mountSiteNav, siteNavMarkup } from '../src/nav';

function apiStub(): AuthStoreApi {
  return {
    me: vi.fn(async () => { throw new Error('unexpected me request'); }),
    refreshSession: vi.fn(async () => ({ expires_at: 60_000, csrf_token: 'session-csrf' })),
    logout: vi.fn(async () => undefined),
    setSessionCsrf: vi.fn(),
    clearSessionCsrf: vi.fn(),
    onSessionFailure: vi.fn(() => () => undefined),
    sessionRevision: 0,
  };
}

function session(displayName: string, status: 'ACTIVE' | 'PENDING_EMAIL' = 'ACTIVE'): AuthSessionResponse {
  return {
    user: {
      id: '10000',
      email: 'a@example.test',
      display_name: displayName,
      status,
      admin: status === 'ACTIVE' ? 1 : 0,
      email_verified_at: status === 'ACTIVE' ? 1 : null,
      created_at: 1,
      has_avatar: false,
      avatar_version: 0,
      avatar_url: '/api/v1/users/10000/avatar?v=0',
    },
    expires_at: 30_000,
    csrf_token: 'session-csrf',
    mail_availability: status === 'PENDING_EMAIL' ? { code: 'AVAILABLE', retry_at: null } : null,
  };
}

describe('auth navigation', () => {
  it('adds an independent account slot while preserving the public navigation', () => {
    const markup = siteNavMarkup('accounts');

    expect(markup).toContain('data-auth-nav');
    expect(markup).toContain('href="/accounts"');
    expect(markup).toContain('菜农监控台');
    expect(markup).toContain('href="/guestbook"');
    expect(markup).toContain('href="/client"');
    expect(markup).toContain('href="/sponsor"');
    expect(markup).toContain('aria-current="page"');
  });

  it('renders a pending account and untrusted nickname as plain text', () => {
    const dom = new JSDOM(`<div id="app">${siteNavMarkup('search')}</div>`, { url: 'http://localhost/' });
    const api = apiStub();
    const store = new AuthStore(api, { broadcastChannel: null });
    const nickname = '<img src=x onerror=alert(1)>';
    store.setSession(session(nickname, 'PENDING_EMAIL'));

    mountAuthNav(dom.window.document.querySelector('#app')!, store);

    const slot = dom.window.document.querySelector<HTMLElement>('[data-auth-nav]')!;
    expect(slot.textContent).toContain(nickname);
    expect(slot.textContent).toContain('邮箱待验证');
    expect(slot.querySelector('img[onerror]')).toBeNull();
    expect(slot.querySelector('.account-trigger.signed-in')).not.toBeNull();
    const panel = slot.querySelector<HTMLElement>('.account-panel')!;
    expect(panel.querySelector('a[href="/account"]')).not.toBeNull();
    expect(panel.querySelector('button[data-auth-logout]')).not.toBeNull();
    // pending（邮箱未验证）不提供修改密码入口，与个人中心一致
    expect(panel.querySelector('button[data-open-password]')).toBeNull();
  });

  it('renders the password change entry only for verified sessions', () => {
    const dom = new JSDOM(`<div id="app">${siteNavMarkup('search')}</div>`, { url: 'http://localhost/' });
    const store = new AuthStore(apiStub(), { broadcastChannel: null });
    store.setSession(session('Player A', 'ACTIVE'));

    mountAuthNav(dom.window.document.querySelector('#app')!, store);

    const entry = dom.window.document.querySelector<HTMLButtonElement>('button[data-open-password]')!;
    expect(entry.textContent).toContain('修改密码');
  });

  it('clears an expired session and tells the user to sign in again', async () => {
    const dom = new JSDOM(`<div id="app">${siteNavMarkup('search')}</div>`, { url: 'http://localhost/' });
    const api = apiStub();
    api.logout = vi.fn(async () => { throw new AuthApiError(401, 'AUTH_UNAUTHENTICATED', '请先登录'); });
    const store = new AuthStore(api, { broadcastChannel: null });
    store.setSession(session('Player A'));
    const root = dom.window.document.querySelector<HTMLElement>('#app')!;
    mountAuthNav(root, store);

    root.querySelector<HTMLButtonElement>('[data-auth-logout]')!.click();
    await vi.waitFor(() => expect(store.getState().status).toBe('anonymous'));

    const slot = root.querySelector<HTMLElement>('[data-auth-nav]')!;
    expect(slot.querySelector('button[data-open-login]')).not.toBeNull();
    expect(slot.textContent).toContain('登录状态已失效，请重新登录');
  });

  it('mirrors panel visibility into aria-expanded and exposes the login item as a menuitem', async () => {
    const dom = new JSDOM(`<div id="app">${siteNavMarkup('search')}</div>`, { url: 'http://localhost/' });
    const api = apiStub();
    const store = new AuthStore(api, { broadcastChannel: null });
    const root = dom.window.document.querySelector<HTMLElement>('#app')!;
    mountAuthNav(root, store);

    const trigger = await vi.waitFor(() => {
      const found = root.querySelector<HTMLButtonElement>('.account-trigger');
      expect(found).not.toBeNull();
      return found!;
    });
    const loginItem = root.querySelector<HTMLButtonElement>('.account-panel-primary')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(loginItem.getAttribute('role')).toBe('menuitem');

    trigger.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    trigger.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('returns focus to the rebuilt anonymous trigger after logout', async () => {
    const dom = new JSDOM(`<div id="app">${siteNavMarkup('search')}</div>`, { url: 'http://localhost/' });
    const api = apiStub();
    const store = new AuthStore(api, { broadcastChannel: null });
    store.setSession(session('Player A'));
    const root = dom.window.document.querySelector<HTMLElement>('#app')!;
    mountAuthNav(root, store);

    root.querySelector<HTMLButtonElement>('[data-auth-logout]')!.click();
    const anonymousTrigger = await vi.waitFor(() => {
      const found = root.querySelector<HTMLButtonElement>('.account-trigger:not(.signed-in)');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dom.window.document.activeElement).toBe(anonymousTrigger);
  });

  it('keeps the mobile menu keyboard-operable and avoids duplicate mount listeners', () => {
    const dom = new JSDOM(`<div id="app">${siteNavMarkup('accounts')}</div>`, { url: 'http://localhost/accounts' });
    const previousDocument = globalThis.document;
    const previousWindow = (globalThis as { window?: unknown }).window;
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'AUTH_UNAUTHENTICATED', message: '请先登录' } }), { status: 401 })));
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      mountSiteNav(root);
      mountSiteNav(root);
      const toggle = root.querySelector<HTMLButtonElement>('.nav-toggle')!;
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.tabIndex).toBeGreaterThanOrEqual(0);
      toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(root.querySelector('.site-nav')?.classList.contains('is-open')).toBe(true);
      expect(root.querySelector('.nav-item[aria-current="page"]')?.getAttribute('href')).toBe('/accounts');
    } finally {
      vi.stubGlobal('fetch', previousFetch);
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    }
  });
});
