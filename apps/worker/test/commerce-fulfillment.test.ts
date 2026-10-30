import { describe, expect, it, vi } from 'vitest';
import { reconcilePaidOrder } from '../src/commerce/fulfillment';
import type { CommerceRepository, CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import type { StripeClient } from '../src/commerce/stripe-client';

const DAY_MS = 86_400_000;
const DURATION_MS = 30 * DAY_MS;
const NOW = 1_800_000_000_000;

const ORDER_ROW = {
  id: '701',
  user_id: '42',
  stripe_account_id: 'acct_test',
  stripe_livemode: 0,
  currency: 'CNY',
  paid_total_cents: '5000',
  checkout_state: 'ready',
  payment_state: 'unpaid',
  fulfillment_state: 'pending',
  stripe_checkout_session_id: 'cs_test_701',
  stripe_payment_intent_id: null,
  stripe_charge_id: null,
};

const ADD_ITEM = {
  id: '801',
  order_id: '701',
  ordinal: 1,
  product_key: 'slots',
  resource: 'slots',
  operation: 'ADD',
  target_unit_id: null,
  target_entitlement_id: null,
  duration_ms: String(DURATION_MS),
  delivery_state: 'pending',
};

function stripeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_701',
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    mode: 'payment',
    livemode: false,
    client_reference_id: '701',
    metadata: { ltsd_commerce_order_id: '701' },
    amount_total: 5000,
    currency: 'cny',
    payment_intent: 'pi_test_701',
    ...overrides,
  };
}

function stripeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_test_701',
    object: 'payment_intent',
    status: 'succeeded',
    livemode: false,
    amount: 5000,
    amount_received: 5000,
    currency: 'cny',
    metadata: { ltsd_commerce_order_id: '701' },
    ...overrides,
  };
}

class FulfillmentRepository implements CommerceRepository {
  order = { ...ORDER_ROW };
  items = [{ ...ADD_ITEM }];
  unitEvents: MysqlRow[] = [];
  writes: Array<{ sql: string; values: readonly unknown[] }> = [];
  entitlementExpiry: number | null = null;
  committedTransactions = 0;
  rollbacks = 0;
  nextInsertId = 900;
  unitEntitlementId: string | null = '901';
  private transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(work: (tx: CommerceTransaction) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = (): void => {};
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const tx: CommerceTransaction = {
        lockUser: async (userId) => userId === '42',
        all: async <R extends MysqlRow = MysqlRow>(sql: string) => {
          if (sql.includes('FROM commerce_order_items')) return this.items.filter((item) => item.delivery_state === 'pending') as unknown as R[];
          if (sql.includes('FROM commerce_unit_events')) return this.unitEvents as R[];
          return [] as R[];
        },
        first: async <R extends MysqlRow = MysqlRow>(sql: string) => {
          if (sql.includes('FROM commerce_orders')) return this.order as unknown as R;
          if (sql.includes('SELECT CAST(LAST_INSERT_ID() AS CHAR)')) {
            const id = String(this.nextInsertId);
            this.nextInsertId += 1;
            return { id } as unknown as R;
          }
          if (sql.includes('FROM commerce_units')) {
            return {
              id: '900', user_id: '42', resource: 'slots', unit_kind: 'commerce',
              ke_entitlement_id: this.unitEntitlementId, baseline_source: null, baseline_source_ref: null,
              baseline_quantity: 1, baseline_starts_at: null, baseline_expires_at: null,
              legacy_origin_id: null, legacy_ordinal: null, admin_revoked_at: null, refund_zeroed_at: null,
            } as unknown as R;
          }
          return null;
        },
        run: async (sql, values = []) => {
          this.writes.push({ sql, values });
          if (sql.includes('INSERT INTO commerce_units')) {
            this.unitEntitlementId = values[3] === null ? null : String(values[3]);
            return { affectedRows: 1, insertId: 900 };
          }
          if (sql.includes('INSERT INTO ke_entitlements')) return { affectedRows: 1, insertId: 901 };
          if (sql.includes('INSERT INTO commerce_unit_events')) {
            this.unitEvents.push({ unit_seq: values[1], event_type: values[2], order_item_id: values[3], delivered_at: values[7], duration_ms: values[8], dedupe_key: values[9] });
          }
          if (sql.includes('UPDATE ke_entitlements SET starts_at')) this.entitlementExpiry = Number(values[1]);
          if (sql.includes('UPDATE commerce_order_items SET delivery_state')) {
            const itemId = String(values[1]);
            this.items = this.items.map((item) => item.id === itemId ? { ...item, delivery_state: 'delivered' } : item);
          }
          if (sql.includes("UPDATE commerce_orders SET payment_state = 'paid'")) this.order = { ...this.order, payment_state: 'paid', fulfillment_state: 'fulfilled' };
          return { affectedRows: 1, insertId: 1 } as MysqlWriteResult;
        },
      };
      const result = await work(tx);
      this.committedTransactions += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    } finally {
      release();
    }
  }
}

function dependencies(options: {
  repository?: FulfillmentRepository;
  session?: Record<string, unknown>;
  intent?: Record<string, unknown>;
} = {}) {
  const repository = options.repository ?? new FulfillmentRepository();
  const stripe = {
    get: vi.fn(async (path: string) => path.startsWith('/checkout/sessions/')
      ? stripeSession(options.session)
      : stripeIntent(options.intent)),
    post: vi.fn(),
  } as unknown as StripeClient;
  return {
    repository,
    stripe,
    stripeAccountId: 'acct_test',
    livemode: false,
    now: () => NOW,
  };
}

describe('paid commerce order fulfillment', () => {
  it('does not grant entitlements for a completed but unpaid Checkout Session', async () => {
    const repository = new FulfillmentRepository();
    const deps = dependencies({ repository, session: stripeSession({ payment_status: 'unpaid' }) });

    const result = await reconcilePaidOrder('701', deps);

    expect(result).toMatchObject({ status: 'pending' });
    expect(repository.writes.some(({ sql }) => sql.includes('ke_entitlements'))).toBe(false);
    expect(deps.stripe.get).toHaveBeenCalledTimes(1);
  });

  it('does not grant when Checkout is expired or the PaymentIntent has not succeeded', async () => {
    for (const options of [
      { session: stripeSession({ status: 'expired', payment_status: 'unpaid' }) },
      { intent: stripeIntent({ status: 'processing', amount_received: 0 }) },
      { intent: stripeIntent({ amount_received: 4999 }) },
    ]) {
      const repository = new FulfillmentRepository();
      await reconcilePaidOrder('701', dependencies({ repository, ...options }));
      expect(repository.writes.some(({ sql }) => sql.includes('ke_entitlements')), JSON.stringify(options)).toBe(false);
    }
  });

  it('delivers a new slot from the actual reconciliation time and records the full purchased duration', async () => {
    const repository = new FulfillmentRepository();

    const result = await reconcilePaidOrder('701', dependencies({ repository }));

    expect(result).toMatchObject({ status: 'fulfilled', orderId: '701' });
    const purchase = repository.writes.find(({ sql }) => sql.includes('INSERT INTO commerce_unit_events'));
    expect(purchase?.values).toContain(NOW);
    expect(purchase?.values).toContain(BigInt(DURATION_MS));
    expect(purchase?.values).toContain('order-item:801');
    expect(repository.writes.some(({ sql }) => sql.includes('INSERT INTO ke_entitlements'))).toBe(true);
    expect(repository.items[0]?.delivery_state).toBe('delivered');
  });

  it('grants a zero-cost order only for a completed no-payment-required Session', async () => {
    const repository = new FulfillmentRepository();
    repository.order = { ...repository.order, paid_total_cents: '0' };
    const deps = dependencies({
      repository,
      session: stripeSession({ payment_status: 'no_payment_required', amount_total: 0, payment_intent: null }),
    });

    const result = await reconcilePaidOrder('701', deps);

    expect(result.status).toBe('fulfilled');
    expect(repository.writes.some(({ sql }) => sql.includes('INSERT INTO commerce_unit_events'))).toBe(true);
  });

  it('retries and concurrent duplicate events do not deliver a paid order twice', async () => {
    const repository = new FulfillmentRepository();
    const deps = dependencies({ repository });

    await Promise.all([reconcilePaidOrder('701', deps), reconcilePaidOrder('701', deps)]);
    const writesAfterFirstDelivery = repository.writes.length;
    const result = await reconcilePaidOrder('701', deps);

    expect(result).toMatchObject({ status: 'fulfilled', orderId: '701' });
    expect(repository.writes).toHaveLength(writesAfterFirstDelivery);
    expect(repository.writes.filter(({ sql }) => sql.includes('INSERT INTO commerce_unit_events'))).toHaveLength(1);
  });

  it('extends an existing target by the complete purchased duration after the latest end', async () => {
    const repository = new FulfillmentRepository();
    const previousEnd = NOW + 10 * DAY_MS;
    repository.items = [{
      ...ADD_ITEM,
      product_key: 'slots',
      operation: 'RENEW',
      target_unit_id: '900',
    }];
    repository.unitEvents = [{
      unit_seq: 1, event_type: 'PURCHASE', occurred_at: NOW - 20 * DAY_MS,
      delivered_at: NOW - 20 * DAY_MS, duration_ms: DURATION_MS,
      retained_duration_ms: DURATION_MS,
    }];
    repository.writes = [];
    repository.nextInsertId = 902;
    const deps = dependencies({ repository });

    await reconcilePaidOrder('701', deps);

    const updatedEntitlement = repository.writes.find(({ sql }) => sql.includes('UPDATE ke_entitlements SET starts_at'));
    expect(updatedEntitlement?.values[1]).toBe(previousEnd + DURATION_MS);
    expect(repository.writes.some(({ sql }) => sql.includes('INSERT INTO ke_entitlements'))).toBe(false);
  });

  it('rejects a Stripe Session whose order ID or livemode does not match the immutable order', async () => {
    const repository = new FulfillmentRepository();
    const deps = dependencies({
      repository,
      session: stripeSession({ client_reference_id: '702', metadata: { ltsd_commerce_order_id: '702' } }),
    });

    await expect(reconcilePaidOrder('701', deps)).rejects.toThrow();

    expect(repository.writes).toHaveLength(0);
  });
});
