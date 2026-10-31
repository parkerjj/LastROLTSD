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
  refund_revision: '0',
  applied_refund_revision: '0',
  refund_snapshot_hash: null,
  stripe_checkout_session_id: 'cs_test_701',
  stripe_payment_intent_id: null,
  stripe_charge_id: null as string | null,
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
  refunds: MysqlRow[] = [];
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
          if (sql.includes('FROM commerce_refunds')) return this.refunds as unknown as R[];
          if (sql.includes('FROM commerce_unit_events')) return this.unitEvents as R[];
          return [] as R[];
        },
        first: async <R extends MysqlRow = MysqlRow>(sql: string) => {
          if (sql.includes('FROM commerce_orders')) return this.order as unknown as R;
          if (sql.includes('FROM commerce_refunds') && sql.includes('SUM(amount_cents)')) {
            const refunded = this.refunds.reduce((sum, refund) => sum + Number(refund.amount_cents), 0);
            return { refunded_cents: String(refunded) } as unknown as R;
          }
          if (sql.includes('FROM commerce_refunds') && sql.includes('stripe_refund_id')) return null;
          if (sql.includes("FROM commerce_unit_events") && sql.includes("event_type = 'PURCHASE'")) {
            return { unit_id: '900' } as unknown as R;
          }
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
          if (sql.includes('INSERT INTO ke_entitlements')) {
            this.entitlementExpiry = Number(values[4]);
            return { affectedRows: 1, insertId: 901 };
          }
          if (sql.includes('INSERT INTO commerce_unit_events')) {
            if (sql.includes("'PURCHASE'")) {
              this.unitEvents.push({
                unit_seq: values[1], event_type: 'PURCHASE', order_item_id: values[2], occurred_at: values[7],
                delivered_at: values[8], duration_ms: values[9], dedupe_key: values[10], detail_json: values[11],
              });
            } else {
              this.unitEvents.push({
                unit_seq: values[1], event_type: 'REFUND_REPROJECT', order_item_id: values[2],
                refund_revision: values[3], occurred_at: values[9], duration_ms: values[10],
                dedupe_key: values[11], detail_json: values[12],
              });
            }
          }
          if (sql.includes('UPDATE ke_entitlements SET starts_at')) this.entitlementExpiry = Number(values[1]);
          if (sql.includes('INSERT INTO commerce_refunds')) {
            this.refunds.push({
              order_id: values[0], stripe_account_id: values[1], stripe_livemode: values[2],
              stripe_refund_id: values[3], amount_cents: values[4], currency: 'CNY', status: values[5],
              stripe_created_at: values[6],
            });
          }
          if (sql.includes('UPDATE commerce_order_items SET delivery_state')) {
            const itemId = String(values[1]);
            this.items = this.items.map((item) => item.id === itemId ? { ...item, delivery_state: 'delivered' } : item);
          }
          if (sql.includes("UPDATE commerce_orders SET payment_state = 'paid'")) this.order = { ...this.order, payment_state: 'paid', fulfillment_state: 'fulfilled' };
          if (sql.includes("UPDATE commerce_orders SET payment_state = 'failed'")) this.order = { ...this.order, payment_state: 'failed' };
          if (sql.includes('stripe_charge_id = COALESCE')) {
            this.order = { ...this.order, stripe_charge_id: values[1] === null ? this.order.stripe_charge_id : String(values[1]) };
          }
          if (sql.includes('refund_sync_generation =')) {
            this.order = {
              ...this.order,
              stripe_payment_intent_id: String(values[0]),
              refund_sync_generation: String(values[1]),
            };
          }
          if (sql.includes('SET refund_snapshot_hash =')) {
            this.order = {
              ...this.order,
              refund_snapshot_hash: String(values[0]),
              refund_revision: String(values[1]),
              applied_refund_revision: String(values[2]),
              refund_state: values[3],
            };
          }
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
  refunds?: Array<Record<string, unknown>>;
} = {}) {
  const repository = options.repository ?? new FulfillmentRepository();
  const stripe = {
    get: vi.fn(async (path: string) => path.startsWith('/checkout/sessions/')
      ? stripeSession(options.session)
      : path.startsWith('/payment_intents/')
        ? stripeIntent(options.intent)
        : { object: 'list', data: options.refunds ?? [], has_more: false }),
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

  it('records a confirmed asynchronous Checkout failure without granting entitlements', async () => {
    const repository = new FulfillmentRepository();
    const deps = dependencies({ repository, session: stripeSession({ payment_status: 'unpaid' }) });

    const result = await reconcilePaidOrder('701', deps, 'checkout.session.async_payment_failed');

    expect(result).toMatchObject({ status: 'failed' });
    expect(repository.order.payment_state).toBe('failed');
    expect(repository.writes.some(({ sql }) => sql.includes("SET payment_state = 'failed'"))).toBe(true);
    expect(repository.writes.some(({ sql }) => sql.includes('ke_entitlements'))).toBe(false);
  });

  it('treats an already recorded asynchronous failure as terminal while Checkout remains unpaid', async () => {
    const repository = new FulfillmentRepository();
    repository.order = { ...repository.order, payment_state: 'failed' };

    const result = await reconcilePaidOrder('701', dependencies({
      repository, session: stripeSession({ payment_status: 'unpaid' }),
    }));

    expect(result).toMatchObject({ status: 'failed' });
    expect(repository.writes.some(({ sql }) => sql.includes('ke_entitlements'))).toBe(false);
  });

  it('fulfills a delayed payment that succeeds after an earlier failure event', async () => {
    const repository = new FulfillmentRepository();
    repository.order = { ...repository.order, payment_state: 'failed' };

    const result = await reconcilePaidOrder('701', dependencies({ repository }));

    expect(result).toMatchObject({ status: 'fulfilled' });
    expect(repository.order.payment_state).toBe('paid');
    expect(repository.items[0]?.delivery_state).toBe('delivered');
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

  it('persists the Stripe payment charge ID, including Alipay py_ IDs, for refund event matching', async () => {
    const repository = new FulfillmentRepository();

    await reconcilePaidOrder('701', dependencies({ repository, intent: stripeIntent({ latest_charge: 'py_test_701' }) }));

    expect(repository.order.stripe_charge_id).toBe('py_test_701');
    expect(repository.writes.some(({ sql, values }) => sql.includes('stripe_charge_id = COALESCE')
      && values[1] === 'py_test_701')).toBe(true);
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

  it('applies an already-successful refund before first delivery', async () => {
    const repository = new FulfillmentRepository();
    repository.order = { ...repository.order, paid_total_cents: '5000' };
    const deps = dependencies({
      repository,
      refunds: [{
        id: 're_test_701', object: 'refund', amount: 2500, currency: 'cny', status: 'succeeded',
        created: Math.floor(NOW / 1000), payment_intent: 'pi_test_701', charge: 'ch_test_701',
      }],
    });

    await reconcilePaidOrder('701', deps);

    expect(repository.entitlementExpiry).toBe(NOW + DURATION_MS / 2);
    expect(repository.writes.some(({ sql }) => sql.includes("'REFUND_REPROJECT'"))).toBe(true);
    expect(repository.items[0]?.delivery_state).toBe('delivered');
  });

  it('retries and concurrent duplicate events do not deliver a paid order twice', async () => {
    const repository = new FulfillmentRepository();
    const deps = dependencies({ repository });

    await Promise.all([reconcilePaidOrder('701', deps), reconcilePaidOrder('701', deps)]);
    const entitlementWritesAfterFirstDelivery = repository.writes.filter(({ sql }) => sql.includes('INSERT INTO ke_entitlements')).length;
    const purchaseEventsAfterFirstDelivery = repository.writes.filter(({ sql }) => sql.includes("'PURCHASE'")).length;
    const expiryAfterFirstDelivery = repository.entitlementExpiry;
    const result = await reconcilePaidOrder('701', deps);

    expect(result).toMatchObject({ status: 'fulfilled', orderId: '701' });
    expect(repository.writes.filter(({ sql }) => sql.includes('INSERT INTO ke_entitlements'))).toHaveLength(entitlementWritesAfterFirstDelivery);
    expect(repository.writes.filter(({ sql }) => sql.includes("'PURCHASE'"))).toHaveLength(purchaseEventsAfterFirstDelivery);
    expect(repository.writes.filter(({ sql }) => sql.includes('INSERT INTO commerce_unit_events'))).toHaveLength(1);
    expect(repository.entitlementExpiry).toBe(expiryAfterFirstDelivery);
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
