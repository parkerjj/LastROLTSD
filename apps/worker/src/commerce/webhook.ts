import { assertCommerceId, type CommerceRepository, type CommerceTransaction } from './repository';
import { enqueueCommerceReconcile } from './commerce-job-repository';
import type { FulfillmentResult } from './fulfillment';
import type { MysqlRow } from '../db/mysql-client';

const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_WEBHOOK_BYTES = 1_000_000;
const CHECKOUT_SESSION_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);
const REFUND_EVENT_TYPES = new Set(['refund.created', 'refund.updated', 'refund.failed']);

interface RefundReferences {
  paymentIntentId: string | null;
  chargeId: string | null;
}

export interface WebhookDependencies {
  repository: CommerceRepository;
  signingSecret: string;
  stripeAccountId: string;
  livemode: boolean;
  now: () => number;
  resolveRefundOrderIdFromPaymentIntent: (paymentIntentId: string) => Promise<string | null>;
  reconcileOrder: (orderId: string, eventType: string) => Promise<FulfillmentResult>;
}

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  account: string | null;
  objectId: string | null;
  object: Record<string, unknown> | null;
}

class InvalidStripeEvent extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function signingSecretBytes(value: string): Uint8Array {
  if (!/^whsec_(?:[A-Za-z0-9+/]{43}=|[A-Fa-f0-9]{64})$/u.test(value)) throw new InvalidStripeEvent();
  return new TextEncoder().encode(value);
}

function parseSignatures(value: string | null): { timestamp: number; signatures: Uint8Array[] } {
  if (!value || value.length > 4096) throw new InvalidStripeEvent();
  const timestamps: string[] = [];
  const signatures: Uint8Array[] = [];
  for (const part of value.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    if (key === 't') timestamps.push(raw);
    if (key === 'v1' && /^[a-f0-9]{64}$/iu.test(raw)) {
      signatures.push(Uint8Array.from(raw.match(/.{2}/gu)!, (hex) => Number.parseInt(hex, 16)));
    }
  }
  if (timestamps.length !== 1 || !/^\d{1,12}$/u.test(timestamps[0]!) || signatures.length === 0) {
    throw new InvalidStripeEvent();
  }
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp)) throw new InvalidStripeEvent();
  return { timestamp, signatures };
}

async function verifyStripeSignature(
  body: Uint8Array,
  signatureHeader: string | null,
  signingSecret: string,
  now: number,
): Promise<void> {
  const { timestamp, signatures } = parseSignatures(signatureHeader);
  if (!Number.isSafeInteger(now) || Math.abs(Math.floor(now / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new InvalidStripeEvent();
  }
  const secretBytes = signingSecretBytes(signingSecret);
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(secretBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const prefix = new TextEncoder().encode(timestamp + '.');
  const signedPayload = new Uint8Array(prefix.length + body.length);
  signedPayload.set(prefix);
  signedPayload.set(body, prefix.length);
  const valid = await Promise.all(signatures.map((signature) =>
    crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(signedPayload))));
  if (!valid.some(Boolean)) throw new InvalidStripeEvent();
}

function parseStripeEvent(value: unknown): StripeEvent {
  const event = asRecord(value);
  const data = asRecord(event?.data);
  const object = asRecord(data?.object);
  if (!event || event.object !== 'event'
    || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]+$/u.test(event.id)
    || typeof event.type !== 'string' || !/^[a-z][a-z0-9_.]{0,95}$/u.test(event.type)
    || typeof event.livemode !== 'boolean'
    || (event.account !== undefined && event.account !== null
      && (typeof event.account !== 'string' || !/^acct_[A-Za-z0-9]+$/u.test(event.account)))) {
    throw new InvalidStripeEvent();
  }
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    account: typeof event.account === 'string' ? event.account : null,
    objectId: typeof object?.id === 'string' && object.id.length <= 255 ? object.id : null,
    object,
  };
}

function candidateOrderId(event: StripeEvent): string | null {
  if (!CHECKOUT_SESSION_EVENT_TYPES.has(event.type) || !event.object || event.object.object !== 'checkout.session'
    || event.objectId === null || !/^cs_[A-Za-z0-9_]+$/u.test(event.objectId)) return null;
  const metadata = asRecord(event.object.metadata);
  const metadataId = metadata?.ltsd_commerce_order_id;
  const referenceId = event.object.client_reference_id;
  if (metadataId !== undefined && typeof metadataId !== 'string') return null;
  if (referenceId !== undefined && referenceId !== null && typeof referenceId !== 'string') return null;
  if (typeof metadataId === 'string' && typeof referenceId === 'string' && metadataId !== referenceId) return null;
  const value = typeof metadataId === 'string' ? metadataId : referenceId;
  try {
    return value === undefined || value === null ? null : assertCommerceId(value);
  } catch {
    return null;
  }
}

function stripeReferenceId(value: unknown, prefix: 'pi' | 'ch' | 'py'): string | null {
  const object = asRecord(value);
  const id = typeof value === 'string' ? value : object?.id;
  return typeof id === 'string' && id.length <= 255 && new RegExp('^' + prefix + '_[A-Za-z0-9_]+$', 'u').test(id)
    ? id
    : null;
}

function stripeChargeReferenceId(value: unknown): string | null {
  return stripeReferenceId(value, 'ch') ?? stripeReferenceId(value, 'py');
}

function optionalStripeReference(value: unknown, prefix: 'pi' | 'ch' | 'py'): { valid: boolean; id: string | null } {
  if (value === null || value === undefined) return { valid: true, id: null };
  const id = stripeReferenceId(value, prefix);
  return { valid: id !== null, id };
}

function optionalStripeChargeReference(value: unknown): { valid: boolean; id: string | null } {
  if (value === null || value === undefined) return { valid: true, id: null };
  const id = stripeChargeReferenceId(value);
  return { valid: id !== null, id };
}

function candidateRefundReferences(event: StripeEvent): RefundReferences | null {
  const object = event.object;
  if (!object) return null;
  if (REFUND_EVENT_TYPES.has(event.type)) {
    if (object.object !== 'refund' || event.objectId === null || !/^(?:re|pyr)_[A-Za-z0-9_]+$/u.test(event.objectId)) return null;
  } else if (event.type === 'charge.refunded') {
    if (object.object !== 'charge' || event.objectId === null || stripeChargeReferenceId(event.objectId) === null) return null;
  } else {
    return null;
  }

  const paymentIntent = optionalStripeReference(object.payment_intent, 'pi');
  const charge = event.type === 'charge.refunded'
    ? { valid: true, id: stripeChargeReferenceId(event.objectId) }
    : optionalStripeChargeReference(object.charge);
  if (!paymentIntent.valid || !charge.valid || (paymentIntent.id === null && charge.id === null)) return null;
  return { paymentIntentId: paymentIntent.id, chargeId: charge.id };
}

async function findRefundOrderId(
  tx: CommerceTransaction,
  references: RefundReferences,
  stripeAccountId: string,
  livemode: boolean,
): Promise<string | null> {
  const clauses: string[] = [];
  const values: unknown[] = [stripeAccountId, livemode ? 1 : 0];
  if (references.paymentIntentId !== null) {
    clauses.push('stripe_payment_intent_id = ?');
    values.push(references.paymentIntentId);
  }
  if (references.chargeId !== null) {
    clauses.push('stripe_charge_id = ?');
    values.push(references.chargeId);
  }
  const rows = await tx.all<MysqlRow>(
    'SELECT CAST(id AS CHAR) AS id, stripe_payment_intent_id, stripe_charge_id FROM commerce_orders '
      + 'WHERE stripe_account_id = ? AND stripe_livemode = ? AND (' + clauses.join(' OR ') + ') '
      + 'ORDER BY id LIMIT 2 FOR UPDATE',
    values,
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const paymentIntentId = row.stripe_payment_intent_id === null || row.stripe_payment_intent_id === undefined
    ? null
    : String(row.stripe_payment_intent_id);
  const chargeId = row.stripe_charge_id === null || row.stripe_charge_id === undefined ? null : String(row.stripe_charge_id);
  if ((references.paymentIntentId !== null && paymentIntentId !== null && paymentIntentId !== references.paymentIntentId)
    || (references.chargeId !== null && chargeId !== null && chargeId !== references.chargeId)) return null;
  try {
    return assertCommerceId(String(row.id));
  } catch {
    return null;
  }
}

async function findRefundOrderIdFromMetadata(
  tx: CommerceTransaction,
  orderIdInput: string,
  references: RefundReferences,
  stripeAccountId: string,
  livemode: boolean,
): Promise<string | null> {
  let orderId: string;
  try {
    orderId = assertCommerceId(orderIdInput);
  } catch {
    return null;
  }
  const row = await tx.first<MysqlRow>(
    'SELECT id, stripe_payment_intent_id, stripe_charge_id FROM commerce_orders '
      + 'WHERE id = ? AND stripe_account_id = ? AND stripe_livemode = ? LIMIT 1 FOR UPDATE',
    [orderId, stripeAccountId, livemode ? 1 : 0],
  );
  if (!row) return null;
  const paymentIntentId = row.stripe_payment_intent_id === null || row.stripe_payment_intent_id === undefined
    ? null
    : String(row.stripe_payment_intent_id);
  const chargeId = row.stripe_charge_id === null || row.stripe_charge_id === undefined ? null : String(row.stripe_charge_id);
  if ((paymentIntentId !== null && paymentIntentId !== references.paymentIntentId)
    || (references.chargeId !== null && chargeId !== null && references.chargeId !== chargeId)) return null;
  return orderId;
}

async function readJobGeneration(tx: CommerceTransaction, orderId: string): Promise<string> {
  const row = await tx.first<MysqlRow>(
    'SELECT CAST(dirty_generation AS CHAR) AS dirty_generation FROM commerce_jobs '
      + 'WHERE job_type = \'order_reconcile\' AND order_id = ? LIMIT 1 FOR UPDATE',
    [orderId],
  );
  const generation = row?.dirty_generation;
  if (generation === null || generation === undefined || !/^\d{1,20}$/u.test(String(generation))) {
    throw new Error('commerce reconcile job is missing');
  }
  return String(generation);
}

function response(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

class OversizedStripeEvent extends Error {}

async function readRequestBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidStripeEvent();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new OversizedStripeEvent();
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function receiveStripeEvent(request: Request, dependencies: WebhookDependencies): Promise<Response> {
  let body: Uint8Array;
  let event: StripeEvent;
  try {
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_WEBHOOK_BYTES)) {
      return response(413);
    }
    body = await readRequestBody(request);
    if (body.length === 0) return response(400);
    await verifyStripeSignature(body, request.headers.get('stripe-signature'), dependencies.signingSecret, dependencies.now());
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    event = parseStripeEvent(parsed);
  } catch (error) {
    if (error instanceof OversizedStripeEvent) return response(413);
    return response(400);
  }

  const payloadDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(body)));
  const payloadSha256 = [...payloadDigest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0
    || !/^acct_[A-Za-z0-9]+$/u.test(dependencies.stripeAccountId)) {
    return response(503);
  }

  const scoped = (event.account === null || event.account === dependencies.stripeAccountId)
    && event.livemode === dependencies.livemode;
  const checkoutOrderId = scoped ? candidateOrderId(event) : null;
  const refundReferences = scoped ? candidateRefundReferences(event) : null;
  const objectId = event.objectId;
  try {
    let refundOrderIdFromMetadata: string | null = null;
    if (refundReferences?.paymentIntentId !== null && refundReferences?.paymentIntentId !== undefined) {
      const indexedOrderId = await dependencies.repository.transaction((tx) =>
        findRefundOrderId(tx, refundReferences, dependencies.stripeAccountId, dependencies.livemode));
      if (indexedOrderId === null) {
        refundOrderIdFromMetadata = await dependencies.resolveRefundOrderIdFromPaymentIntent(refundReferences.paymentIntentId);
      }
    }

    const reconciliation = await dependencies.repository.transaction(async (tx) => {
      const duplicate = await tx.first<MysqlRow>(
        'SELECT payload_sha256, CAST(order_id AS CHAR) AS order_id, state FROM commerce_provider_events '
          + 'WHERE stripe_account_id = ? AND stripe_livemode = ? AND stripe_event_id = ? FOR UPDATE',
        [dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, event.id],
      );
      if (duplicate) {
        if (String(duplicate.payload_sha256) !== payloadSha256) throw new InvalidStripeEvent();
        if (duplicate.state !== 'queued' || duplicate.order_id === null || duplicate.order_id === undefined) return null;
        const orderId = assertCommerceId(String(duplicate.order_id));
        await enqueueCommerceReconcile(tx, orderId, now);
        return { orderId, generation: await readJobGeneration(tx, orderId) };
      }

      let matchedOrderId: string | null = null;
      if (checkoutOrderId !== null && objectId !== null
        && typeof event.object?.mode === 'string' && event.object.mode === 'payment') {
        const order = await tx.first<MysqlRow>(
          'SELECT id, stripe_checkout_session_id FROM commerce_orders '
            + 'WHERE id = ? AND stripe_account_id = ? AND stripe_livemode = ? LIMIT 1 FOR UPDATE',
          [checkoutOrderId, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0],
        );
        if (order && (String(order.stripe_checkout_session_id ?? '') === objectId
          || order.stripe_checkout_session_id === null || order.stripe_checkout_session_id === undefined)) {
          matchedOrderId = checkoutOrderId;
        }
      } else if (refundReferences !== null) {
        matchedOrderId = await findRefundOrderId(tx, refundReferences, dependencies.stripeAccountId, dependencies.livemode);
        if (matchedOrderId === null && refundOrderIdFromMetadata !== null) {
          matchedOrderId = await findRefundOrderIdFromMetadata(
            tx, refundOrderIdFromMetadata, refundReferences, dependencies.stripeAccountId, dependencies.livemode,
          );
        }
      }

      await tx.run(
        'INSERT INTO commerce_provider_events '
          + '(stripe_account_id, stripe_livemode, stripe_event_id, event_type, object_id, order_id, '
          + 'payload_sha256, state, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, event.id, event.type, objectId,
          matchedOrderId, payloadSha256, matchedOrderId === null ? 'ignored' : 'queued', now],
      );
      if (matchedOrderId === null) return null;
      if (checkoutOrderId !== null) {
        await tx.run(
          'UPDATE commerce_orders SET stripe_checkout_session_id = ? '
            + 'WHERE id = ? AND stripe_checkout_session_id IS NULL',
          [objectId, matchedOrderId],
        );
      }

      await enqueueCommerceReconcile(tx, matchedOrderId, now);
      return { orderId: matchedOrderId, generation: await readJobGeneration(tx, matchedOrderId) };
    });

    if (reconciliation !== null) {
      const result = await dependencies.reconcileOrder(reconciliation.orderId, event.type);
      if (result.status === 'pending' && event.type === 'checkout.session.async_payment_failed') return response(503);
      if (result.status !== 'pending') {
        const processedAt = dependencies.now();
        if (!Number.isSafeInteger(processedAt) || processedAt < 0) return response(503);
        await dependencies.repository.transaction(async (tx) => {
          await tx.run(
            'UPDATE commerce_provider_events SET state = \'processed\', processed_at = ? '
              + 'WHERE stripe_account_id = ? AND stripe_livemode = ? AND stripe_event_id = ? AND state = \'queued\'',
            [processedAt, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, event.id],
          );
          await tx.run(
            'UPDATE commerce_jobs SET processed_generation = ?, state = \'done\', '
              + 'next_run_at = ?, lease_owner = NULL, lease_until = NULL, last_error_code = NULL, updated_at = ? '
              + 'WHERE job_type = \'order_reconcile\' AND order_id = ? AND state = \'queued\' AND dirty_generation = ?',
            [reconciliation.generation, processedAt, processedAt, reconciliation.orderId, reconciliation.generation],
          );
        });
      }
    }
    return response(200);
  } catch (error) {
    if (error instanceof InvalidStripeEvent) return response(409);
    return response(503);
  }
}
