import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import { createOrderRepository } from '../src/commerce/orders';
import { createOrderAndCheckout, CommerceOrderError } from '../src/commerce/orders';
import type { OrderDependencies, OrderRepository, StoredCommerceOrder } from '../src/commerce/orders';
import type { StripeClient } from '../src/commerce/stripe-client';
import type { CommerceQuote } from '../src/commerce/quotes';
import { digestToken } from '../src/auth/crypto';
import { issueCsrf } from '../src/auth/csrf';
import type { AuthRepository } from '../src/auth/repository';
import type { AuthIdentity, AuthSessionResponse, AuthRuntime, EnabledAuthConfig } from '../src/auth/types';
import { registerCommerceOrderRoute } from '../src/commerce/router';

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
const CHECKOUT_MINIMUM_TTL_MS = 30 * 60_000;
const CHECKOUT_CREATION_MARGIN_MS = 30_000;
const EXPIRY = Math.ceil(NOW / 1000) * 1000 + CHECKOUT_MINIMUM_TTL_MS + CHECKOUT_CREATION_MARGIN_MS;
const ITEM = {
  ordinal: 1,
  productKey: 'slots' as const,
  operation: 'ADD' as const,
  targetUnitId: null,
  targetEntitlementId: null,
  durationMs: String(MONTH_MS),
  expectedStartsAt: String(NOW),
  expectedExpiresAt: String(NOW + MONTH_MS),
  discountPercent: 100 as const,
  rawCents: '5000',
  tierCents: '5000',
  paidCents: '5000',
};

function quote(overrides: Partial<CommerceQuote> = {}): CommerceQuote {
  return {
    quoteId: '501', pricingVersion: 'ke-commerce-test-v1', currency: 'CNY',
    createdAt: String(NOW), expiresAt: String(NOW + 120_000), requestHash: 'a'.repeat(64),
    items: [ITEM],
    accountPreview: {
      before: { entitlements: [], effective: { slots: 0, modules: [] } },
      after: { entitlements: [], effective: { slots: 1, modules: [] } },
    },
    rawTotalCents: '5000', tierTotalCents: '5000', promoTotalCents: null,
    selectedTotalCents: '5000', discountStrategy: 'term', promotion: null,
    ...overrides,
  };
}

function order(overrides: Partial<StoredCommerceOrder> = {}): StoredCommerceOrder {
  return {
    orderId: '701', userId: '42', quoteId: '501', requestHash: 'a'.repeat(64),
    confirmationKeyDigest: 'b'.repeat(64), pricingVersion: 'ke-commerce-test-v1', currency: 'CNY',
    stripeAccountId: 'acct_test', livemode: false,
    items: [{ ...ITEM, stripeProductId: 'prod_slots' }], accountPreview: quote().accountPreview,
    rawTotalCents: '5000', tierTotalCents: '5000', promoTotalCents: null, paidTotalCents: '5000',
    discountStrategy: 'term', promotion: null,
    paymentMethodConfigurationId: 'pmc_ordinary', siteOrigin: 'https://ltsd.ro', checkoutState: 'creating',
    stripeCheckoutSessionId: null, checkoutExpiresAt: null, createdAt: NOW,
    ...overrides,
  };
}

function dependencies(options: {
  order?: StoredCommerceOrder;
  reserveOrder?: OrderRepository['reserveOrder'];
  stripePost?: StripeClient['post'];
  stripeGet?: StripeClient['get'];
} = {}): OrderDependencies & { repository: OrderRepository; stripe: StripeClient } {
  let stored = options.order ?? order();
  const repository: OrderRepository = {
    reserveOrder: options.reserveOrder ?? vi.fn(async () => stored),
    readOrderHistory: vi.fn(async () => null),
    listOrderHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    prepareCheckout: vi.fn(async (_orderId, proposedExpiry) => {
      stored = { ...stored, checkoutExpiresAt: stored.checkoutExpiresAt ?? proposedExpiry };
      return stored.checkoutExpiresAt;
    }),
    markCheckoutReady: vi.fn(async (_orderId, session) => {
      stored = { ...stored, checkoutState: 'ready', stripeCheckoutSessionId: session.sessionId, checkoutExpiresAt: session.expiresAt };
    }),
    markCheckoutFailed: vi.fn(async () => { stored = { ...stored, checkoutState: 'failed' }; }),
    markCheckoutExpired: vi.fn(async () => { stored = { ...stored, checkoutState: 'expired' }; }),
  };
  const stripe: StripeClient = {
    post: options.stripePost ?? vi.fn(async () => ({ id: 'cs_test_701', url: 'https://checkout.stripe.com/c/pay/cs_test_701', expires_at: EXPIRY / 1000, status: 'open', payment_status: 'unpaid', livemode: false })),
    get: options.stripeGet ?? vi.fn(async () => ({ id: 'cs_test_701', url: 'https://checkout.stripe.com/c/pay/cs_test_701', expires_at: EXPIRY / 1000, status: 'open', payment_status: 'unpaid', livemode: false })),
  } as unknown as StripeClient;
  return {
    repository, stripe, now: () => NOW, pricingVersion: 'ke-commerce-test-v1',
    stripeAccountId: 'acct_test', livemode: false, paymentMethodConfigurationId: 'pmc_ordinary',
    productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
    siteOrigin: 'https://ltsd.ro', ensureCustomer: vi.fn(async () => 'cus_42'),
  };
}

describe('immutable commerce orders and Stripe Checkout', () => {
  it('creates one CNY payment Session with fixed line items and a 30-minute window plus Stripe boundary margin', async () => {
    const deps = dependencies();

    const result = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-abc-123' }, deps);

    expect(result).toMatchObject({ orderId: '701', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_701', expiresAt: EXPIRY });
    expect(deps.stripe.post).toHaveBeenCalledWith('/checkout/sessions', expect.objectContaining({
      mode: 'payment', customer: 'cus_42',
      line_items: [{ price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 }],
      client_reference_id: '701',
      metadata: { ltsd_commerce_order_id: '701' },
      payment_intent_data: { metadata: { ltsd_commerce_order_id: '701' } },
      payment_method_configuration: 'pmc_ordinary',
      expires_at: EXPIRY / 1000,
      managed_payments: { enabled: false }, adaptive_pricing: { enabled: false },
      allow_promotion_codes: false,
    }), { idempotencyKey: expect.stringContaining('ke-commerce:checkout:v1') });
    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('payment_method_types');
    expect(String(params.success_url)).toContain('{CHECKOUT_SESSION_ID}');
    expect(String(params.success_url)).toContain('https://ltsd.ro/ke/buy');
    expect(String(params.cancel_url)).toContain('https://ltsd.ro/ke/buy');
    expect(deps.repository.markCheckoutReady).toHaveBeenCalledWith('701', expect.objectContaining({ sessionId: 'cs_test_701' }), NOW);
  });

  it('rejects a failed Stripe configuration preflight before reserving an immutable order', async () => {
    const deps = dependencies();
    deps.validateStripeConfiguration = vi.fn(async () => { throw new Error('provider configuration invalid'); });

    await expect(createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-preflight' }, deps))
      .rejects.toMatchObject({ code: 'COMMERCE_ORDER_UNAVAILABLE' });
    expect(deps.validateStripeConfiguration).toHaveBeenCalledOnce();
    expect(deps.repository.reserveOrder).not.toHaveBeenCalled();
  });

  it('applies the Stripe-native promotion only when the fixed quote selected it', async () => {
    const promotion = { promotionCodeId: 'promo_holiday', couponId: 'coupon_holiday', subtotalCents: 5000, totalCents: 3000, discountCents: 2000, currency: 'cny' as const };
    const promoOrder = order({
      discountStrategy: 'promotion_code', promotion,
      rawTotalCents: '5000', tierTotalCents: '5000', promoTotalCents: '3000', paidTotalCents: '3000',
      items: [{ ...ITEM, stripeProductId: 'prod_slots', discountPercent: 100, tierCents: '5000', paidCents: '3000' }],
    });
    const deps = dependencies({ order: promoOrder });
    await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-promo' }, deps);

    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.line_items).toEqual([{ price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 }]);
    expect(params.discounts).toEqual([{ promotion_code: 'promo_holiday' }]);
    expect(params.allow_promotion_codes).toBe(false);
  });

  it('groups quote items with identical product and price into a Stripe quantity', async () => {
    const items = [
      { ...ITEM, ordinal: 1, stripeProductId: 'prod_slots' },
      { ...ITEM, ordinal: 2, stripeProductId: 'prod_slots' },
    ];
    const deps = dependencies({ order: order({
      items,
      rawTotalCents: '10000', tierTotalCents: '10000', paidTotalCents: '10000',
    }) });

    await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-quantity' }, deps);

    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.line_items).toEqual([{ price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 2 }]);
  });

  it('keeps Checkout items with different durations separate even when rounded prices match', async () => {
    const items = [
      { ...ITEM, ordinal: 1, stripeProductId: 'prod_slots' },
      {
        ...ITEM, ordinal: 2, stripeProductId: 'prod_slots', durationMs: String(MONTH_MS + 1),
        expectedExpiresAt: String(NOW + MONTH_MS + 1),
      },
    ];
    const deps = dependencies({ order: order({
      items,
      rawTotalCents: '10000', tierTotalCents: '10000', paidTotalCents: '10000',
    }) });

    await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-distinct-duration' }, deps);

    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.line_items).toEqual([
      { price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 },
      { price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 },
    ]);
  });

  it('keeps Checkout under Stripe line-item limit by aggregating more than 100 distinct prices', async () => {
    const items = Array.from({ length: 101 }, (_, index) => {
      const cents = String(1000 + index);
      return {
        ...ITEM, ordinal: index + 1, stripeProductId: 'prod_slots',
        rawCents: cents, tierCents: cents, paidCents: cents,
      };
    });
    const total = String(101 * 1050);
    const deps = dependencies({ order: order({
      items, rawTotalCents: total, tierTotalCents: total, paidTotalCents: total,
    }) });

    await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-line-limit' }, deps);

    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.line_items).toEqual([{ price_data: { currency: 'cny', product: 'prod_slots', unit_amount: Number(total) }, quantity: 1 }]);
  });

  it('keeps Stripe minimum session lifetime after customer and database setup delays', async () => {
    let now = NOW;
    let stripeRequestTime = 0;
    const deps = dependencies({
      stripePost: vi.fn(async (_path, params) => ({
        id: 'cs_test_701', url: 'https://checkout.stripe.com/c/pay/cs_test_701',
        expires_at: Number(params?.expires_at), status: 'open', payment_status: 'unpaid', livemode: false,
      })),
    });
    deps.now = () => now;
    deps.ensureCustomer = vi.fn(async () => {
      now += 10_000;
      return 'cus_42';
    });
    const prepareCheckout = deps.repository.prepareCheckout;
    deps.repository.prepareCheckout = vi.fn(async (orderId, proposedExpiry, updatedAt) => {
      now += 5000;
      return prepareCheckout(orderId, proposedExpiry, updatedAt);
    });
    vi.mocked(deps.stripe.post).mockImplementation(async (_path, params) => {
      stripeRequestTime = now;
      expect(Number(params?.expires_at) * 1000 - stripeRequestTime).toBeGreaterThanOrEqual(CHECKOUT_MINIMUM_TTL_MS);
      return {
        id: 'cs_test_701', url: 'https://checkout.stripe.com/c/pay/cs_test_701',
        expires_at: Number(params?.expires_at), status: 'open', payment_status: 'unpaid', livemode: false,
      };
    });

    const result = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-late-customer' }, deps);

    expect(result.expiresAt).toBe(NOW + 10_000 + CHECKOUT_MINIMUM_TTL_MS + CHECKOUT_CREATION_MARGIN_MS);
    expect(deps.repository.prepareCheckout).toHaveBeenCalledWith('701', result.expiresAt, NOW + 10_000);
    expect(stripeRequestTime).toBe(NOW + 15_000);
  });

  it('does not send Stripe promotion when the fixed quote selected term pricing', async () => {
    const deps = dependencies({ order: order({
      promotion: { promotionCodeId: 'promo_holiday', couponId: 'coupon_holiday', subtotalCents: 5000, totalCents: 5000, discountCents: 0, currency: 'cny' },
      promoTotalCents: '5000',
      discountStrategy: 'term', tierTotalCents: '5000', paidTotalCents: '5000',
      items: [{ ...ITEM, stripeProductId: 'prod_slots', discountPercent: 100, tierCents: '5000', paidCents: '5000' }],
    }) });
    await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-term' }, deps);

    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.line_items).toEqual([{ price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 }]);
    expect(params).not.toHaveProperty('discounts');
  });

  it('uses the same Checkout Session for a repeated confirmation key without closing another order', async () => {
    const ready = order({ checkoutState: 'ready', stripeCheckoutSessionId: 'cs_test_701', checkoutExpiresAt: EXPIRY });
    const get = vi.fn(async () => ({ id: 'cs_test_701', url: 'https://checkout.stripe.com/c/pay/cs_test_701', expires_at: EXPIRY / 1000, status: 'open', payment_status: 'unpaid', livemode: false }));
    const post = vi.fn();
    const deps = dependencies({ order: ready, stripeGet: get, stripePost: post });

    const result = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-same' }, deps);

    expect(result.orderId).toBe('701');
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_701');
    expect(get).toHaveBeenCalledWith('/checkout/sessions/cs_test_701');
    expect(post).not.toHaveBeenCalled();
    expect(deps.stripe.post).not.toHaveBeenCalledWith(expect.stringMatching(/expire/u), expect.anything(), expect.anything());
  });

  it('reuses the immutable product, payment configuration, and return origin after catalog configuration rotates', async () => {
    const pending = order({ checkoutExpiresAt: EXPIRY });
    const deps = dependencies({ order: pending });
    deps.productIds = { slots: 'prod_rotated', 'module:standalone': 'prod_offline_rotated' };
    deps.paymentMethodConfigurationId = 'pmc_rotated';
    deps.siteOrigin = 'https://new.ltsd.ro';

    await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-snapshot' }, deps);

    const params = vi.mocked(deps.stripe.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.line_items).toEqual([{ price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 }]);
    expect(params.payment_method_configuration).toBe('pmc_ordinary');
    expect(String(params.success_url)).toContain('https://ltsd.ro/ke/buy');
  });

  it('rejects an immutable order when the active Stripe account or mode no longer matches it', async () => {
    for (const override of [{ stripeAccountId: 'acct_another' }, { livemode: true }]) {
      const deps = dependencies({ order: order({ checkoutExpiresAt: EXPIRY }) });
      Object.assign(deps, override);

      await expect(createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-wrong-stripe-context' }, deps))
        .rejects.toMatchObject({ code: 'COMMERCE_ORDER_UNAVAILABLE' });
      expect(deps.ensureCustomer).not.toHaveBeenCalled();
      expect(deps.stripe.post).not.toHaveBeenCalled();
    }
  });

  it('rejects a retrieved Checkout Session whose ID differs from the stored order session', async () => {
    const ready = order({ checkoutState: 'ready', stripeCheckoutSessionId: 'cs_test_701', checkoutExpiresAt: EXPIRY });
    const get = vi.fn(async () => ({
      id: 'cs_test_other', url: 'https://checkout.stripe.com/c/pay/cs_test_other',
      expires_at: EXPIRY / 1000, status: 'open', payment_status: 'unpaid', livemode: false,
    }));
    const deps = dependencies({ order: ready, stripeGet: get });

    await expect(createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-mismatched-session' }, deps))
      .rejects.toMatchObject({ code: 'COMMERCE_ORDER_UNAVAILABLE' });
  });

  it('retries an uncertain Session creation with the identical Stripe idempotency key and request', async () => {
    const pending = order({ checkoutExpiresAt: EXPIRY });
    const reserveOrder = vi.fn(async () => pending);
    const post = vi.fn(async () => ({
      id: 'cs_test_701', url: 'https://checkout.stripe.com/c/pay/cs_test_701',
      expires_at: EXPIRY / 1000, status: 'open', payment_status: 'unpaid', livemode: false,
    }));
    const deps = dependencies({ order: pending, reserveOrder, stripePost: post });

    const first = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-retry' }, deps);
    const second = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-retry' }, deps);

    expect(first).toEqual(second);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[1]).toEqual(post.mock.calls[1]?.[1]);
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2]);
  });

  it('records a Checkout creation failure without changing the fixed order or its quote snapshot', async () => {
    const post = vi.fn(async () => { throw new Error('private Stripe response'); });
    const deps = dependencies({ stripePost: post });

    await expect(createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-provider-failure' }, deps))
      .rejects.toMatchObject({ code: 'COMMERCE_ORDER_UNAVAILABLE' });

    expect(deps.repository.markCheckoutFailed).toHaveBeenCalledWith('701', NOW);
    expect(deps.repository.markCheckoutReady).not.toHaveBeenCalled();
  });

  it('keeps separate pending purchases independent instead of expiring an earlier order', async () => {
    const first = dependencies({ order: order() });
    const second = dependencies({ order: order({ orderId: '702', quoteId: '502', confirmationKeyDigest: 'c'.repeat(64), requestHash: 'd'.repeat(64) }) });

    const firstResult = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-first' }, first);
    const secondResult = await createOrderAndCheckout({ userId: '42', quoteId: '502', idempotencyKey: 'confirm-second' }, second);

    expect([firstResult.orderId, secondResult.orderId]).toEqual(['701', '702']);
    expect(first.stripe.post).toHaveBeenCalledTimes(1);
    expect(second.stripe.post).toHaveBeenCalledTimes(1);
    expect(first.stripe.post).not.toHaveBeenCalledWith(expect.stringMatching(/expire/u), expect.anything(), expect.anything());
    expect(second.stripe.post).not.toHaveBeenCalledWith(expect.stringMatching(/expire/u), expect.anything(), expect.anything());
  });

  it.each([
    ['wrong owner', 'COMMERCE_QUOTE_UNAVAILABLE'],
    ['expired quote', 'COMMERCE_QUOTE_EXPIRED'],
    ['changed pricing version', 'COMMERCE_PRICING_CHANGED'],
    ['same idempotency key with different hash', 'COMMERCE_IDEMPOTENCY_CONFLICT'],
  ])('does not contact Stripe for %s', async (_label, code) => {
    const reserveOrder = vi.fn(async () => { throw new CommerceOrderError(code as ConstructorParameters<typeof CommerceOrderError>[0]); });
    const deps = dependencies({ reserveOrder });

    await expect(createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-fail' }, deps)).rejects.toMatchObject({ code });
    expect(deps.ensureCustomer).not.toHaveBeenCalled();
    expect(deps.stripe.post).not.toHaveBeenCalled();
  });

  it('accepts a no-payment-required zero-value Session without inventing a PaymentIntent', async () => {
    const zeroOrder = order({
      items: [{ ...ITEM, stripeProductId: 'prod_slots', rawCents: '5000', tierCents: '5000', paidCents: '0' }],
      rawTotalCents: '5000', tierTotalCents: '5000', promoTotalCents: '0', paidTotalCents: '0',
      discountStrategy: 'promotion_code',
      promotion: { promotionCodeId: 'promo_free', couponId: 'coupon_free', subtotalCents: 5000, totalCents: 0, discountCents: 5000, currency: 'cny' },
    });
    const deps = dependencies({
      order: zeroOrder,
      stripePost: vi.fn(async () => ({ id: 'cs_test_free', url: null, expires_at: EXPIRY / 1000, status: 'complete', payment_status: 'no_payment_required', livemode: false })),
    });

    const result = await createOrderAndCheckout({ userId: '42', quoteId: '501', idempotencyKey: 'confirm-free' }, deps);

    expect(result).toMatchObject({ orderId: '701', checkoutUrl: null, paymentStatus: 'no_payment_required' });
    expect(deps.repository.markCheckoutReady).toHaveBeenCalledWith('701', expect.objectContaining({ sessionId: 'cs_test_free' }), NOW);
  });
});

class OrderDatabase implements MysqlDatabase {
  quoteRow: Record<string, unknown> | null = null;
  orderRow: Record<string, unknown> | null = null;
  readonly runCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly firstCalls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async all<T extends MysqlRow>(_sql: string, _values: readonly unknown[] = []): Promise<T[]> { return []; }
  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.firstCalls.push({ sql, values });
    if (sql.includes('SELECT id FROM auth_users')) return { id: '42' } as unknown as T;
    if (sql.includes('FROM commerce_quotes')) return this.quoteRow as T | null;
    if (sql.includes('FROM commerce_orders')) return this.orderRow as T | null;
    if (sql.includes('LAST_INSERT_ID')) return { id: '701' } as unknown as T;
    return null;
  }
  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.runCalls.push({ sql, values });
    return { affectedRows: 1, insertId: 701 };
  }
  transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> { return work(this); }
  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('commerce order repository', () => {
  function validQuoteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '501', user_id: '42', pricing_version: 'ke-commerce-test-v1', currency: 'CNY', request_hash: 'a'.repeat(64),
      input_snapshot: JSON.stringify({ selection: [{ type: 'slot_add', quantity: 1, termDays: 30 }] }),
      preview_snapshot: JSON.stringify({ items: [ITEM], accountPreview: quote().accountPreview }),
      raw_total_cents: '5000', tier_total_cents: '5000', promo_total_cents: null, selected_total_cents: '5000',
      discount_strategy: 'term', promotion_snapshot: null, created_at: NOW, expires_at: NOW + 120_000,
      ...overrides,
    };
  }

  it('rejects a quote owned by a different account', async () => {
    const database = new OrderDatabase();
    database.quoteRow = null;
    const repository = createOrderRepository(database);

    await expect(repository.reserveOrder({
      userId: '43', quoteId: '501', confirmationKeyDigest: 'b'.repeat(64),
      pricingVersion: 'ke-commerce-test-v1', stripeAccountId: 'acct_test', livemode: false,
      paymentMethodConfigurationId: 'pmc_ordinary', productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
      siteOrigin: 'https://ltsd.ro', now: NOW,
    })).rejects.toMatchObject({ code: 'COMMERCE_QUOTE_UNAVAILABLE' });
  });

  it('rejects expired quotes and pricing versions that changed after quote creation', async () => {
    for (const [quoteRow, version, code] of [
      [validQuoteRow({ expires_at: NOW }), 'ke-commerce-test-v1', 'COMMERCE_QUOTE_EXPIRED'],
      [validQuoteRow(), 'ke-commerce-test-v2', 'COMMERCE_PRICING_CHANGED'],
    ] as const) {
      const database = new OrderDatabase();
      database.quoteRow = quoteRow;
      const repository = createOrderRepository(database);
      await expect(repository.reserveOrder({
        userId: '42', quoteId: '501', confirmationKeyDigest: 'b'.repeat(64),
        pricingVersion: version, stripeAccountId: 'acct_test', livemode: false,
        paymentMethodConfigurationId: 'pmc_ordinary', productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
        siteOrigin: 'https://ltsd.ro', now: NOW,
      })).rejects.toMatchObject({ code });
      expect(database.runCalls).toHaveLength(0);
    }
  });

  it('persists quote line items, amount snapshots and idempotency digest in one owner-locked transaction', async () => {
    const database = new OrderDatabase();
    database.quoteRow = validQuoteRow();
    const repository = createOrderRepository(database);

    await repository.reserveOrder({
      userId: '42', quoteId: '501', confirmationKeyDigest: 'b'.repeat(64),
      pricingVersion: 'ke-commerce-test-v1', stripeAccountId: 'acct_test', livemode: false,
      paymentMethodConfigurationId: 'pmc_ordinary', productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
      siteOrigin: 'https://ltsd.ro', now: NOW,
    });

    expect(database.firstCalls.some((call) => call.sql.includes('FROM auth_users') && call.sql.includes('FOR UPDATE'))).toBe(true);
    expect(database.runCalls.some((call) => call.sql.includes('INSERT INTO commerce_orders') && call.values.includes('b'.repeat(64)))).toBe(true);
    expect(database.runCalls.some((call) => call.sql.includes('INSERT INTO commerce_order_items') && call.values.includes('5000'))).toBe(true);
    const orderInsert = database.runCalls.find((call) => call.sql.includes('INSERT INTO commerce_orders'))!;
    expect(JSON.parse(String(orderInsert.values[5]))).toMatchObject([{ stripeProductId: 'prod_slots' }]);
    expect(JSON.parse(String(orderInsert.values[13]))).toMatchObject({
      checkoutSiteOrigin: 'https://ltsd.ro', paymentMethodConfigurationId: 'pmc_ordinary',
    });
  });

  it('reuses an existing order only when the same user key carries the same quote hash', async () => {
    const database = new OrderDatabase();
    database.quoteRow = validQuoteRow();
    database.orderRow = {
      id: '701', user_id: '42', quote_id: '501', request_hash: 'a'.repeat(64), confirmation_idempotency_key: 'b'.repeat(64),
      pricing_version: 'ke-commerce-test-v1', currency: 'CNY', items_snapshot: JSON.stringify([{ ...ITEM, stripeProductId: 'prod_slots' }]),
      stripe_account_id: 'acct_test', stripe_livemode: 0,
      preview_snapshot: JSON.stringify({ accountPreview: quote().accountPreview, paymentMethodConfigurationId: 'pmc_ordinary', checkoutSiteOrigin: 'https://ltsd.ro' }),
      raw_total_cents: '5000', tier_total_cents: '5000', promo_total_cents: null, paid_total_cents: '5000',
      discount_strategy: 'term', promotion_snapshot: null, checkout_state: 'creating',
      stripe_checkout_session_id: null, checkout_expires_at: null, created_at: NOW,
    };
    const repository = createOrderRepository(database);
    const input = {
      userId: '42', quoteId: '501', confirmationKeyDigest: 'b'.repeat(64),
      pricingVersion: 'ke-commerce-test-v1', stripeAccountId: 'acct_test', livemode: false,
      paymentMethodConfigurationId: 'pmc_ordinary', productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
      siteOrigin: 'https://ltsd.ro', now: NOW,
    };

    await expect(repository.reserveOrder(input)).resolves.toMatchObject({ orderId: '701', requestHash: 'a'.repeat(64) });
    expect(database.runCalls).toHaveLength(0);

    database.orderRow = { ...database.orderRow, request_hash: 'e'.repeat(64) };
    await expect(repository.reserveOrder(input)).rejects.toMatchObject({ code: 'COMMERCE_IDEMPOTENCY_CONFLICT' });
  });
});

describe('commerce order confirmation route', () => {
  const ORIGIN = 'https://ltsd.example';
  const SESSION_TOKEN = 'A'.repeat(43);

  function profile(status: AuthSessionResponse['user']['status'] = 'ACTIVE', permissionLevel = 1): AuthSessionResponse['user'] {
    return {
      id: '42', email: 'player@example.test', display_name: 'Player', status,
      permission_level: permissionLevel, email_verified_at: status === 'ACTIVE' ? NOW - 1 : null,
      created_at: NOW - 1000, has_avatar: false, avatar_version: 0, avatar_url: '',
    };
  }

  async function setup(status: AuthSessionResponse['user']['status'] = 'ACTIVE', salesEnabled = true) {
    const sessionDigest = await digestToken(SESSION_TOKEN);
    const userProfile = profile(status);
    const identity: AuthIdentity & { expiresAt: number } = {
      userId: '42', status: userProfile.status, credentialVersion: 1, authVersion: 1,
      sessionDigest, expiresAt: NOW + 60_000,
    };
    const authConfig = {
      enabled: true, authSiteUrl: ORIGIN, csrfSecret: new Uint8Array(32).fill(2), rateSecret: new Uint8Array(32).fill(3),
      passwordKeys: new Map(), mailPayloadKeys: new Map(), currentPasswordKeyVersion: '1',
      currentMailPayloadKeyVersion: '1', mailDailyLimit: 100, mailMonthlyLimit: 1000, mailCloudflareMonthlyLimit: 1000,
    } as EnabledAuthConfig;
    const authRepository = {
      readIdentity: vi.fn(async () => identity),
      readProfile: vi.fn(async () => userProfile),
      readMailAvailability: vi.fn(async () => ({ code: 'AVAILABLE' as const, retry_at: null })),
      consumeAuthRateLimits: vi.fn(async () => ({ allowed: true, retryAfter: 60 })),
    } as unknown as AuthRepository;
    const orderDependencies = dependencies();
    const runtime: AuthRuntime = { now: () => NOW, fetch: globalThis.fetch };
    const csrf = await issueCsrf(new Request(`${ORIGIN}/`), authConfig, 'session', identity, () => NOW);
    const app = new Hono();
    registerCommerceOrderRoute(app, {
      setup: () => ({ authConfig, authRepository, orderDependencies, runtime, salesEnabled }),
    });
    return { app, csrfToken: csrf.token, authRepository, orderDependencies };
  }

  function headers(csrfToken?: string, origin = ORIGIN, idempotencyKey = 'confirm-route-key'): Headers {
    const result = new Headers({
      'content-type': 'application/json', origin,
      cookie: `__Host-ltsd-session=${SESSION_TOKEN}`,
      'idempotency-key': idempotencyKey,
    });
    if (csrfToken) result.set('x-csrf-token', csrfToken);
    return result;
  }

  async function post(app: Hono, csrfToken?: string, origin = ORIGIN, key = 'confirm-route-key'): Promise<Response> {
    return app.request(`${ORIGIN}/api/v1/commerce/orders`, {
      method: 'POST', headers: headers(csrfToken, origin, key), body: JSON.stringify({ quote_id: '501' }),
    });
  }

  it('requires a formal account, same-origin CSRF, and an idempotency key', async () => {
    const pending = await setup('PENDING_EMAIL');
    expect((await post(pending.app, pending.csrfToken)).status).toBe(403);

    const active = await setup();
    expect((await post(active.app)).status).toBe(403);
    expect((await post(active.app, active.csrfToken, 'https://attacker.example')).status).toBe(403);
    expect((await post(active.app, active.csrfToken, ORIGIN, '')).status).toBe(400);
    expect(active.orderDependencies.repository.reserveOrder).not.toHaveBeenCalled();
  });

  it('rejects new orders while sales are disabled before authenticating or reserving an order', async () => {
    const fixture = await setup('ACTIVE', false);
    const response = await post(fixture.app);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fixture.authRepository.readIdentity).not.toHaveBeenCalled();
    expect(fixture.orderDependencies.repository.reserveOrder).not.toHaveBeenCalled();
    expect(fixture.orderDependencies.stripe.post).not.toHaveBeenCalled();
  });

  it('returns only the fixed order result and applies a per-session rate limit', async () => {
    const fixture = await setup();
    const response = await post(fixture.app, fixture.csrfToken);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toEqual({
      orderId: '701', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_701',
      expiresAt: String(EXPIRY), paymentStatus: 'unpaid',
    });
    expect(body).not.toHaveProperty('stripeCheckoutSessionId');
    expect(JSON.stringify(body)).not.toContain('acct_test');
    expect(fixture.authRepository.consumeAuthRateLimits).toHaveBeenCalledTimes(1);
  });

  it('maps setup and order failures to fixed responses without leaking provider data', async () => {
    const unavailable = new Hono();
    registerCommerceOrderRoute(unavailable, { setup: () => { throw new Error('database host db.private'); } });
    const unavailableResponse = await unavailable.request(`${ORIGIN}/api/v1/commerce/orders`, { method: 'POST' });
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.text()).not.toContain('db.private');

    const fixture = await setup();
    vi.mocked(fixture.orderDependencies.repository.reserveOrder).mockRejectedValueOnce(
      new CommerceOrderError('COMMERCE_QUOTE_EXPIRED'),
    );
    const response = await post(fixture.app, fixture.csrfToken);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('database host');
  });
});
