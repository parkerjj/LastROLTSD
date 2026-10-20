import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountVipPage } from '../src/vip-page';
import type { AuthStore, AuthStoreState } from '../src/auth/store';

const STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/28E5kFdkNbeo6nyejM1RC01';

/** 最小可用的 AuthStore 替身：只实现页面与导航挂载真正读取的成员。 */
function stubStore(state: AuthStoreState): AuthStore {
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bootstrap: async () => undefined,
    logout: async () => undefined,
    refreshForVisit: async () => undefined,
  } as unknown as AuthStore;
}

function mountInJsdom(state: AuthStoreState = { status: 'anonymous' }): HTMLElement {
  const dom = new JSDOM('<main id="app"></main>');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  const root = dom.window.document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing test app root');
  mountVipPage(root, stubStore(state));
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vip pricing page', () => {
  it('lists the products, services and pricing, and every buy button shares one Stripe link', () => {
    const root = mountInJsdom();

    expect(document.title).toBe('购买会员 · 露天商店.Ro');
    expect(root.querySelector('h1')?.textContent).toBe('购买会员');

    // 会员服务：六张权益卡。
    expect(root.querySelectorAll('.vip-benefit-card')).toHaveLength(6);

    // 价格：四个档位，年卡带「最受欢迎」徽章。
    const plans = [...root.querySelectorAll<HTMLElement>('.vip-plan-card')];
    expect(plans).toHaveLength(4);
    expect(plans.map((plan) => plan.querySelector('.vip-plan-name')?.textContent)).toEqual([
      '月卡',
      '季卡',
      '年卡',
      '永久',
    ]);
    expect(plans.map((plan) => plan.querySelector('.vip-plan-price strong')?.textContent)).toEqual([
      '30',
      '78',
      '268',
      '588',
    ]);
    const featured = root.querySelector('.vip-plan-card--featured');
    expect(featured?.querySelector('.vip-plan-badge')?.textContent).toBe('最受欢迎');
    // 只有年卡是推荐档位。
    expect(root.querySelectorAll('.vip-plan-card--featured')).toHaveLength(1);

    // 每个档位两个购买入口（支付宝 / Stripe），全部指向同一个收款链接。
    const buyLinks = [...root.querySelectorAll<HTMLAnchorElement>('.vip-plan-actions a')];
    expect(buyLinks).toHaveLength(8);
    for (const link of buyLinks) {
      expect(link.getAttribute('href')).toBe(STRIPE_CHECKOUT_URL);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
    // 支付宝入口与 Stripe 入口各半，且文案可区分。
    expect(buyLinks.filter((link) => link.classList.contains('vip-pay-alipay'))).toHaveLength(4);
    expect(buyLinks.filter((link) => link.classList.contains('vip-pay-stripe'))).toHaveLength(4);

    // 支付方式标记：支付宝与 Stripe 各一张。
    expect(root.querySelectorAll('.vip-pay-method--alipay')).toHaveLength(1);
    expect(root.querySelectorAll('.vip-pay-method--stripe')).toHaveLength(1);

    // 权益对比表：8 行权益 + 2 行价格明细，四档列齐全。
    expect(root.querySelectorAll('.vip-compare thead th')).toHaveLength(5);
    expect(root.querySelectorAll('.vip-compare tbody tr')).toHaveLength(8);
    expect(root.querySelectorAll('.vip-compare tfoot tr')).toHaveLength(2);
    expect(root.querySelectorAll('.vip-compare tfoot tr:first-child td').length).toBe(4);

    expect(root.querySelectorAll('.vip-faq-item')).toHaveLength(6);
  });

  it('stays out of every navigation and footer link so the page is URL-only', () => {
    const root = mountInJsdom();

    expect(root.querySelectorAll('a[href*="/vip"]')).toHaveLength(0);
    // 主导航仍然照常渲染，只是不含本页。
    expect(root.querySelectorAll('.site-nav .nav-item').length).toBeGreaterThan(0);
    expect(root.querySelector('.site-nav a[aria-current="page"]')).toBeNull();
  });

  it('renders the membership status card from the account store', () => {
    const anonymousRoot = mountInJsdom();
    const guestCard = anonymousRoot.querySelector('[data-vip-status]');
    expect(guestCard?.querySelector('.status-kicker')?.textContent).toContain('当前会员状态');
    expect(guestCard?.querySelector('.status-badge')?.textContent).toContain('尚未开通会员');
    expect(guestCard?.textContent).toContain('尚未登录');
    // 未登录时引导打开账号登录浮层，而不是跳转其它页面。
    expect(guestCard?.querySelector('[data-open-login]')).not.toBeNull();

    const signedInRoot = mountInJsdom({
      status: 'active',
      expiresAt: Date.now() + 60_000,
      mailAvailability: null,
      user: {
        id: 'u_1',
        email: 'farmer@example.com',
        display_name: '摆摊的商人',
        status: 'active',
        permission_level: 1,
        email_verified_at: Date.now(),
        created_at: Date.now(),
        has_avatar: false,
        avatar_version: 1,
        avatar_url: '',
      },
    } as unknown as AuthStoreState);
    const memberCard = signedInRoot.querySelector('[data-vip-status]');
    expect(memberCard?.textContent).toContain('摆摊的商人');
    expect(memberCard?.textContent).toContain('farmer@example.com');
    // 已登录时不再提供登录入口，改为页内锚点直达套餐区。
    expect(memberCard?.querySelector('[data-open-login]')).toBeNull();
    expect(memberCard?.querySelector('.vip-status-cta')?.getAttribute('href')).toBe('#plans');
  });
});
