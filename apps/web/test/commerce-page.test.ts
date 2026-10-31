import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_DAY_MS, getCommerceCatalog } from '@lastroweb/commerce';
import { createCommerceApi, type CommerceApi, type CommerceBootstrap, type CommerceOrderPage, type CommerceOrderView, type CommerceQuote } from '../src/commerce-api';
import { mountCommercePage, readCommerceBootstrap } from '../src/commerce-page';

const NOW = Date.now();
const DAY = Number(COMMERCE_DAY_MS);

function entitlement(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.entitlementId ?? '10');
  return {
    id, entitlementId: id, unitId: '1', resource: 'slots', quantity: 1,
    startsAt: String(NOW - DAY), expiresAt: String(NOW + 15 * DAY),
    productKey: 'slots', source: 'commerce', sourceRef: null, isGift: false, ...overrides,
  };
}

function bootstrap(overrides: Partial<CommerceBootstrap> = {}): CommerceBootstrap {
  const slotUnits = [
    { unitId: '900', entitlementId: '20', resource: 'slots', kind: 'legacy', quantity: 1, startsAt: String(NOW - DAY), expiresAt: String(NOW + 99 * 365 * DAY), source: 'signup', sourceRef: 'email-verified:slots', isGift: true },
    { unitId: '901', entitlementId: '10', resource: 'slots', kind: 'commerce', quantity: 1, startsAt: String(NOW - DAY), expiresAt: String(NOW + 15 * DAY), source: 'commerce', sourceRef: null, isGift: false },
    { unitId: '902', entitlementId: '11', resource: 'slots', kind: 'commerce', quantity: 1, startsAt: String(NOW - DAY), expiresAt: String(NOW + 20 * DAY), source: 'commerce', sourceRef: null, isGift: false },
  ];
  const entitlements = [
    entitlement({ entitlementId: '20', unitId: '900', expiresAt: String(NOW + 99 * 365 * DAY), isGift: true }),
    entitlement({ entitlementId: '10', unitId: '901', expiresAt: String(NOW + 15 * DAY) }),
    entitlement({ entitlementId: '11', unitId: '902', expiresAt: String(NOW + 20 * DAY) }),
    entitlement({ entitlementId: '12', unitId: null, resource: 'module:core', productKey: null, expiresAt: String(NOW + 99 * 365 * DAY), isGift: true }),
    entitlement({ entitlementId: '13', unitId: null, resource: 'module:standalone', productKey: 'module:standalone', expiresAt: String(NOW + 3 * DAY) }),
  ];
  return {
    version: 1,
    catalog: getCommerceCatalog('ke-commerce-test-v1'),
    session: {
      user: { id: '42', email: 'player@example.test', display_name: '玩家', status: 'ACTIVE', permission_level: 1, email_verified_at: NOW, created_at: NOW, has_avatar: false, avatar_version: 0, avatar_url: '' },
      expires_at: NOW + DAY, csrf_token: 'v1.s.session-csrf', mail_availability: null,
    },
    account: {
      units: slotUnits,
      entitlements,
      effective: { slots: 3, modules: ['core', 'standalone'] },
    },
    ...overrides,
  } as CommerceBootstrap;
}

function quote(overrides: Partial<CommerceQuote> = {}): CommerceQuote {
  const before = [
    entitlement({ entitlementId: '20', unitId: '900', expiresAt: String(NOW + 99 * 365 * DAY), isGift: true }),
    entitlement({ entitlementId: '10', unitId: '901', expiresAt: String(NOW + 15 * DAY) }),
    entitlement({ entitlementId: '11', unitId: '902', expiresAt: String(NOW + 20 * DAY) }),
    entitlement({ entitlementId: '12', unitId: null, resource: 'module:core', productKey: null, expiresAt: String(NOW + 99 * 365 * DAY), isGift: true }),
    entitlement({ entitlementId: '13', unitId: null, resource: 'module:standalone', productKey: 'module:standalone', expiresAt: String(NOW + 3 * DAY) }),
  ];
  return {
    quoteId: '901', pricingVersion: 'ke-commerce-test-v1', currency: 'CNY', createdAt: String(NOW), expiresAt: String(NOW + 120_000),
    items: [{ ordinal: 1, productKey: 'slots', operation: 'RENEW', targetUnitId: '901', targetEntitlementId: '10', durationMs: String(30 * DAY), expectedStartsAt: String(NOW + 15 * DAY), expectedExpiresAt: String(NOW + 45 * DAY), discountPercent: 100, rawCents: '5000', tierCents: '5000', paidCents: '5000' }],
    accountPreview: {
      before: { entitlements: before, effective: { slots: 3, modules: ['core', 'standalone'] } },
      after: { entitlements: before.map((row) => row.entitlementId === '10' ? { ...row, expiresAt: String(NOW + 45 * DAY) } : row), effective: { slots: 3, modules: ['core', 'standalone'] } },
    },
    rawTotalCents: '5000', tierTotalCents: '5000', promoTotalCents: null, selectedTotalCents: '5000',
    discountStrategy: 'term', promotion: null,
    ...overrides,
  } as CommerceQuote;
}

function orderView(overrides: Partial<CommerceOrderView> = {}): CommerceOrderView {
  const reviewed = quote();
  return {
    orderId: '902', createdAt: String(NOW), currency: 'CNY', pricingVersion: 'ke-commerce-test-v1',
    rawTotalCents: '5000', tierTotalCents: '5000', promoTotalCents: null, paidTotalCents: '5000',
    discountStrategy: 'term', accountPreview: reviewed.accountPreview, checkoutState: 'ready',
    checkoutExpiresAt: String(NOW + 1_800_000), paymentState: 'paid', fulfillmentState: 'fulfilled',
    refundState: 'none', paidAt: String(NOW + 1000), fulfilledAt: String(NOW + 1000),
    refundedTotalCents: '0', checkoutUrl: null,
    items: [{ ...reviewed.items[0]!, operation: 'RENEW', deliveryState: 'delivered', deliveredAt: String(NOW + 1000),
      fulfillmentBefore: { startsAt: String(NOW - DAY), expiresAt: String(NOW + 15 * DAY) },
      fulfillmentAfter: { startsAt: String(NOW - DAY), expiresAt: String(NOW + 45 * DAY) }, refundAdjustments: [] }],
    refunds: [], ...overrides,
  };
}

function mount(options: {
  account?: CommerceBootstrap['account'];
  quote?: CommerceQuote;
  historyPage?: CommerceOrderPage;
  url?: string;
  orderStatuses?: CommerceOrderView[];
} = {}) {
  const dom = new JSDOM('<main id="app"></main>', { url: options.url ?? 'https://ltsd.ro/ke/buy' });
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  let statusIndex = 0;
  const api: CommerceApi = {
    quoteCommerceSelection: vi.fn(async () => options.quote ?? quote()),
    createOrder: vi.fn(async () => ({ orderId: '902', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test', expiresAt: String(NOW + 1_800_000), paymentStatus: 'unpaid' })),
    listOrders: vi.fn(async () => options.historyPage ?? ({ items: [], nextCursor: null } satisfies CommerceOrderPage)),
    getOrder: vi.fn(async () => {
      const rows = options.orderStatuses ?? [orderView()];
      const row = rows[Math.min(statusIndex, rows.length - 1)]!;
      statusIndex += 1;
      return row;
    }),
    navigateToCheckout: vi.fn(),
  };
  mountCommercePage(root, bootstrap(options.account ? { account: options.account } : {}), api);
  return { dom, root, api };
}

function click(root: HTMLElement, selector: string): void {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button ${selector}`);
  button.click();
}

function dispatch(root: HTMLElement, target: Element, type: string): void {
  const EventConstructor = root.ownerDocument.defaultView!.Event;
  target.dispatchEvent(new EventConstructor(type, { bubbles: true }));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('commerce purchase page', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('validates the server-rendered bootstrap and rejects unsupported or incomplete data', () => {
    const dom = new JSDOM('<script id="commerce-bootstrap" type="application/json"></script>');
    dom.window.document.querySelector('#commerce-bootstrap')!.textContent = JSON.stringify(bootstrap());
    expect(readCommerceBootstrap(dom.window.document).catalog.pricingVersion).toBe('ke-commerce-test-v1');

    dom.window.document.querySelector('#commerce-bootstrap')!.textContent = JSON.stringify({ version: 2 });
    expect(() => readCommerceBootstrap(dom.window.document)).toThrow();
  });

  it('lists same-day slots separately and prevents renewing the gift slot', () => {
    const account = bootstrap().account;
    account.units[2]!.expiresAt = account.units[1]!.expiresAt;
    const { root } = mount({ account });
    click(root, '[data-mode="renew"]');

    const rows = root.querySelectorAll('[data-slot-unit]');
    const gift = root.querySelector<HTMLInputElement>('[data-slot-unit="900"]');
    expect(rows).toHaveLength(3);
    expect(gift).not.toBeNull();
    expect(gift!.disabled).toBe(true);
    expect(gift!.closest('label')?.textContent).toContain('到期');
    expect(root.querySelector('[data-slot-unit="901"]')).not.toBeNull();
    expect(root.querySelector('[data-slot-unit="902"]')).not.toBeNull();

    const paid = root.querySelector<HTMLInputElement>('[data-slot-unit="901"]')!;
    paid.focus();
    paid.checked = true;
    dispatch(root, paid, 'change');
    expect(root.ownerDocument.activeElement?.getAttribute('data-focus-key')).toBe('unit-901');
  });

  it('keeps discounted terms visible and recalculates multi-slot price exactly', () => {
    const { root, api } = mount();
    const terms = root.querySelector('[data-term-group="slots"]')!;
    expect(root.querySelector('.commerce-quantity-hint')?.textContent).toContain('单笔上限 10 个');
    expect(terms.textContent).toContain('180 天');
    expect(terms.textContent).toContain('8 折');
    expect(terms.textContent).toContain('360 天');
    expect(terms.textContent).toContain('7 折');

    click(root, '[data-term-group="slots"] [data-term-days="180"]');
    const quantity = root.querySelector<HTMLInputElement>('[name="slot-quantity"]')!;
    quantity.value = '2';
    dispatch(root, quantity, 'input');
    expect(root.textContent).toContain('¥480.00');
    expect(api.quoteCommerceSelection).not.toHaveBeenCalled();
  });

  it('combines a slot purchase and the independent offline feature only at final review', async () => {
    const { root, api } = mount();
    const feature = root.querySelector<HTMLInputElement>('[name="feature-selected"]')!;
    feature.checked = true;
    dispatch(root, feature, 'change');
    expect(api.quoteCommerceSelection).not.toHaveBeenCalled();

    click(root, '[data-action="review"]');
    await settle();
    expect(api.quoteCommerceSelection).toHaveBeenCalledWith([
      { type: 'slot_add', quantity: 1, termDays: 30 },
      { type: 'standalone', termDays: 30 },
    ], undefined);
  });

  it('quotes the fixed 15/20/3-day alignment as 35/30/47 days for ¥155.33', async () => {
    const base = bootstrap();
    const aligned = quote({
      items: [
        { ordinal: 1, productKey: 'slots', operation: 'RENEW', targetUnitId: '901', targetEntitlementId: '10', durationMs: String(35 * DAY), expectedStartsAt: String(NOW + 15 * DAY), expectedExpiresAt: String(NOW + 50 * DAY), discountPercent: 100, rawCents: '5833', tierCents: '5833', paidCents: '5833' },
        { ordinal: 2, productKey: 'slots', operation: 'RENEW', targetUnitId: '902', targetEntitlementId: '11', durationMs: String(30 * DAY), expectedStartsAt: String(NOW + 20 * DAY), expectedExpiresAt: String(NOW + 50 * DAY), discountPercent: 100, rawCents: '5000', tierCents: '5000', paidCents: '5000' },
        { ordinal: 3, productKey: 'module:standalone', operation: 'RENEW', targetUnitId: null, targetEntitlementId: '13', durationMs: String(47 * DAY), expectedStartsAt: String(NOW + 3 * DAY), expectedExpiresAt: String(NOW + 50 * DAY), discountPercent: 100, rawCents: '4700', tierCents: '4700', paidCents: '4700' },
      ],
      accountPreview: {
        before: quote().accountPreview.before,
        after: { ...quote().accountPreview.before, entitlements: quote().accountPreview.before.entitlements.map((row) => ['10', '11', '13'].includes(row.entitlementId ?? '') ? { ...row, expiresAt: String(NOW + 50 * DAY) } : row) },
      },
      rawTotalCents: '15533', tierTotalCents: '15533', selectedTotalCents: '15533',
    });
    const { root, api } = mount({ account: base.account, quote: aligned });
    click(root, '[data-action="align"]');
    await settle();

    expect(api.quoteCommerceSelection).toHaveBeenCalledWith([{ type: 'align_all_paid', termDays: 30 }], undefined);
    expect(root.textContent).toContain('35 天');
    expect(root.textContent).toContain('30 天');
    expect(root.textContent).toContain('47 天');
    expect(root.textContent).toContain('¥155.33');
  });

  it('does not request an alignment quote when the paid expiry spread is under 24 hours', async () => {
    const account = bootstrap().account;
    account.units[2]!.expiresAt = String(Number(account.units[1]!.expiresAt) + 23 * 60 * 60 * 1000);
    account.entitlements.find((row) => row.id === '11')!.expiresAt = account.units[2]!.expiresAt;
    account.entitlements.find((row) => row.id === '13')!.expiresAt = String(Number(account.units[1]!.expiresAt) + 12 * 60 * 60 * 1000);
    const { root, api } = mount({ account });
    click(root, '[data-action="align"]');

    expect(api.quoteCommerceSelection).not.toHaveBeenCalled();
    expect(root.querySelector('dialog[open]')?.textContent).toContain('无需统一到期');
  });

  it('blocks alignment when paid slots and the standalone feature exceed the quote item limit', () => {
    const account = bootstrap().account;
    const unitTemplate = account.units[1]!;
    account.units = Array.from({ length: 1000 }, (_, index) => ({
      ...unitTemplate,
      unitId: String(1000 + index),
      entitlementId: String(2000 + index),
      startsAt: String(NOW - DAY),
      expiresAt: String(NOW + (index + 2) * DAY),
      isGift: false,
    }));
    account.entitlements = account.units.map((unit) => entitlement({
      entitlementId: unit.entitlementId,
      unitId: unit.unitId,
      startsAt: unit.startsAt,
      expiresAt: unit.expiresAt,
      isGift: false,
    }));
    account.entitlements.push(entitlement({
      entitlementId: '5000', unitId: null, resource: 'module:standalone', productKey: 'module:standalone',
      expiresAt: String(NOW + DAY), isGift: false,
    }));
    const { root, api } = mount({ account });

    click(root, '[data-action="open-align"]');

    const dialog = root.querySelector<HTMLDialogElement>('[data-align-dialog]')!;
    expect(dialog.querySelector('[data-alignment-limit-error]')).not.toBeNull();
    expect(dialog.querySelector<HTMLButtonElement>('[data-action="align"]')?.disabled).toBe(true);
    expect(api.quoteCommerceSelection).not.toHaveBeenCalled();
  });

  it('excludes standalone rows when the effective account state says the feature is inactive', () => {
    const account = bootstrap().account;
    account.effective.modules = ['core'];
    const { root } = mount({ account });

    expect(root.querySelector('.commerce-align-copy span')?.textContent).toContain('共 2 个付费项');
    expect(root.textContent).toContain('当前未开通，本次购买将开通。');
  });

  it('shows gifted standalone access as active but excludes it from paid renewal and alignment', () => {
    const account = bootstrap().account;
    const standalone = account.entitlements.find((row) => row.resource === 'module:standalone')!;
    Object.assign(standalone, {
      source: 'signup', sourceRef: 'email-verified:module:standalone', isGift: true,
      expiresAt: String(NOW + 99 * 365 * DAY),
    });
    const { root } = mount({ account });

    const featureCard = root.querySelector('[data-product="feature"]')!;
    expect(featureCard.textContent).toContain('当前通过赠送开通');
    expect(featureCard.textContent).toContain('购买付费期');
    expect(featureCard.textContent).not.toContain('当前未开通');
    expect(root.querySelector('.commerce-align-copy span')?.textContent).toContain('共 2 个付费项');

    click(root, '[data-action="open-align"]');
    expect(root.querySelector('[data-align-dialog] .commerce-align-details')?.textContent).not.toContain('脱机 KoreEngine');
  });

  it('shows every current entitlement before and after, including gifts and unchanged rows', async () => {
    const { root } = mount();
    click(root, '[data-mode="renew"]');
    root.querySelector<HTMLInputElement>('[data-slot-unit="901"]')!.checked = true;
    dispatch(root, root.querySelector<HTMLInputElement>('[data-slot-unit="901"]')!, 'change');
    click(root, '[data-action="review"]');
    await settle();

    const preview = root.querySelector('[data-account-preview]')!;
    expect(preview.querySelectorAll('[data-preview-row]')).toHaveLength(5);
    expect(preview.textContent).toContain('赠送挂机额度');
    expect(preview.textContent).toContain('脱机 KoreEngine');
    expect(preview.textContent).toContain('购买前');
    expect(preview.textContent).toContain('购买后');
    const giftRow = preview.querySelector('[data-preview-row="id:20"]')!;
    expect(giftRow.className).not.toContain('is-collapsed-row');
  });

  it('uses and labels the browser local timezone for entitlement dates', () => {
    const { root } = mount();
    expect(root.textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('passes a promotion code only on review and displays the single winning whole-order discount', async () => {
    const discounted = quote({
      rawTotalCents: '8000', tierTotalCents: '8000', promoTotalCents: '6000', selectedTotalCents: '6000',
      discountStrategy: 'promotion_code',
      promotion: { subtotalCents: 8000, totalCents: 6000, discountCents: 2000, currency: 'cny', applied: true },
    });
    const { root, api } = mount({ quote: discounted });
    const code = root.querySelector<HTMLInputElement>('[name="promotion-code"]')!;
    code.value = 'FESTIVAL';
    dispatch(root, code, 'input');
    expect(api.quoteCommerceSelection).not.toHaveBeenCalled();
    click(root, '[data-action="review"]');
    await settle();

    expect(api.quoteCommerceSelection).toHaveBeenCalledWith([{ type: 'slot_add', quantity: 1, termDays: 30 }], 'FESTIVAL');
    expect(root.textContent).toContain('整单优惠码');
    expect(root.textContent).toContain('不重复叠加');
    expect(root.textContent).toContain('¥60.00');
  });

  it('keeps a promotion-code input available outside the desktop-only summary', () => {
    const { root } = mount();
    const mobilePromotion = root.querySelector('[data-mobile-promo]');

    expect(mobilePromotion).not.toBeNull();
    expect(mobilePromotion!.closest('.commerce-summary')).toBeNull();
    expect(mobilePromotion!.querySelector('[name="promotion-code"]')).not.toBeNull();
  });

  it('blocks selections exceeding the combined 1000-item quote limit before requesting a quote', () => {
    const { root, api } = mount();
    const quantity = root.querySelector<HTMLInputElement>('[name="slot-quantity"]')!;
    quantity.value = '1000';
    dispatch(root, quantity, 'input');
    const feature = root.querySelector<HTMLInputElement>('[name="feature-selected"]')!;
    feature.checked = true;
    dispatch(root, feature, 'change');

    const limitError = root.querySelector('[data-selection-limit-error]');
    expect(limitError).not.toBeNull();
    expect(limitError!.textContent).toContain('单笔最多 1000 个权益项');
    expect(root.querySelector<HTMLButtonElement>('[data-action="review"]')?.disabled).toBe(true);
    expect(api.quoteCommerceSelection).not.toHaveBeenCalled();
  });

  it('shows the browser timezone on the order confirmation preview', async () => {
    const { root } = mount();
    click(root, '[data-action="review"]');
    await settle();

    const timezone = root.querySelector('[data-confirm-timezone]');
    expect(timezone).not.toBeNull();
    expect(timezone!.textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('invalidates a reviewed quote when the purchase selection changes', async () => {
    const { root, api } = mount();
    click(root, '[data-action="review"]');
    await settle();
    expect(root.querySelector('[data-account-preview]')).not.toBeNull();

    const quantity = root.querySelector<HTMLInputElement>('[name="slot-quantity"]')!;
    quantity.value = '2';
    dispatch(root, quantity, 'input');
    expect(root.querySelector('[data-account-preview]')).toBeNull();
    expect(api.quoteCommerceSelection).toHaveBeenCalledTimes(1);
  });

  it('discards a quote response when the selection changes while the request is pending', async () => {
    let resolveQuote!: (value: CommerceQuote) => void;
    const pendingQuote = new Promise<CommerceQuote>((resolve) => { resolveQuote = resolve; });
    const { root, api } = mount();
    vi.mocked(api.quoteCommerceSelection).mockReturnValueOnce(pendingQuote);

    click(root, '[data-action="review"]');
    const quantity = root.querySelector<HTMLInputElement>('[name="slot-quantity"]')!;
    quantity.value = '2';
    dispatch(root, quantity, 'input');
    resolveQuote(quote());
    await settle();

    expect(root.querySelector('[data-review-result]')).toBeNull();
    expect(root.querySelector('[data-action="pay"]')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-action="review"]')?.disabled).toBe(false);
  });

  it('creates the immutable order only after review and navigates to Stripe', async () => {
    const { root, api } = mount();
    click(root, '[data-action="review"]');
    await settle();
    expect(api.createOrder).not.toHaveBeenCalled();

    click(root, '[data-action="pay"]');
    await settle();
    expect(api.createOrder).toHaveBeenCalledWith('901', expect.stringMatching(/^[0-9a-f-]{36}$/u));
    expect(api.navigateToCheckout).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test');
  });

  it('loads purchase history on demand and opens immutable order details', async () => {
    const { root, api } = mount({ historyPage: {
      items: [{
        orderId: '902', createdAt: String(NOW), currency: 'CNY', paidTotalCents: '5000',
        paymentState: 'paid', fulfillmentState: 'fulfilled', refundState: 'none', refundedTotalCents: '0', itemCount: 1,
      }], nextCursor: null,
    } });
    expect(api.listOrders).not.toHaveBeenCalled();
    click(root, '[data-action="purchase-history"]');
    await settle();

    expect(api.listOrders).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('购买记录');
    expect(root.textContent).toContain('902');
    click(root, '[data-action="open-order"][data-order-id="902"]');
    await settle();

    expect(api.getOrder).toHaveBeenCalledWith('902', undefined);
    expect(root.textContent).toContain('购买前');
    expect(root.textContent).toContain('购买后');
    expect(root.textContent).toContain('额度');
  });

  it('polls only the returned order until delivery completes and ignores the Stripe session query value', async () => {
    vi.useFakeTimers();
    const processing = orderView({ paymentState: 'processing', fulfillmentState: 'pending', fulfilledAt: null });
    const paid = orderView({ paymentState: 'paid', fulfillmentState: 'pending', fulfilledAt: null });
    const fulfilled = orderView();
    const { root, api } = mount({
      url: 'https://ltsd.ro/ke/buy?checkout=success&order_id=902&session_id=untrusted',
      orderStatuses: [processing, paid, fulfilled],
    });

    expect(root.textContent).toContain('正在确认付款');
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 2; index += 1) {
      await vi.advanceTimersByTimeAsync(1500);
    }

    expect(api.getOrder).toHaveBeenNthCalledWith(1, '902', { statusOnly: true });
    expect(api.getOrder).toHaveBeenCalledTimes(3);
    expect(api.listOrders).not.toHaveBeenCalled();
    expect(root.textContent).toContain('购买已完成');
    expect(root.textContent).not.toContain('暂无购买记录');
    vi.useRealTimers();
  });

  it('stops polling after asynchronous payment failure', async () => {
    vi.useFakeTimers();
    const failed = orderView({ paymentState: 'failed', fulfillmentState: 'pending', fulfilledAt: null });
    const { api } = mount({
      url: 'https://ltsd.ro/ke/buy?checkout=success&order_id=902', orderStatuses: [failed],
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(api.getOrder).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(api.getOrder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a canceled Checkout order once and leaves its unpaid state available for resuming payment', async () => {
    const pending = orderView({
      paymentState: 'unpaid', fulfillmentState: 'pending', paidAt: null, fulfilledAt: null,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test',
    });
    const { root, api } = mount({
      url: 'https://ltsd.ro/ke/buy?checkout=cancelled&order_id=902', orderStatuses: [pending],
    });
    await settle();

    expect(api.getOrder).toHaveBeenCalledTimes(1);
    expect(api.getOrder).toHaveBeenCalledWith('902', undefined);
    expect(api.createOrder).not.toHaveBeenCalled();
    expect(root.textContent).toContain('付款未完成');
    expect(root.querySelector('[data-action="resume-checkout"]')).not.toBeNull();
  });

  it('serializes quote selections and sends checkout idempotency through sessionRequest headers', async () => {
    const calls: Array<{ path: string; method: string; body: unknown; headers: HeadersInit | undefined }> = [];
    const authClient = {
      sessionRequest: vi.fn(async (path: string, method: string, body?: unknown, headers?: HeadersInit) => {
        calls.push({ path, method, body, headers });
        return path.endsWith('/quotes') ? quote() : { orderId: '902', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test', expiresAt: String(NOW + DAY), paymentStatus: 'unpaid' };
      }),
    };
    const api = createCommerceApi(authClient as never);
    await api.quoteCommerceSelection([
      { type: 'slot_add', quantity: 2, termDays: 180 },
      { type: 'standalone', termDays: 30 },
    ], 'HOLIDAY');
    await api.createOrder('901', 'idempotency-1');

    expect(calls[0]).toMatchObject({ path: '/api/v1/commerce/quotes', method: 'POST', body: {
      selection: [{ type: 'slot_add', quantity: 2, term_days: 180 }, { type: 'standalone', term_days: 30 }], promotion_code: 'HOLIDAY',
    } });
    expect(calls[1]?.path).toBe('/api/v1/commerce/orders');
    expect(new Headers(calls[1]?.headers).get('Idempotency-Key')).toBe('idempotency-1');
  });

  it('uses authenticated no-CSRF reads for order history and status polling', async () => {
    const reads: string[] = [];
    const summary = {
      orderId: '902', createdAt: String(NOW), currency: 'CNY', paidTotalCents: '5000',
      paymentState: 'paid', fulfillmentState: 'fulfilled', refundState: 'none', refundedTotalCents: '0', itemCount: 1,
    } as const;
    const authClient = {
      sessionRequest: vi.fn(),
      sessionRead: vi.fn(async (path: string) => {
        reads.push(path);
        return path.startsWith('/api/v1/commerce/orders?') ? { items: [summary], nextCursor: 'next_cursor' } : orderView();
      }),
    };
    const api = createCommerceApi(authClient as never);
    const page = await api.listOrders('cursor_1');
    const detail = await api.getOrder('902', { statusOnly: true });

    expect(reads).toEqual([
      '/api/v1/commerce/orders?cursor=cursor_1',
      '/api/v1/commerce/orders/902?status_only=1',
    ]);
    expect(page.items).toEqual([summary]);
    expect(detail.orderId).toBe('902');
    expect(authClient.sessionRequest).not.toHaveBeenCalled();
  });

  it('accepts failed payment states from order history and detail API responses', async () => {
    const failedSummary = {
      orderId: '902', createdAt: String(NOW), currency: 'CNY', paidTotalCents: '5000',
      paymentState: 'failed', fulfillmentState: 'pending', refundState: 'none', refundedTotalCents: '0', itemCount: 1,
    } as const;
    const failedDetail = orderView({ paymentState: 'failed', fulfillmentState: 'pending', fulfilledAt: null });
    const authClient = {
      sessionRead: vi.fn(async (path: string) => path === '/api/v1/commerce/orders' || path.startsWith('/api/v1/commerce/orders?')
        ? { items: [failedSummary], nextCursor: null }
        : failedDetail),
    };
    const api = createCommerceApi(authClient as never);

    const history = await api.listOrders();
    const detail = await api.getOrder('902');

    expect(history.items[0]?.paymentState).toBe('failed');
    expect(detail.paymentState).toBe('failed');
  });
});
