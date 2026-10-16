import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSponsorPage } from '../src/sponsor-page';

function mountInJsdom(): HTMLElement {
  const dom = new JSDOM('<main id="app"></main>');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  const root = dom.window.document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing test app root');
  mountSponsorPage(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sponsor page', () => {
  beforeEach(() => {
    // 默认返回一个「接口暂时不可用」的响应，各用例可自行覆盖。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 }),
    );
  });

  it('renders the cyber-begging hero, the closed notice and disabled donation CTAs', () => {
    const root = mountInJsdom();
    expect(root.querySelector('h1')?.textContent).toBe('赛博化缘');
    // 导航中存在 /sponsor 入口且高亮当前页。
    const navLink = root.querySelector('.site-nav a[href="/sponsor"]');
    expect(navLink).not.toBeNull();
    expect(navLink?.getAttribute('aria-current')).toBe('page');
    expect(navLink?.querySelector('.ph-coffee')).not.toBeNull();
    // 捐款通道暂停公告：说明通道已关闭并感谢此前捐款的同学。
    const banner = root.querySelector('.sponsor-closed-banner');
    expect(banner).not.toBeNull();
    const bannerText = banner?.textContent ?? '';
    expect(bannerText).toContain('捐款通道暂时关闭');
    expect(bannerText).toContain('感谢');
    // 所有打赏入口都渲染为不可点击的禁用态。
    const closedCtas = [...root.querySelectorAll<HTMLElement>('[data-sponsor-closed]')];
    expect(closedCtas.length).toBeGreaterThanOrEqual(2);
    for (const cta of closedCtas) {
      expect(cta.getAttribute('aria-disabled')).toBe('true');
      expect(cta.classList.contains('sponsor-cta-button--disabled')).toBe(true);
      expect(cta.textContent).toContain('捐款通道暂时关闭');
    }
    // 页面内不再存在任何跳转 Stripe / 爱发电的捐款按钮。
    expect(root.querySelectorAll('a[href*="donate.stripe.com"]')).toHaveLength(0);
    expect(root.querySelectorAll('a[href*="afdian.com"]')).toHaveLength(0);
    expect(root.querySelector('[data-sponsor-stripe], [data-sponsor-cta]')).toBeNull();
    // 初始加载态。
    expect(root.querySelector('[data-sponsor-income]')?.textContent).toBe('—');
    expect(root.querySelector('.sponsor-honor-loading')).not.toBeNull();
  });

  it('fills this month income and renders the honor roll sorted by amount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        month: '2026-10',
        monthLabel: '2026 年 10 月',
        monthIncome: '12.50',
        monthOrderCount: 3,
        supporterCount: 3,
        // Worker 已按累计金额降序返回，前端直接按接口顺序渲染。
        supporters: [
          {
            id: 'stripe:a@x.com',
            name: 'Stripe 老王',
            avatar: '',
            url: '',
            amount: '6.50',
            lastPayAt: 2,
            source: 'stripe',
          },
          {
            id: 'bob-uid',
            name: '<img src=x onerror=alert(1)>鲍勃',
            avatar: '',
            url: 'https://afdian.com/u/bob-uid',
            amount: '6.00',
            lastPayAt: 2,
            source: 'afdian',
          },
          {
            id: 'alice-uid',
            name: '爱丽丝',
            avatar: 'https://img.example/a.jpg',
            url: 'https://afdian.com/u/alice-uid',
            amount: '6.00',
            lastPayAt: 1,
            // 缺省 source 视为爱发电。
          },
        ],
        generatedAt: Date.now(),
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const root = mountInJsdom();
    await vi.waitFor(() => expect(root.querySelector('[data-sponsor-income]')?.textContent).toBe('12.50'), { timeout: 1000 });
    expect(fetch).toHaveBeenCalledWith('/api/v1/sponsors', expect.any(Object));
    expect(root.querySelector('[data-sponsor-month]')?.textContent).toContain('2026 年 10 月');
    expect(root.querySelector('[data-sponsor-status]')?.textContent).toContain('3 笔支持');

    const cards = [...root.querySelectorAll<HTMLElement>('.sponsor-honor-card')];
    expect(cards).toHaveLength(3);
    // 金额高者排第一，前三名展示奖牌图标。
    expect(cards[0]!.querySelector('.honor-rank--gold .ph-crown')).not.toBeNull();
    expect(cards[0]!.querySelector('.honor-amount')?.textContent).toBe('¥6.50');
    // 榜首来自 Stripe：紫色实底徽章 + 「Stripe」文案。
    expect(cards[0]!.querySelector('.sponsor-source-badge--stripe')?.textContent).toBe('Stripe');
    // 第二位来自爱发电：金色描边徽章 + 「爱发电」文案。
    expect(cards[1]!.querySelector('.sponsor-source-badge--afdian')?.textContent).toBe('爱发电');
    expect(cards[1]!.querySelector('.honor-rank--silver .ph-medal')).not.toBeNull();
    expect(cards[1]!.querySelector('.honor-amount')?.textContent).toBe('¥6.00');
    // 缺省 source 也展示为爱发电徽章（向后兼容旧缓存）。
    expect(cards[2]!.querySelector('.sponsor-source-badge--afdian')?.textContent).toBe('爱发电');
    // 昵称中的 HTML 必须被当作纯文本转义，不产生注入节点。
    expect(root.querySelector('.sponsor-honor img[onerror]')).toBeNull();
    expect(cards[1]!.querySelector('.honor-name')?.textContent).toContain('鲍勃');
    // 无头像时使用首字兜底。
    expect(cards[1]!.querySelector('.honor-avatar--fallback')?.textContent).toBe('<');
  });

  it('keeps every donation CTA disabled even when the API exposes a Stripe link', async () => {
    const configured = 'https://donate.stripe.com/test-configured-donation';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        month: '2026-10',
        monthLabel: '2026 年 10 月',
        monthIncome: '0.00',
        monthOrderCount: 0,
        supporterCount: 0,
        supporters: [],
        generatedAt: Date.now(),
        stripeDonateUrl: configured,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const root = mountInJsdom();
    await vi.waitFor(() => expect(root.querySelector('[data-sponsor-income]')?.textContent).toBe('0.00'), { timeout: 1000 });
    // 后端即使返回了可用的 Stripe 链接，通道关闭期间也不得渲染成可点击按钮。
    expect(root.querySelectorAll(`a[href="${configured}"]`)).toHaveLength(0);
    const closedCtas = [...root.querySelectorAll<HTMLElement>('[data-sponsor-closed]')];
    expect(closedCtas.length).toBeGreaterThanOrEqual(2);
    expect(closedCtas.every((cta) => cta.getAttribute('aria-disabled') === 'true')).toBe(true);
  });

  it('shows an empty honor roll message when nobody has sponsored yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        month: '2026-10',
        monthLabel: '2026 年 10 月',
        monthIncome: '0.00',
        monthOrderCount: 0,
        supporterCount: 0,
        supporters: [],
        generatedAt: Date.now(),
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const root = mountInJsdom();
    await vi.waitFor(() => expect(root.querySelector('.sponsor-honor-empty')).not.toBeNull(), { timeout: 1000 });
    expect(root.querySelectorAll('.sponsor-honor-card')).toHaveLength(0);
    expect(root.querySelector('.sponsor-honor-empty')?.textContent).toContain('等你来当榜首');
  });

  it('degrades gracefully when the sponsor API fails', async () => {
    const root = mountInJsdom();
    await vi.waitFor(() => expect(root.querySelector('.sponsor-honor-error')).not.toBeNull(), { timeout: 1000 });
    expect(root.querySelector('[data-sponsor-income]')?.textContent).toBe('—');
    expect(root.querySelector('.sponsor-honor-error')?.textContent).toContain('稍后再来看榜');
  });
});
