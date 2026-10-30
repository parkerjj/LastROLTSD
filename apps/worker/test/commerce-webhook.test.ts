import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { receiveStripeEvent } from '../src/commerce/webhook';
import { registerCommerceWebhookRoute } from '../src/commerce/router';
import type { CommerceRepository, CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow } from '../src/db/mysql-client';

const NOW = 1_800_000_000_000;
const SECRET_BYTES = new TextEncoder().encode('webhook-secret-for-commerce-tests');
const SIGNING_SECRET = 'whsec_' + btoa(String.fromCharCode(...SECRET_BYTES));

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

async function signedRequest(body: string, timestamp = Math.floor(NOW / 1000)): Promise<Request> {
  const key = await crypto.subtle.importKey('raw', SECRET_BYTES, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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
  jobWrites = 0;
  transactionCalls = 0;
  failWrites = false;
  failJobWrites = false;
  stripeCheckoutSessionId: string | null = 'cs_test_701';

  async transaction<T>(work: (tx: CommerceTransaction) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const priorEventIds = new Set(this.eventIds);
    const priorPayloadHashes = new Map(this.payloadHashes);
    const priorJobWrites = this.jobWrites;
    const priorSessionId = this.stripeCheckoutSessionId;
    const tx: CommerceTransaction = {
      lockUser: async () => true,
      all: async <R extends MysqlRow = MysqlRow>() => [] as R[],
      first: async <R extends MysqlRow = MysqlRow>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('FROM commerce_provider_events')) {
          const eventId = String(values[2]);
          const hash = this.payloadHashes.get(eventId);
          return hash ? { payload_sha256: hash } as unknown as R : null;
        }
        if (sql.includes('FROM commerce_orders')) {
          const id = String(values[0]);
          if (id === '701') return {
            id: '701', stripe_account_id: 'acct_test', stripe_livemode: 0,
            stripe_checkout_session_id: this.stripeCheckoutSessionId,
          } as unknown as R;
        }
        return null;
      },
      run: async (sql: string, values: readonly unknown[] = []) => {
        if (this.failWrites) throw new Error('database unavailable');
        if (sql.includes('commerce_provider_events')) {
          const eventId = String(values[2]);
          if (this.eventIds.has(eventId)) return { affectedRows: 0, insertId: 0 };
          this.eventIds.add(eventId);
          this.payloadHashes.set(eventId, String(values[6]));
          return { affectedRows: 1, insertId: 1 };
        }
        if (sql.includes('INSERT INTO commerce_jobs')) {
          if (this.failJobWrites) throw new Error('job persistence unavailable');
          this.jobWrites += 1;
        }
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
      this.jobWrites = priorJobWrites;
      this.stripeCheckoutSessionId = priorSessionId;
      throw error;
    }
  }
}

function dependencies(repository = new WebhookRepository()) {
  return {
    repository,
    signingSecret: SIGNING_SECRET,
    stripeAccountId: 'acct_test',
    livemode: false,
    now: () => NOW,
  };
}

describe('Stripe commerce webhook inbox', () => {
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

  it('stores the event and coalesced order job before acknowledging, then deduplicates retries', async () => {
    const repository = new WebhookRepository();
    const request = await signedRequest(event());

    const first = await receiveStripeEvent(request.clone(), dependencies(repository));
    const retry = await receiveStripeEvent(request.clone(), dependencies(repository));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(repository.eventIds).toEqual(new Set(['evt_test_701']));
    expect(repository.jobWrites).toBe(1);
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
