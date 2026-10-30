import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { receiveStripeEvent } from '../src/commerce/webhook';
import { registerCommerceWebhookRoute } from '../src/commerce/router';
import type { CommerceRepository, CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow } from '../src/db/mysql-client';

const NOW = 1_800_000_000_000;
const SECRET_BYTES = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
const SIGNING_SECRET = 'whsec_' + btoa(String.fromCharCode(...SECRET_BYTES));
const CLI_SIGNING_SECRET = `whsec_${'a'.repeat(64)}`;

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_test_701',
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: 'cs_test_701',
        object: 'checkout.session',
        mode: 'payment',
        client_reference_id: '701',
        metadata: { ltsd_commerce_order_id: '701' },
      },
    },
    ...overrides,
  });
}

function refundEvent(type: string, id = 'evt_' + type.replaceAll('.', '_') + '_701', overrides: Record<string, unknown> = {}): string {
  const chargeEvent = type === 'charge.refunded';
  return event({
    id,
    type,
    data: {
      object: chargeEvent
        ? { id: 'ch_test_701', object: 'charge', payment_intent: 'pi_test_701' }
        : {
          id: 're_test_701', object: 'refund', payment_intent: 'pi_test_701', charge: 'ch_test_701',
          amount: 500, currency: 'cny', status: 'succeeded', created: 1_800_000_000,
        },
    },
    ...overrides,
  });
}

async function signedRequest(body: string, timestamp = Math.floor(NOW / 1000)): Promise<Request> {
  return signedRequestWithSecret(body, SIGNING_SECRET, timestamp);
}

async function signedRequestWithSecret(body: string, secret: string, timestamp = Math.floor(NOW / 1000)): Promise<Request> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new TextEncoder().encode(timestamp + '.' + body);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://ltsd.example/api/v1/commerce/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=' + timestamp + ',v1=' + signature, 'content-type': 'application/json' },
    body,
  });
}

class WebhookRepository implements CommerceRepository {
  readonly eventIds = new Set<string>();
  readonly payloadHashes = new Map<string, string>();
  readonly eventOrderIds = new Map<string, string | null>();
  readonly eventStates = new Map<string, string>();
  jobWrites = 0;
  jobState = 'queued';
  jobGeneration = 0;
  reconcileCalls = 0;
  reconcileEventTypes: string[] = [];
  failReconciliation = false;
  transactionCalls = 0;
  failWrites = false;
  failJobWrites = false;
  stripeCheckoutSessionId: string | null = 'cs_test_701';
  refundOrders: Array<{ id: string; stripe_payment_intent_id: string | null; stripe_charge_id: string | null }> = [
    { id: '701', stripe_payment_intent_id: 'pi_test_701', stripe_charge_id: 'ch_test_701' },
  ];

  async transaction<T>(work: (tx: CommerceTransaction) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const priorEventIds = new Set(this.eventIds);
    const priorPayloadHashes = new Map(this.payloadHashes);
    const priorEventOrderIds = new Map(this.eventOrderIds);
    const priorEventStates = new Map(this.eventStates);
    const priorJobWrites = this.jobWrites;
    const priorJobState = this.jobState;
    const priorJobGeneration = this.jobGeneration;
    const priorSessionId = this.stripeCheckoutSessionId;
    const tx: CommerceTransaction = {
      lockUser: async () => true,
      all: async <R extends MysqlRow = MysqlRow>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('FROM commerce_orders') && sql.includes('stripe_payment_intent_id')) {
          const references = new Set(values.slice(2).map(String));
          return this.refundOrders.filter((order) =>
            (order.stripe_payment_intent_id !== null && references.has(order.stripe_payment_intent_id))
            || (order.stripe_charge_id !== null && references.has(order.stripe_charge_id))) as unknown as R[];
        }
        return [] as R[];
      },
      first: async <R extends MysqlRow = MysqlRow>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('FROM commerce_provider_events')) {
          const eventId = String(values[2]);
          const hash = this.payloadHashes.get(eventId);
          return hash ? {
            payload_sha256: hash,
            order_id: this.eventOrderIds.get(eventId),
            state: this.eventStates.get(eventId),
          } as unknown as R : null;
        }
        if (sql.includes('FROM commerce_orders')) {
          const id = String(values[0]);
          const refundOrder = this.refundOrders.find((order) => order.id === id);
          if (refundOrder) return {
            id: '701', stripe_account_id: 'acct_test', stripe_livemode: 0,
            stripe_checkout_session_id: this.stripeCheckoutSessionId,
            stripe_payment_intent_id: refundOrder.stripe_payment_intent_id,
            stripe_charge_id: refundOrder.stripe_charge_id,
          } as unknown as R;
        }
        if (sql.includes('FROM commerce_jobs')) return { dirty_generation: String(this.jobGeneration) } as unknown as R;
        return null;
      },
      run: async (sql: string, values: readonly unknown[] = []) => {
        if (this.failWrites) throw new Error('database unavailable');
        if (sql.includes('INSERT INTO commerce_provider_events')) {
          const eventId = String(values[2]);
          if (this.eventIds.has(eventId)) return { affectedRows: 0, insertId: 0 };
          this.eventIds.add(eventId);
          this.payloadHashes.set(eventId, String(values[6]));
          this.eventOrderIds.set(eventId, values[5] === null ? null : String(values[5]));
          this.eventStates.set(eventId, String(values[7]));
          return { affectedRows: 1, insertId: 1 };
        }
        if (sql.includes('INSERT INTO commerce_jobs')) {
          if (this.failJobWrites) throw new Error('job persistence unavailable');
          this.jobWrites += 1;
          this.jobGeneration += 1;
          this.jobState = 'queued';
        }
        if (sql.includes('UPDATE commerce_provider_events SET state')) {
          const eventId = String(values.at(-1));
          if (this.eventStates.get(eventId) === 'queued') this.eventStates.set(eventId, 'processed');
        }
        if (sql.includes('UPDATE commerce_jobs SET processed_generation')
          && this.jobState === 'queued' && String(values[0]) === String(this.jobGeneration)) this.jobState = 'done';
        if (sql.includes('UPDATE commerce_orders SET stripe_checkout_session_id')) {
          this.stripeCheckoutSessionId = String(values[0]);
        }
        return { affectedRows: 1, insertId: 1 };
      },
    };
    try {
      return await work(tx);
    } catch (error) {
      this.eventIds.clear();
      for (const id of priorEventIds) this.eventIds.add(id);
      this.payloadHashes.clear();
      for (const [id, hash] of priorPayloadHashes) this.payloadHashes.set(id, hash);
      this.eventOrderIds.clear();
      for (const [id, orderId] of priorEventOrderIds) this.eventOrderIds.set(id, orderId);
      this.eventStates.clear();
      for (const [id, state] of priorEventStates) this.eventStates.set(id, state);
      this.jobWrites = priorJobWrites;
      this.jobState = priorJobState;
      this.jobGeneration = priorJobGeneration;
      this.stripeCheckoutSessionId = priorSessionId;
      throw error;
    }
  }
}

function dependencies(repository = new WebhookRepository(), reconcileStatus: 'fulfilled' | 'pending' = 'fulfilled') {
  return {
    repository,
    signingSecret: SIGNING_SECRET,
    stripeAccountId: 'acct_test',
    livemode: false,
    now: () => NOW,
    resolveRefundOrderIdFromPaymentIntent: async () => null,
    reconcileOrder: async (orderId: string, eventType: string) => {
      repository.reconcileCalls += 1;
      repository.reconcileEventTypes.push(eventType);
      if (repository.failReconciliation) throw new Error('fulfillment unavailable');
      return { orderId, status: reconcileStatus };
    },
  };
}

describe('Stripe commerce webhook inbox', () => {
  it('verifies the raw signing secret format emitted by Stripe CLI', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequestWithSecret(event({ id: 'evt_test_cli_702' }), CLI_SIGNING_SECRET);
    const deps = { ...dependencies(repository), signingSecret: CLI_SIGNING_SECRET };

    const response = await receiveStripeEvent(request, deps);

    expect(response.status).toBe(200);
    expect(repository.eventIds.has('evt_test_cli_702')).toBe(true);
  });

  it('rejects a signature that does not match the untouched request body', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequest(event());
    const badRequest = new Request(request, {
      headers: { 'stripe-signature': 't=1800000000,v1=00' },
    });

    const response = await receiveStripeEvent(badRequest, dependencies(repository));

    expect(response.status).toBe(400);
    expect(repository.transactionCalls).toBe(0);
  });

  it('rejects a correctly signed event outside the timestamp tolerance', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequest(event(), Math.floor(NOW / 1000) - 301);

    const response = await receiveStripeEvent(request, dependencies(repository));

    expect(response.status).toBe(400);
    expect(repository.transactionCalls).toBe(0);
  });

  it('reconciles the order before acknowledging, then deduplicates processed retries', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequest(event());

    const first = await receiveStripeEvent(request.clone(), dependencies(repository));
    const retry = await receiveStripeEvent(request.clone(), dependencies(repository));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(repository.eventIds).toEqual(new Set(['evt_test_701']));
    expect(repository.jobWrites).toBe(1);
    expect(repository.reconcileCalls).toBe(1);
    expect(repository.eventStates.get('evt_test_701')).toBe('processed');
    expect(repository.jobState).toBe('done');
  });

  it('returns non-2xx on reconciliation failure and retries a queued duplicate immediately', async () => {
    const repository = new WebhookRepository();
    repository.failReconciliation = true;
    const request = await signedRequest(event());

    const failed = await receiveStripeEvent(request.clone(), dependencies(repository));
    repository.failReconciliation = false;
    const retried = await receiveStripeEvent(request.clone(), dependencies(repository));

    expect(failed.status).toBe(503);
    expect(retried.status).toBe(200);
    expect(repository.reconcileCalls).toBe(2);
    expect(repository.eventStates.get('evt_test_701')).toBe('processed');
    expect(repository.jobState).toBe('done');
  });

  it('returns non-2xx when inbox persistence fails so Stripe can retry', async () => {
    const repository = new WebhookRepository();
    repository.failWrites = true;

    const response = await receiveStripeEvent(await signedRequest(event()), dependencies(repository));

    expect(response.status).toBe(503);
    expect(repository.eventIds.size).toBe(0);
  });

  it('rolls back the persisted event when enqueueing its order job fails', async () => {
    const repository = new WebhookRepository();
    repository.failJobWrites = true;

    const response = await receiveStripeEvent(await signedRequest(event()), dependencies(repository));

    expect(response.status).toBe(503);
    expect(repository.eventIds.size).toBe(0);
    expect(repository.jobWrites).toBe(0);
  });

  it('acknowledges signed events for unrelated accounts without queuing an LTSD order', async () => {
    const repository = new WebhookRepository();
    const body = event({
      id: 'evt_other_account',
      account: 'acct_other',
    });

    const response = await receiveStripeEvent(await signedRequest(body), dependencies(repository));

    expect(response.status).toBe(200);
    expect(repository.jobWrites).toBe(0);
  });

  it('does not bind a matching order reference to a malformed Checkout Session ID', async () => {
    const repository = new WebhookRepository();
    const body = event({
      data: { object: { id: 'not-a-session', object: 'checkout.session', mode: 'payment',
        client_reference_id: '701', metadata: { ltsd_commerce_order_id: '701' } } },
    });

    const response = await receiveStripeEvent(await signedRequest(body), dependencies(repository));

    expect(response.status).toBe(200);
    expect(repository.jobWrites).toBe(0);
    expect(repository.stripeCheckoutSessionId).toBe('cs_test_701');
  });

  it('matches 66-character Checkout Session IDs to their order', async () => {
    const repository = new WebhookRepository();
    const sessionId = `cs_test_${'a'.repeat(58)}`;
    repository.stripeCheckoutSessionId = sessionId;
    const body = event({
      id: 'evt_test_long_session_701',
      data: { object: {
        id: sessionId,
        object: 'checkout.session',
        mode: 'payment',
        client_reference_id: '701',
        metadata: { ltsd_commerce_order_id: '701' },
      } },
    });

    const response = await receiveStripeEvent(await signedRequest(body), dependencies(repository));

    expect(response.status).toBe(200);
    expect(repository.eventIds).toEqual(new Set(['evt_test_long_session_701']));
    expect(repository.stripeCheckoutSessionId).toBe(sessionId);
    expect(repository.jobWrites).toBe(1);
  });

  it('keeps duplicate event IDs idempotent when Stripe retries after the first response was lost', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequest(event());
    const responseLostAfterCommit = await receiveStripeEvent(request.clone(), dependencies(repository));
    const stripeRetry = await receiveStripeEvent(request.clone(), dependencies(repository));

    expect(responseLostAfterCommit.status).toBe(200);
    expect(stripeRetry.status).toBe(200);
    expect(repository.jobWrites).toBe(1);
  });

  it('adopts a signed Session ID when its webhook arrives before Checkout creation is persisted', async () => {
    const repository = new WebhookRepository();
    repository.stripeCheckoutSessionId = null;

    const response = await receiveStripeEvent(await signedRequest(event()), dependencies(repository));

    expect(response.status).toBe(200);
    expect(repository.stripeCheckoutSessionId).toBe('cs_test_701');
    expect(repository.jobWrites).toBe(1);
  });

  it('rejects reuse of an event ID with a different signed payload', async () => {
    const repository = new WebhookRepository();
    const first = await receiveStripeEvent(await signedRequest(event()), dependencies(repository));
    const changed = await receiveStripeEvent(await signedRequest(event({ livemode: true })), dependencies(repository));

    expect(first.status).toBe(200);
    expect(changed.status).toBe(409);
    expect(repository.jobWrites).toBe(1);
  });

  it('queues asynchronous payment success events for authoritative reconciliation', async () => {
    const repository = new WebhookRepository();
    const response = await receiveStripeEvent(
      await signedRequest(event({ id: 'evt_test_async_701', type: 'checkout.session.async_payment_succeeded' })),
      dependencies(repository),
    );

    expect(response.status).toBe(200);
    expect(repository.jobWrites).toBe(1);
    expect(repository.reconcileCalls).toBe(1);
  });

  it('passes the asynchronous payment failure type to reconciliation before acknowledging it', async () => {
    const repository = new WebhookRepository();
    const response = await receiveStripeEvent(
      await signedRequest(event({ id: 'evt_test_async_failed_701', type: 'checkout.session.async_payment_failed' })),
      dependencies(repository),
    );

    expect(response.status).toBe(200);
    expect(repository.eventStates.get('evt_test_async_failed_701')).toBe('processed');
    expect(repository.reconcileEventTypes).toEqual(['checkout.session.async_payment_failed']);
  });

  it('returns non-2xx and keeps an async failure queued while Stripe has no terminal Session state yet', async () => {
    const repository = new WebhookRepository();
    const response = await receiveStripeEvent(
      await signedRequest(event({ id: 'evt_test_async_failed_pending_701', type: 'checkout.session.async_payment_failed' })),
      dependencies(repository, 'pending'),
    );

    expect(response.status).toBe(503);
    expect(repository.eventStates.get('evt_test_async_failed_pending_701')).toBe('queued');
    expect(repository.jobState).toBe('queued');
  });

  it.each(['refund.created', 'refund.updated', 'refund.failed'])(
    'reconciles a %s event to its order using the PaymentIntent reference', async (type) => {
      const repository = new WebhookRepository();
      const eventId = 'evt_' + type.replaceAll('.', '_') + '_701';

      const response = await receiveStripeEvent(await signedRequest(refundEvent(type)), dependencies(repository));

      expect(response.status).toBe(200);
      expect(repository.eventOrderIds.get(eventId)).toBe('701');
      expect(repository.eventStates.get(eventId)).toBe('processed');
      expect(repository.jobWrites).toBe(1);
      expect(repository.reconcileCalls).toBe(1);
    },
  );

  it('resolves a refund that arrives before the Checkout event stores its PaymentIntent ID', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders = [{ id: '701', stripe_payment_intent_id: null, stripe_charge_id: null }];
    const resolveRefundOrderIdFromPaymentIntent = vi.fn(async (paymentIntentId: string) =>
      paymentIntentId === 'pi_test_701' ? '701' : null);
    const deps = { ...dependencies(repository), resolveRefundOrderIdFromPaymentIntent };

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_before_checkout_701')),
      deps,
    );

    expect(response.status).toBe(200);
    expect(resolveRefundOrderIdFromPaymentIntent).toHaveBeenCalledWith('pi_test_701');
    expect(repository.eventOrderIds.get('evt_refund_before_checkout_701')).toBe('701');
    expect(repository.eventStates.get('evt_refund_before_checkout_701')).toBe('processed');
    expect(repository.reconcileCalls).toBe(1);
  });

  it('does not associate PaymentIntent metadata with an order already linked to another intent', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders = [{ id: '701', stripe_payment_intent_id: 'pi_other_701', stripe_charge_id: null }];
    const deps = {
      ...dependencies(repository),
      resolveRefundOrderIdFromPaymentIntent: async () => '701',
    };

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_metadata_conflict_701')),
      deps,
    );

    expect(response.status).toBe(200);
    expect(repository.eventOrderIds.get('evt_refund_metadata_conflict_701')).toBeNull();
    expect(repository.eventStates.get('evt_refund_metadata_conflict_701')).toBe('ignored');
    expect(repository.reconcileCalls).toBe(0);
  });

  it('returns non-2xx without persisting when Stripe cannot resolve the PaymentIntent metadata', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders = [];
    const deps = {
      ...dependencies(repository),
      resolveRefundOrderIdFromPaymentIntent: async () => { throw new Error('Stripe unavailable'); },
    };

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_metadata_retry_701')),
      deps,
    );

    expect(response.status).toBe(503);
    expect(repository.eventIds.has('evt_refund_metadata_retry_701')).toBe(false);
  });

  it('reconciles charge.refunded using its PaymentIntent reference', async () => {
    const repository = new WebhookRepository();
    const eventId = 'evt_charge_refunded_701';

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('charge.refunded', eventId)), dependencies(repository),
    );

    expect(response.status).toBe(200);
    expect(repository.eventOrderIds.get(eventId)).toBe('701');
    expect(repository.eventStates.get(eventId)).toBe('processed');
    expect(repository.jobWrites).toBe(1);
    expect(repository.reconcileCalls).toBe(1);
  });

  it('reconciles Alipay refund and charge IDs through the PaymentIntent', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders = [{ id: '701', stripe_payment_intent_id: 'pi_test_701', stripe_charge_id: null }];

    const refundResponse = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_alipay_refund_701', {
        data: { object: {
          id: 'pyr_test_701', object: 'refund', payment_intent: 'pi_test_701', charge: 'py_test_701',
          amount: 500, currency: 'cny', status: 'pending', created: 1_800_000_000,
        } },
      })),
      dependencies(repository),
    );
    const chargeResponse = await receiveStripeEvent(
      await signedRequest(refundEvent('charge.refunded', 'evt_alipay_charge_refunded_701', {
        data: { object: { id: 'py_test_701', object: 'charge', payment_intent: 'pi_test_701' } },
      })),
      dependencies(repository),
    );

    expect(refundResponse.status).toBe(200);
    expect(chargeResponse.status).toBe(200);
    expect(repository.eventOrderIds.get('evt_alipay_refund_701')).toBe('701');
    expect(repository.eventOrderIds.get('evt_alipay_charge_refunded_701')).toBe('701');
    expect(repository.eventStates.get('evt_alipay_refund_701')).toBe('processed');
    expect(repository.eventStates.get('evt_alipay_charge_refunded_701')).toBe('processed');
    expect(repository.reconcileCalls).toBe(2);
  });

  it('can locate a refund by charge when Stripe omits its PaymentIntent reference', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders = [{ id: '701', stripe_payment_intent_id: null, stripe_charge_id: 'py_test_701' }];

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_charge_only_701', {
        data: { object: {
          id: 'pyr_test_701', object: 'refund', payment_intent: null, charge: 'py_test_701',
          amount: 500, currency: 'cny', status: 'succeeded', created: 1_800_000_000,
        } },
      })),
      dependencies(repository),
    );

    expect(response.status).toBe(200);
    expect(repository.eventOrderIds.get('evt_refund_charge_only_701')).toBe('701');
    expect(repository.reconcileCalls).toBe(1);
  });

  it('records a refund event without enqueueing when it references no commerce order', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders = [];

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_unmatched_701', {
        data: { object: {
          id: 're_test_unmatched', object: 'refund', payment_intent: 'pi_test_unmatched', charge: null,
        } },
      })),
      dependencies(repository),
    );

    expect(response.status).toBe(200);
    expect(repository.eventOrderIds.get('evt_refund_unmatched_701')).toBeNull();
    expect(repository.eventStates.get('evt_refund_unmatched_701')).toBe('ignored');
    expect(repository.jobWrites).toBe(0);
    expect(repository.reconcileCalls).toBe(0);
  });

  it('ignores conflicting PaymentIntent and Charge references instead of selecting either order', async () => {
    const repository = new WebhookRepository();
    repository.refundOrders.push({ id: '702', stripe_payment_intent_id: 'pi_test_other', stripe_charge_id: 'ch_test_other' });

    const response = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_conflict_701', {
        data: { object: {
          id: 'pyr_test_701', object: 'refund', payment_intent: 'pi_test_701', charge: 'py_test_other',
        } },
      })),
      dependencies(repository),
    );

    expect(response.status).toBe(200);
    expect(repository.eventOrderIds.get('evt_refund_conflict_701')).toBeNull();
    expect(repository.jobWrites).toBe(0);
    expect(repository.reconcileCalls).toBe(0);
  });

  it('deduplicates a processed refund event when Stripe retries its delivery', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequest(refundEvent('refund.updated', 'evt_refund_retry_701'));

    const first = await receiveStripeEvent(request.clone(), dependencies(repository));
    const retry = await receiveStripeEvent(request.clone(), dependencies(repository));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(repository.jobWrites).toBe(1);
    expect(repository.reconcileCalls).toBe(1);
  });

  it('keeps a concurrent refund event queued when another event reconciliation fails', async () => {
    const repository = new WebhookRepository();
    let releaseFirstReconciliation: () => void = () => {};
    let notifyFirstReconciliation: () => void = () => {};
    const firstReconciliationStarted = new Promise<void>((resolve) => { notifyFirstReconciliation = resolve; });
    const firstReconciliationGate = new Promise<void>((resolve) => { releaseFirstReconciliation = resolve; });
    let reconciliationCalls = 0;
    const deps = {
      ...dependencies(repository),
      reconcileOrder: async (orderId: string) => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) {
          notifyFirstReconciliation();
          await firstReconciliationGate;
          return { orderId, status: 'fulfilled' as const };
        }
        throw new Error('refund reconciliation temporarily unavailable');
      },
    };
    const first = receiveStripeEvent(
      await signedRequest(refundEvent('refund.created', 'evt_refund_concurrent_1')),
      deps,
    );
    const firstStarted = await Promise.race([
      firstReconciliationStarted.then(() => true),
      first.then(() => false),
    ]);
    expect(firstStarted).toBe(true);
    const second = await receiveStripeEvent(
      await signedRequest(refundEvent('refund.updated', 'evt_refund_concurrent_2')),
      deps,
    );
    releaseFirstReconciliation();
    const firstResponse = await first;

    expect(firstResponse.status).toBe(200);
    expect(second.status).toBe(503);
    expect(repository.eventStates.get('evt_refund_concurrent_1')).toBe('processed');
    expect(repository.eventStates.get('evt_refund_concurrent_2')).toBe('queued');
    expect(repository.jobState).toBe('queued');
  });

  it('registers a Stripe webhook route without browser-session authentication', async () => {
    const repository = new WebhookRepository();
    const app = new Hono();
    registerCommerceWebhookRoute(app, { setup: () => dependencies(repository) });

    const response = await app.fetch(await signedRequest(event()));

    expect(response.status).toBe(200);
    expect(repository.jobWrites).toBe(1);
  });

  it('returns non-2xx when webhook configuration cannot be loaded', async () => {
    const app = new Hono();
    registerCommerceWebhookRoute(app, { setup: () => { throw new Error('private config error'); } });

    const response = await app.request('https://ltsd.example/api/v1/commerce/stripe/webhook', { method: 'POST' });

    expect(response.status).toBe(503);
  });
});
