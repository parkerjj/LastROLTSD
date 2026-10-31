import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { digestToken } from '../src/auth/crypto';
import type { AuthRepository } from '../src/auth/repository';
import type { AuthIdentity, AuthRuntime, AuthSessionResponse, EnabledAuthConfig } from '../src/auth/types';
import { createOrderRepository, type OrderDependencies, type OrderRepository } from '../src/commerce/orders';
import { registerCommerceOrderRoute } from '../src/commerce/router';
import type { StripeClient } from '../src/commerce/stripe-client';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://ltsd.example';
const SESSION_TOKEN = 'A'.repeat(43);
const ORDER_ITEM = {
  ordinal: 1,
  productKey: 'slots' as const,
  operation: 'ADD' as const,
  targetUnitId: null,
  targetEntitlementId: null,
  durationMs: '2592000000',
  expectedStartsAt: String(NOW),
  expectedExpiresAt: String(NOW + 2_592_000_000),
  rawCents: '5000',
  tierCents: '5000',
  paidCents: '5000',
  discountPercent: 100 as const,
  deliveryState: 'delivered' as const,
  deliveredAt: String(NOW + 1000),
  fulfillmentBefore: { startsAt: null, expiresAt: null },
  fulfillmentAfter: { startsAt: String(NOW + 1000), expiresAt: String(NOW + 2_592_001_000) },
  refundAdjustments: [{
    revision: 1,
    cumulativeRefundCents: '1000',
    retainedDurationMs: '2073600000',
    deductedDurationMs: '518400000',
    occurredAt: String(NOW + 2000),
    afterExpiresAt: String(NOW + 2_073_601_000),
  }],
};

const ORDER_VIEW = {
  orderId: '701',
  createdAt: String(NOW),
  currency: 'CNY' as const,
  pricingVersion: 'ke-commerce-test-v1',
  rawTotalCents: '5000',
  tierTotalCents: '5000',
  promoTotalCents: null,
  paidTotalCents: '5000',
  discountStrategy: 'term' as const,
  accountPreview: {
    before: { entitlements: [], effective: { slots: 0, modules: [] } },
    after: { entitlements: [], effective: { slots: 1, modules: [] } },
  },
  checkoutState: 'ready' as const,
  checkoutExpiresAt: String(NOW + 1_800_000),
  paymentState: 'paid',
  fulfillmentState: 'fulfilled',
  refundState: 'partial' as const,
  paidAt: String(NOW + 1000),
  fulfilledAt: String(NOW + 1000),
  refundedTotalCents: '1000',
  checkoutUrl: null,
  items: [ORDER_ITEM],
  refunds: [{
    status: 'succeeded' as const,
    amountCents: '1000',
    createdAt: String(NOW + 2000),
    cumulativeSuccessfulCents: '1000',
    cumulativeRatioBasisPoints: 2000,
  }],
};

function profile(status: AuthSessionResponse['user']['status'] = 'ACTIVE'): AuthSessionResponse['user'] {
  return {
    id: '42', email: 'player@example.test', display_name: 'Player', status,
    permission_level: 1, email_verified_at: NOW - 1, created_at: NOW - 1000,
    has_avatar: false, avatar_version: 0, avatar_url: '',
  };
}

async function setup(repositoryOverride?: OrderRepository) {
  const sessionDigest = await digestToken(SESSION_TOKEN);
  const userProfile = profile();
  const identity: AuthIdentity & { expiresAt: number } = {
    userId: '42', status: 'ACTIVE', credentialVersion: 1, authVersion: 1,
    sessionDigest, expiresAt: NOW + 60_000,
  };
  const authConfig = {
    enabled: true, mysqlUrl: 'mysql://test', authSiteUrl: ORIGIN, csrfSecret: new Uint8Array(32).fill(2), rateSecret: new Uint8Array(32).fill(3),
    passwordKeys: new Map(), mailPayloadKeys: new Map(), currentPasswordKeyVersion: '1',
    currentMailPayloadKeyVersion: '1', mailDailyLimit: 100, mailMonthlyLimit: 1000, mailCloudflareMonthlyLimit: 1000,
  } as EnabledAuthConfig;
  const authRepository = {
    readIdentity: vi.fn(async () => identity),
    readProfile: vi.fn(async () => userProfile),
    readMailAvailability: vi.fn(async () => ({ code: 'AVAILABLE' as const, retry_at: null })),
    consumeAuthRateLimits: vi.fn(async () => ({ allowed: true, retryAfter: 60 })),
  } as unknown as AuthRepository;
  const repository = repositoryOverride ?? {
    reserveOrder: vi.fn(),
    prepareCheckout: vi.fn(),
    markCheckoutReady: vi.fn(),
    markCheckoutFailed: vi.fn(),
    markCheckoutExpired: vi.fn(),
    readOrderHistory: vi.fn(async (userId: string, orderId: string) => userId === '42' && orderId === '701' ? {
      ...ORDER_VIEW,
      stripeCheckoutSessionId: 'cs_test_701', stripeAccountId: 'acct_test', livemode: false,
      paymentMethodConfigurationId: 'pmc_ordinary', siteOrigin: ORIGIN,
    } : null),
    listOrderHistory: vi.fn(async (userId: string, cursor: string | undefined) => ({
      items: userId === '42' && !cursor ? [{
        orderId: '701', createdAt: String(NOW), currency: 'CNY', paidTotalCents: '5000',
        paymentState: 'paid', fulfillmentState: 'fulfilled', refundState: 'partial',
        refundedTotalCents: '1000', itemCount: 1,
      }] : [],
      nextCursor: null,
    })),
  } as unknown as OrderRepository;
  const stripe = { post: vi.fn(), get: vi.fn() } as unknown as StripeClient;
  const orderDependencies = {
    repository, stripe, now: () => NOW, pricingVersion: 'ke-commerce-test-v1', stripeAccountId: 'acct_test',
    livemode: false, paymentMethodConfigurationId: 'pmc_ordinary', productIds: {},
    siteOrigin: ORIGIN, ensureCustomer: vi.fn(),
  } as OrderDependencies;
  const runtime: AuthRuntime = { now: () => NOW, fetch: globalThis.fetch };
  const app = new Hono();
  registerCommerceOrderRoute(app, {
    setup: () => ({ authConfig, authRepository, orderDependencies, runtime }),
  });
  const headers = new Headers({ cookie: `__Host-ltsd-session=${SESSION_TOKEN}` });
  return { app, headers, authRepository, repository, stripe };
}

class HistoryDatabase implements MysqlDatabase {
  readonly firstCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly allCalls: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(private readonly orderUserId = '42', private readonly paymentState = 'paid') {}

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.allCalls.push({ sql, values });
    if (sql.includes('FROM commerce_orders o')) return values[0] === '42' ? [{
      id: '701', created_at: NOW, currency: 'CNY', paid_total_cents: '5000',
      payment_state: this.paymentState, fulfillment_state: 'fulfilled', refund_state: 'partial',
      refunded_total_cents: '1000', item_count: 1,
    }] as unknown as T[] : [];
    if (sql.includes('FROM commerce_order_items')) return [{
      id: '801', ordinal: 1, delivery_state: 'delivered', delivered_at: NOW + 1000,
    }] as unknown as T[];
    if (sql.includes('FROM commerce_refunds')) return [{
      amount_cents: '1000', currency: 'CNY', status: 'succeeded', stripe_created_at: NOW + 2000, created_at: NOW + 2000,
    }] as unknown as T[];
    if (sql.includes('FROM commerce_unit_events')) return [
      {
        order_item_id: '801', event_type: 'PURCHASE', refund_revision: null,
        before_starts_at: null, before_expires_at: null,
        after_starts_at: NOW + 1000, after_expires_at: NOW + 2_592_001_000,
        occurred_at: NOW + 1000, delivered_at: NOW + 1000, duration_ms: '2592000000', detail_json: null,
      },
      {
        order_item_id: '801', event_type: 'REFUND_REPROJECT', refund_revision: 1,
        before_starts_at: NOW + 1000, before_expires_at: NOW + 2_592_001_000,
        after_starts_at: NOW + 1000, after_expires_at: NOW + 2_073_601_000,
        occurred_at: NOW + 2000, delivered_at: null, duration_ms: '-518400000',
        detail_json: JSON.stringify({ refundedTotalCents: '1000', retainedDurationMs: '2073600000' }),
      },
    ] as unknown as T[];
    return [];
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.firstCalls.push({ sql, values });
    if (!sql.includes('FROM commerce_orders') || values[0] !== '701' || values[1] !== this.orderUserId) return null;
    return {
      id: '701', user_id: this.orderUserId, quote_id: '501', request_hash: 'a'.repeat(64),
      confirmation_idempotency_key: 'b'.repeat(64), currency: 'CNY',
      pricing_version: 'ke-commerce-test-v1', raw_total_cents: '5000', tier_total_cents: '5000',
      promo_total_cents: null, paid_total_cents: '5000', discount_strategy: 'term',
      items_snapshot: JSON.stringify([{
        ordinal: 1, productKey: 'slots', operation: 'ADD', targetUnitId: null, targetEntitlementId: null,
        durationMs: '2592000000', expectedStartsAt: String(NOW), expectedExpiresAt: String(NOW + 2_592_000_000),
        discountPercent: 100, rawCents: '5000', tierCents: '5000', paidCents: '5000', stripeProductId: 'prod_slots',
      }]),
      preview_snapshot: JSON.stringify({
        accountPreview: ORDER_VIEW.accountPreview, paymentMethodConfigurationId: 'pmc_ordinary', checkoutSiteOrigin: ORIGIN,
      }),
      promotion_snapshot: null, checkout_state: 'ready', payment_state: this.paymentState,
      fulfillment_state: 'fulfilled', refund_state: 'partial', stripe_account_id: 'acct_test', stripe_livemode: 0,
      stripe_checkout_session_id: 'cs_test_701', checkout_expires_at: NOW + 1_800_000,
      paid_at: NOW + 1000, fulfilled_at: NOW + 1000, created_at: NOW,
    } as unknown as T;
  }

  async run(): Promise<MysqlWriteResult> { return { affectedRows: 0, insertId: 0 }; }
  transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> { return work(this); }
  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

class OrderListDatabase extends HistoryDatabase {
  override async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    if (!sql.includes('FROM commerce_orders o')) return super.all<T>(sql, values);
    this.allCalls.push({ sql, values });
    const rows = [
      { id: '702', created_at: NOW + 1, currency: 'CNY', paid_total_cents: '5000', payment_state: 'paid', fulfillment_state: 'fulfilled', refund_state: 'none', refunded_total_cents: '0', item_count: 1 },
      { id: '701', created_at: NOW, currency: 'CNY', paid_total_cents: '5000', payment_state: 'paid', fulfillment_state: 'fulfilled', refund_state: 'none', refunded_total_cents: '0', item_count: 1 },
    ];
    return (values.length === 2 ? rows : rows.slice(1)) as unknown as T[];
  }
}

describe('commerce order history and return status', () => {
  it('reads a failed payment state consistently in order detail and history', async () => {
    const repository = createOrderRepository(new HistoryDatabase('42', 'failed'));

    const detail = await repository.readOrderHistory('42', '701');
    const history = await repository.listOrderHistory('42', undefined, 20);

    expect(detail?.paymentState).toBe('failed');
    expect(history.items[0]?.paymentState).toBe('failed');
  });

  it('lists only the signed-in user orders in a private response without requiring write CSRF', async () => {
    const fixture = await setup();
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders`, { headers: fixture.headers });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      items: [{
        orderId: '701', createdAt: String(NOW), currency: 'CNY', paidTotalCents: '5000',
        paymentState: 'paid', fulfillmentState: 'fulfilled', refundState: 'partial',
        refundedTotalCents: '1000', itemCount: 1,
      }],
      nextCursor: null,
    });
    expect(fixture.repository.listOrderHistory).toHaveBeenCalledWith('42', undefined, 20);
  });

  it('returns the immutable order snapshot, actual fulfillment, refund ratio, and per-item deduction', async () => {
    const fixture = await setup();
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders/701`, { headers: fixture.headers });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      orderId: '701', paymentState: 'paid', fulfillmentState: 'fulfilled', refundState: 'partial',
      items: [{
        durationMs: '2592000000', paidCents: '5000',
        fulfillmentBefore: { startsAt: null, expiresAt: null },
        fulfillmentAfter: { startsAt: String(NOW + 1000), expiresAt: String(NOW + 2_592_001_000) },
        refundAdjustments: [{ cumulativeRefundCents: '1000', deductedDurationMs: '518400000' }],
      }],
      refunds: [{ cumulativeSuccessfulCents: '1000', cumulativeRatioBasisPoints: 2000 }],
    });
    expect(fixture.repository.readOrderHistory).toHaveBeenCalledWith('42', '701');
    expect(JSON.stringify(body)).not.toContain('stripeCheckoutSessionId');
  });

  it('uses status-only reads for polling without contacting Stripe', async () => {
    const pendingView = {
      ...ORDER_VIEW,
      paymentState: 'unpaid' as const,
      fulfillmentState: 'pending' as const,
      paidAt: null,
      fulfilledAt: null,
      checkoutUrl: null,
    };
    const fixture = await setup();
    vi.mocked(fixture.repository.readOrderHistory).mockResolvedValue({
      ...pendingView,
      stripeCheckoutSessionId: 'cs_test_701', stripeAccountId: 'acct_test', livemode: false,
      paymentMethodConfigurationId: 'pmc_ordinary', siteOrigin: ORIGIN,
    });
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders/701?status_only=1`, { headers: fixture.headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paymentState: 'unpaid', checkoutUrl: null });
    expect(fixture.stripe.get).not.toHaveBeenCalled();
  });

  it('uses the same not-found response for another users order', async () => {
    const fixture = await setup();
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders/999`, { headers: fixture.headers });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('player@example.test');
    expect(fixture.repository.readOrderHistory).toHaveBeenCalledWith('42', '999');
  });

  it('rejects malformed cursors before querying order history', async () => {
    const fixture = await setup();
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders?cursor=not-a-cursor`, { headers: fixture.headers });

    expect(response.status).toBe(400);
    expect(fixture.repository.listOrderHistory).not.toHaveBeenCalled();
  });

  it('paginates history by created_at and id without exposing another users rows', async () => {
    const database = new OrderListDatabase();
    const repository = createOrderRepository(database);
    const firstPage = await repository.listOrderHistory('42', undefined, 1);
    const secondPage = await repository.listOrderHistory('42', firstPage.nextCursor ?? undefined, 1);

    expect(firstPage.items.map((row) => row.orderId)).toEqual(['702']);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(secondPage.items.map((row) => row.orderId)).toEqual(['701']);
    expect(secondPage.nextCursor).toBeNull();
    expect(database.allCalls[1]?.sql).toContain('o.created_at < ? OR (o.created_at = ? AND o.id < ?)');
    expect(database.allCalls[1]?.values).toEqual(['42', String(NOW + 1), String(NOW + 1), '702', 2]);
  });

  it('reads order details with owner-scoped SQL and persisted refund projection events', async () => {
    const database = new HistoryDatabase();
    const fixture = await setup(createOrderRepository(database));
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders/701`, { headers: fixture.headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{
        durationMs: '2592000000',
        fulfillmentBefore: { startsAt: null, expiresAt: null },
        refundAdjustments: [{ cumulativeRefundCents: '1000', deductedDurationMs: '518400000' }],
      }],
      refunds: [{ cumulativeSuccessfulCents: '1000', cumulativeRatioBasisPoints: 2000 }],
    });
    expect(database.firstCalls[0]?.sql).toContain('user_id = ?');
    expect(database.firstCalls[0]?.values).toEqual(['701', '42']);
  });

  it('does not return an order row owned by another database user', async () => {
    const database = new HistoryDatabase('99');
    const fixture = await setup(createOrderRepository(database));
    const response = await fixture.app.request(`${ORIGIN}/api/v1/commerce/orders/701`, { headers: fixture.headers });

    expect(response.status).toBe(404);
    expect(database.firstCalls[0]?.values).toEqual(['701', '42']);
  });
});
