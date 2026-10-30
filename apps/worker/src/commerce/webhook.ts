import type { CommerceRepository } from './repository';
import { assertCommerceId } from './repository';
import type { MysqlRow } from '../db/mysql-client';

const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_WEBHOOK_BYTES = 1_000_000;
const ORDER_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

export interface WebhookDependencies {
  repository: CommerceRepository;
  signingSecret: string;
  stripeAccountId: string;
  livemode: boolean;
  now: () => number;
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

function decodeSigningSecret(value: string): Uint8Array {
  const encoded = value.startsWith('whsec_') ? value.slice(6) : '';
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    throw new InvalidStripeEvent();
  }
  try {
    const binary = atob(encoded);
    if (btoa(binary) !== encoded || binary.length === 0) throw new InvalidStripeEvent();
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new InvalidStripeEvent();
  }
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
  const secretBytes = decodeSigningSecret(signingSecret);
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
    objectId: typeof object?.id === 'string' && object.id.length <= 64 ? object.id : null,
    object,
  };
}

function candidateOrderId(event: StripeEvent): string | null {
  if (!ORDER_EVENT_TYPES.has(event.type) || !event.object || event.object.object !== 'checkout.session'
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

  const orderId = (event.account !== null && event.account !== dependencies.stripeAccountId)
    || event.livemode !== dependencies.livemode
    ? null
    : candidateOrderId(event);
  const objectId = event.objectId;
  try {
    await dependencies.repository.transaction(async (tx) => {
      const duplicate = await tx.first<MysqlRow>(
        'SELECT payload_sha256 FROM commerce_provider_events '
          + 'WHERE stripe_account_id = ? AND stripe_livemode = ? AND stripe_event_id = ? FOR UPDATE',
        [dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, event.id],
      );
      if (duplicate) {
        if (String(duplicate.payload_sha256) !== payloadSha256) throw new InvalidStripeEvent();
        return;
      }

      let matchedOrderId: string | null = null;
      if (orderId !== null && objectId !== null
        && typeof event.object?.mode === 'string' && event.object.mode === 'payment') {
        const order = await tx.first<MysqlRow>(
          'SELECT id, stripe_checkout_session_id FROM commerce_orders '
            + 'WHERE id = ? AND stripe_account_id = ? AND stripe_livemode = ? LIMIT 1 FOR UPDATE',
          [orderId, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0],
        );
        if (order && (String(order.stripe_checkout_session_id ?? '') === objectId
          || order.stripe_checkout_session_id === null || order.stripe_checkout_session_id === undefined)) {
          matchedOrderId = orderId;
        }
      }

      await tx.run(
        'INSERT INTO commerce_provider_events '
          + '(stripe_account_id, stripe_livemode, stripe_event_id, event_type, object_id, order_id, '
          + 'payload_sha256, state, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, event.id, event.type, objectId,
          matchedOrderId, payloadSha256, matchedOrderId === null ? 'ignored' : 'queued', now],
      );
      if (matchedOrderId === null) return;
      await tx.run(
        'UPDATE commerce_orders SET stripe_checkout_session_id = ? '
          + 'WHERE id = ? AND stripe_checkout_session_id IS NULL',
        [objectId, matchedOrderId],
      );

      await tx.run(
        'INSERT INTO commerce_jobs '
          + '(job_key, job_type, order_id, state, dirty_generation, processed_generation, '
          + 'next_run_at, created_at, updated_at) '
          + 'VALUES (?, \'order_reconcile\', ?, \'queued\', 1, 0, ?, ?, ?) '
          + 'ON DUPLICATE KEY UPDATE dirty_generation = dirty_generation + 1, '
          + 'state = CASE WHEN state = \'leased\' THEN \'leased\' ELSE \'queued\' END, '
          + 'next_run_at = LEAST(next_run_at, VALUES(next_run_at)), updated_at = VALUES(updated_at)',
        ['order-reconcile:' + matchedOrderId, matchedOrderId, now, now, now],
      );
    });
    return response(200);
  } catch (error) {
    if (error instanceof InvalidStripeEvent) return response(409);
    return response(503);
  }
}
