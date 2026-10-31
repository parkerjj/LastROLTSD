import type { MysqlRow } from '../db/mysql-client';
import { applyUnitProjection, replayCommerceUnit, type CommerceUnitBaseline, type CommerceUnitEvent } from './projection';
import { assertCommerceId, type CommerceRepository, type CommerceTransaction } from './repository';
import type { StripeClient } from './stripe-client';

const MAX_REFUND_PAGES = 100;
const MAX_REFUNDS = MAX_REFUND_PAGES * 100;
const MAX_SAFE_MILLIS = BigInt(Number.MAX_SAFE_INTEGER);
const REFUND_STATUSES = new Set(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']);

interface RefundSnapshot {
  id: string;
  amountCents: bigint;
  currency: 'cny';
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
  createdAt: bigint;
}

interface OrderSnapshot {
  id: string;
  userId: string;
  stripeAccountId: string;
  livemode: boolean;
  paidTotalCents: bigint;
  paymentIntentId: string | null;
  chargeId: string | null;
  refundSnapshotHash: string | null;
  refundSyncGeneration: number;
  refundRevision: number;
  appliedRefundRevision: number;
}

export interface RefundDependencies {
  repository: CommerceRepository;
  stripe: StripeClient;
  stripeAccountId: string;
  livemode: boolean;
  now: () => number;
}

export interface RefundSyncResult {
  orderId: string;
  status: 'synced' | 'deferred' | 'superseded';
  changed: boolean;
  refundRevision: number;
  refundedTotalCents: string;
  refundState: 'none' | 'partial' | 'full';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) throw new TypeError('missing commerce ' + field);
  try {
    const result = BigInt(value as string | number | bigint);
    if (result < 0n) throw new TypeError('invalid commerce ' + field);
    return result;
  } catch {
    throw new TypeError('invalid commerce ' + field);
  }
}

function readSignedBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) throw new TypeError('missing commerce ' + field);
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    throw new TypeError('invalid commerce ' + field);
  }
}

function readRevision(value: unknown, field: string): number {
  const revision = readBigint(value, field);
  if (revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('invalid commerce ' + field);
  return Number(revision);
}

function readLivemode(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new TypeError('invalid commerce livemode');
}

function stripeId(value: unknown, prefix: string): string | null {
  if (typeof value === 'string') return new RegExp('^' + prefix + '_[A-Za-z0-9_]+$', 'u').test(value) ? value : null;
  const record = asRecord(value);
  return record ? stripeId(record.id, prefix) : null;
}

function stripeRefundId(value: unknown): string | null {
  return stripeId(value, 're') ?? stripeId(value, 'pyr');
}

function stripeChargeId(value: unknown): string | null {
  return stripeId(value, 'ch') ?? stripeId(value, 'py');
}

function parseOrder(row: MysqlRow): OrderSnapshot {
  const accountId = String(row.stripe_account_id);
  if (!/^acct_[A-Za-z0-9]+$/u.test(accountId)) throw new TypeError('invalid commerce account');
  const paymentIntent = row.stripe_payment_intent_id === null || row.stripe_payment_intent_id === undefined
    ? null
    : String(row.stripe_payment_intent_id);
  const charge = row.stripe_charge_id === null || row.stripe_charge_id === undefined ? null : String(row.stripe_charge_id);
  if (paymentIntent !== null && !/^pi_[A-Za-z0-9_]+$/u.test(paymentIntent)) throw new TypeError('invalid commerce PaymentIntent');
  if (charge !== null && stripeChargeId(charge) !== charge) throw new TypeError('invalid commerce charge');
  const refundHash = row.refund_snapshot_hash === null || row.refund_snapshot_hash === undefined
    ? null
    : String(row.refund_snapshot_hash);
  if (refundHash !== null && !/^[a-f0-9]{64}$/u.test(refundHash)) throw new TypeError('invalid commerce refund snapshot hash');
  return {
    id: assertCommerceId(String(row.id)),
    userId: assertCommerceId(String(row.user_id)),
    stripeAccountId: accountId,
    livemode: readLivemode(row.stripe_livemode),
    paidTotalCents: readBigint(row.paid_total_cents, 'paid total'),
    paymentIntentId: paymentIntent,
    chargeId: charge,
    refundSnapshotHash: refundHash,
    refundSyncGeneration: readRevision(row.refund_sync_generation ?? 0, 'refund sync generation'),
    refundRevision: readRevision(row.refund_revision ?? 0, 'refund revision'),
    appliedRefundRevision: readRevision(row.applied_refund_revision ?? 0, 'applied refund revision'),
  };
}

function parseStripeRefund(value: unknown, paymentIntentId: string, chargeId: string | null): RefundSnapshot {
  const refund = asRecord(value);
  const id = stripeRefundId(refund?.id);
  const amount = refund?.amount;
  const status = refund?.status;
  const created = refund?.created;
  const currency = refund?.currency;
  const linkedPaymentIntent = refund?.payment_intent === null ? null : stripeId(refund?.payment_intent, 'pi');
  const linkedCharge = refund?.charge === null ? null : stripeChargeId(refund?.charge);
  if (!refund || refund.object !== 'refund' || !id
    || !Number.isSafeInteger(amount) || (amount as number) < 0
    || currency !== 'cny' || typeof status !== 'string' || !REFUND_STATUSES.has(status)
    || !Number.isSafeInteger(created) || (created as number) < 0
    || (refund.payment_intent !== null && !linkedPaymentIntent)
    || (refund.charge !== null && !linkedCharge)
    || (linkedPaymentIntent !== null && linkedPaymentIntent !== paymentIntentId)
    || (linkedCharge !== null && chargeId !== null && linkedCharge !== chargeId)) {
    throw new Error('invalid Stripe refund snapshot');
  }
  const createdAt = BigInt(created as number) * 1000n;
  if (createdAt > MAX_SAFE_MILLIS) throw new RangeError('invalid Stripe refund timestamp');
  return {
    id,
    amountCents: BigInt(amount as number),
    currency: 'cny',
    status: status as RefundSnapshot['status'],
    createdAt,
  };
}

async function fetchRefundSnapshot(
  stripe: StripeClient,
  paymentIntentId: string,
  chargeId: string | null,
): Promise<RefundSnapshot[]> {
  const refunds = new Map<string, RefundSnapshot>();
  let startingAfter: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_REFUND_PAGES; pageNumber += 1) {
    const page = asRecord(await stripe.get<unknown>('/refunds', {
      payment_intent: paymentIntentId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }));
    const data = asArray(page?.data);
    if (!page || page.object !== 'list' || typeof page.has_more !== 'boolean' || !data || data.length > 100) {
      throw new Error('invalid Stripe refund list');
    }
    for (const item of data) {
      const refund = parseStripeRefund(item, paymentIntentId, chargeId);
      if (refunds.has(refund.id)) throw new Error('duplicate Stripe refund in list');
      refunds.set(refund.id, refund);
      if (refunds.size > MAX_REFUNDS) throw new Error('Stripe refund snapshot exceeds reconciliation limit');
    }
    if (!page.has_more) return [...refunds.values()].sort((left, right) => left.id.localeCompare(right.id));
    if (data.length === 0) throw new Error('Stripe refund pagination did not advance');
    startingAfter = [...data].map((item) => stripeRefundId(asRecord(item)?.id)).at(-1) ?? undefined;
    if (!startingAfter) throw new Error('Stripe refund pagination cursor is invalid');
  }
  throw new Error('Stripe refund snapshot exceeds reconciliation page limit');
}

function parseStoredRefund(row: MysqlRow): RefundSnapshot {
  const id = String(row.stripe_refund_id);
  const status = String(row.status);
  if (!/^(?:re|pyr)_[A-Za-z0-9_]+$/u.test(id) || !REFUND_STATUSES.has(status)) throw new TypeError('invalid stored commerce refund');
  return {
    id,
    amountCents: readBigint(row.amount_cents, 'refund amount'),
    currency: 'cny',
    status: status as RefundSnapshot['status'],
    createdAt: readBigint(row.stripe_created_at, 'refund timestamp'),
  };
}

function refundCanonical(refunds: readonly RefundSnapshot[]): string {
  return JSON.stringify([...refunds]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((refund) => [refund.id, refund.amountCents.toString(), refund.currency, refund.status, refund.createdAt.toString()]));
}

async function hashSnapshot(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function totalSuccessfulRefunds(refunds: readonly RefundSnapshot[]): bigint {
  return refunds.reduce((total, refund) => total + (refund.status === 'succeeded' ? refund.amountCents : 0n), 0n);
}

export function retainedDurationMs(durationMs: bigint, paidTotalCents: bigint, successfulRefundCents: bigint): bigint {
  if (durationMs < 0n || paidTotalCents < 0n || successfulRefundCents < 0n) {
    throw new RangeError('commerce refund values must be nonnegative');
  }
  if (paidTotalCents === 0n) return durationMs;
  const refundableCents = successfulRefundCents < paidTotalCents ? successfulRefundCents : paidTotalCents;
  return durationMs * (paidTotalCents - refundableCents) / paidTotalCents;
}

function refundState(paidTotalCents: bigint, refundedCents: bigint): RefundSyncResult['refundState'] {
  if (paidTotalCents === 0n || refundedCents === 0n) return 'none';
  return refundedCents >= paidTotalCents ? 'full' : 'partial';
}

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      throw new TypeError('invalid commerce refund event detail');
    }
  }
  return asRecord(value);
}

function mysqlMillis(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_MILLIS) throw new RangeError('invalid commerce ' + field);
  const result = Number(value);
  if (BigInt(result) !== value) throw new RangeError('invalid commerce ' + field);
  return result;
}

function readEvent(row: MysqlRow): CommerceUnitEvent {
  const eventType = String(row.event_type) as CommerceUnitEvent['eventType'];
  if (!['BASELINE', 'PURCHASE', 'ADMIN_DELTA', 'ADMIN_CUTOFF', 'ADMIN_REVOKE', 'ADMIN_RESTORE', 'REFUND_REPROJECT'].includes(eventType)) {
    throw new TypeError('invalid commerce unit event');
  }
  const detail = readJsonRecord(row.detail_json);
  const itemId = row.order_item_id === null || row.order_item_id === undefined ? null : assertCommerceId(String(row.order_item_id));
  const retained = eventType === 'REFUND_REPROJECT' && detail?.retainedDurationMs !== null && detail?.retainedDurationMs !== undefined
    ? readBigint(detail.retainedDurationMs, 'retained refund duration')
    : undefined;
  return {
    unitSeq: Number(row.unit_seq),
    eventType,
    orderItemId: itemId,
    refundRevision: row.refund_revision === null || row.refund_revision === undefined
      ? null
      : readRevision(row.refund_revision, 'refund event revision'),
    occurredAt: readBigint(row.occurred_at, 'unit event timestamp'),
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : readBigint(row.delivered_at, 'delivery timestamp'),
    ...(row.duration_ms !== null && row.duration_ms !== undefined
      ? { durationMs: readSignedBigint(row.duration_ms, 'unit event duration') }
      : {}),
    ...(retained !== undefined ? { retainedDurationMs: retained } : {}),
  };
}

function readBaseline(row: MysqlRow): CommerceUnitBaseline {
  const nullable = (value: unknown, field: string): bigint | null => value === null || value === undefined ? null : readBigint(value, field);
  return {
    quantity: Number(row.baseline_quantity),
    startsAt: nullable(row.baseline_starts_at, 'unit baseline start'),
    expiresAt: nullable(row.baseline_expires_at, 'unit baseline expiry'),
    adminRevokedAt: nullable(row.admin_revoked_at, 'admin revocation'),
    refundZeroedAt: nullable(row.refund_zeroed_at, 'refund zeroing'),
  };
}

export async function appendRefundProjection(tx: CommerceTransaction, input: {
  orderId: string;
  orderItemId: string;
  unitId: string;
  userId: string;
  refundRevision: number;
  retainedDurationMs: bigint;
  refundedTotalCents: bigint;
  occurredAt: bigint;
}): Promise<boolean> {
  const orderId = assertCommerceId(input.orderId);
  const orderItemId = assertCommerceId(input.orderItemId);
  const unitId = assertCommerceId(input.unitId);
  const userId = assertCommerceId(input.userId);
  if (!Number.isSafeInteger(input.refundRevision) || input.refundRevision < 0 || input.retainedDurationMs < 0n) {
    throw new RangeError('invalid commerce refund projection');
  }
  const unitRow = await tx.first<MysqlRow>(
    'SELECT id, user_id, resource, ke_entitlement_id, baseline_quantity, baseline_starts_at, baseline_expires_at, '
      + 'admin_revoked_at, refund_zeroed_at FROM commerce_units WHERE id = ? AND user_id = ? FOR UPDATE',
    [unitId, userId],
  );
  if (!unitRow) throw new Error('commerce refund unit not found');
  const eventRows = await tx.all<MysqlRow>(
    'SELECT unit_seq, event_type, order_item_id, refund_revision, occurred_at, delivered_at, duration_ms, detail_json '
      + 'FROM commerce_unit_events WHERE unit_id = ? ORDER BY unit_seq FOR UPDATE',
    [unitId],
  );
  const events = eventRows.map(readEvent);
  const purchase = events.find((event) => event.eventType === 'PURCHASE' && event.orderItemId === orderItemId);
  if (!purchase) return false;
  const originalDuration = purchase.durationMs ?? 0n;
  let previousRetainedDuration = purchase.retainedDurationMs ?? originalDuration;
  for (const event of events) {
    if (event.eventType === 'REFUND_REPROJECT' && event.orderItemId === orderItemId && event.retainedDurationMs !== undefined) {
      previousRetainedDuration = event.retainedDurationMs;
    }
  }
  if (previousRetainedDuration === input.retainedDurationMs) return false;

  const baseline = readBaseline(unitRow);
  const before = replayCommerceUnit(baseline, events);
  const unitSeq = events.reduce((maximum, event) => Math.max(maximum, event.unitSeq), 0) + 1;
  if (!Number.isSafeInteger(unitSeq)) throw new RangeError('commerce event sequence exhausted');
  const delta = input.retainedDurationMs - previousRetainedDuration;
  const refundEvent: CommerceUnitEvent = {
    unitSeq,
    eventType: 'REFUND_REPROJECT',
    orderItemId,
    refundRevision: input.refundRevision,
    occurredAt: input.occurredAt,
    durationMs: delta,
    retainedDurationMs: input.retainedDurationMs,
  };
  const after = replayCommerceUnit(baseline, [...events, refundEvent]);
  await tx.run(
    `INSERT INTO commerce_unit_events
       (unit_id, unit_seq, event_type, order_item_id, refund_revision, before_starts_at, before_expires_at,
        after_starts_at, after_expires_at, occurred_at, duration_ms, dedupe_key, detail_json, created_at)
     VALUES (?, ?, 'REFUND_REPROJECT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [unitId, unitSeq, orderItemId, input.refundRevision,
      before.startsAt === null ? null : mysqlMillis(before.startsAt, 'before refund start'),
      before.expiresAt === null ? null : mysqlMillis(before.expiresAt, 'before refund expiry'),
      after.startsAt === null ? null : mysqlMillis(after.startsAt, 'after refund start'),
      after.expiresAt === null ? null : mysqlMillis(after.expiresAt, 'after refund expiry'),
      mysqlMillis(input.occurredAt, 'refund timestamp'), delta,
      `refund:${orderId}:${orderItemId}:${input.refundRevision}`,
      JSON.stringify({ orderId, refundedTotalCents: input.refundedTotalCents.toString(), retainedDurationMs: input.retainedDurationMs.toString() }),
      mysqlMillis(input.occurredAt, 'refund timestamp')],
  );
  await applyUnitProjection(tx, unitId, { ...after, appliedAt: input.occurredAt });
  return true;
}

async function readOrder(repository: CommerceRepository, orderId: string): Promise<OrderSnapshot> {
  return repository.transaction(async (tx) => {
    const row = await tx.first<MysqlRow>(
      'SELECT id, user_id, stripe_account_id, stripe_livemode, paid_total_cents, stripe_payment_intent_id, '
        + 'stripe_charge_id, refund_snapshot_hash, refund_sync_generation, refund_revision, applied_refund_revision '
        + 'FROM commerce_orders WHERE id = ? LIMIT 1',
      [orderId],
    );
    if (!row) throw new Error('commerce order not found');
    return parseOrder(row);
  });
}

function validateOrder(order: OrderSnapshot, dependencies: RefundDependencies): void {
  if (order.stripeAccountId !== dependencies.stripeAccountId || order.livemode !== dependencies.livemode) {
    throw new Error('commerce refund Stripe context mismatch');
  }
}

function result(orderId: string, status: RefundSyncResult['status'], changed: boolean, revision: number, paid: bigint, refunded: bigint): RefundSyncResult {
  return {
    orderId,
    status,
    changed,
    refundRevision: revision,
    refundedTotalCents: refunded.toString(),
    refundState: refundState(paid, refunded),
  };
}

export async function syncOrderRefunds(
  orderIdInput: string,
  dependencies: RefundDependencies,
  paymentIntentOverride?: string | null,
): Promise<RefundSyncResult> {
  const orderId = assertCommerceId(orderIdInput);
  const initialOrder = await readOrder(dependencies.repository, orderId);
  validateOrder(initialOrder, dependencies);
  const override = paymentIntentOverride === null || paymentIntentOverride === undefined ? null : stripeId(paymentIntentOverride, 'pi');
  if (paymentIntentOverride !== null && paymentIntentOverride !== undefined && override === null) {
    throw new TypeError('invalid commerce PaymentIntent');
  }
  if (initialOrder.paymentIntentId !== null && override !== null && initialOrder.paymentIntentId !== override) {
    throw new Error('commerce order PaymentIntent mismatch');
  }
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('invalid commerce refund sync time');
  if (initialOrder.paymentIntentId === null && override === null) {
    return result(orderId, 'deferred', false, initialOrder.refundRevision, initialOrder.paidTotalCents, 0n);
  }

  const reservation = await dependencies.repository.transaction(async (tx) => {
    if (!await tx.lockUser(initialOrder.userId)) throw new Error('commerce user not found');
    const row = await tx.first<MysqlRow>(
      'SELECT id, user_id, stripe_account_id, stripe_livemode, paid_total_cents, stripe_payment_intent_id, '
        + 'stripe_charge_id, refund_snapshot_hash, refund_sync_generation, refund_revision, applied_refund_revision '
        + 'FROM commerce_orders WHERE id = ? FOR UPDATE',
      [orderId],
    );
    if (!row) throw new Error('commerce order not found');
    const current = parseOrder(row);
    validateOrder(current, dependencies);
    if (current.userId !== initialOrder.userId || current.paidTotalCents !== initialOrder.paidTotalCents
      || (current.paymentIntentId !== null && override !== null && current.paymentIntentId !== override)) {
      throw new Error('commerce order changed during refund synchronization');
    }
    const paymentIntentId = current.paymentIntentId ?? override;
    if (paymentIntentId === null) return { order: current, paymentIntentId: null, generation: null };
    const generation = current.refundSyncGeneration + 1;
    if (!Number.isSafeInteger(generation)) throw new RangeError('commerce refund sync generation exhausted');
    await tx.run(
      'UPDATE commerce_orders SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), '
        + 'refund_sync_generation = ?, updated_at = ? WHERE id = ?',
      [paymentIntentId, generation, now, orderId],
    );
    return {
      order: { ...current, paymentIntentId, refundSyncGeneration: generation },
      paymentIntentId,
      generation,
    };
  });
  if (reservation.paymentIntentId === null || reservation.generation === null) {
    return result(orderId, 'deferred', false, reservation.order.refundRevision, reservation.order.paidTotalCents, 0n);
  }
  const paymentIntentId = reservation.paymentIntentId;
  const fetched = await fetchRefundSnapshot(dependencies.stripe, paymentIntentId, reservation.order.chargeId);
  const fetchedById = new Map(fetched.map((refund) => [refund.id, refund]));

  return dependencies.repository.transaction(async (tx) => {
    if (!await tx.lockUser(initialOrder.userId)) throw new Error('commerce user not found');
    const orderRow = await tx.first<MysqlRow>(
      'SELECT id, user_id, stripe_account_id, stripe_livemode, paid_total_cents, stripe_payment_intent_id, '
        + 'stripe_charge_id, refund_snapshot_hash, refund_sync_generation, refund_revision, applied_refund_revision '
        + 'FROM commerce_orders WHERE id = ? FOR UPDATE',
      [orderId],
    );
    if (!orderRow) throw new Error('commerce order not found');
    const order = parseOrder(orderRow);
    validateOrder(order, dependencies);
    if (order.userId !== reservation.order.userId || order.paidTotalCents !== reservation.order.paidTotalCents
      || order.paymentIntentId !== paymentIntentId) {
      throw new Error('commerce order changed during refund synchronization');
    }
    if (order.refundSyncGeneration !== reservation.generation) {
      const currentRefunds = await tx.all<MysqlRow>(
        'SELECT stripe_refund_id, amount_cents, currency, status, stripe_created_at FROM commerce_refunds '
          + 'WHERE order_id = ? AND stripe_account_id = ? AND stripe_livemode = ? FOR UPDATE',
        [orderId, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0],
      );
      return result(orderId, 'superseded', false, order.refundRevision, order.paidTotalCents,
        totalSuccessfulRefunds(currentRefunds.map(parseStoredRefund)));
    }

    const oldRows = await tx.all<MysqlRow>(
      'SELECT stripe_refund_id, amount_cents, currency, status, stripe_created_at FROM commerce_refunds '
        + 'WHERE order_id = ? AND stripe_account_id = ? AND stripe_livemode = ? ORDER BY stripe_refund_id FOR UPDATE',
      [orderId, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0],
    );
    const oldRefunds = oldRows.map(parseStoredRefund);
    const nextById = new Map(fetchedById);
    for (const previous of oldRefunds) {
      if (!nextById.has(previous.id)) nextById.set(previous.id, { ...previous, status: 'canceled' });
    }
    const nextRefunds = [...nextById.values()].sort((left, right) => left.id.localeCompare(right.id));
    const changed = refundCanonical(oldRefunds) !== refundCanonical(nextRefunds);
    const snapshotHash = await hashSnapshot(refundCanonical(nextRefunds));
    const revision = order.refundRevision + (changed ? 1 : 0);
    if (!Number.isSafeInteger(revision)) throw new RangeError('commerce refund revision exhausted');
    const oldRefundTotal = totalSuccessfulRefunds(oldRefunds);
    const newRefundTotal = totalSuccessfulRefunds(nextRefunds);

    if (changed) {
      for (const refund of fetched) {
        const existing = await tx.first<MysqlRow>(
          'SELECT order_id FROM commerce_refunds WHERE stripe_account_id = ? AND stripe_livemode = ? '
            + 'AND stripe_refund_id = ? LIMIT 1 FOR UPDATE',
          [dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, refund.id],
        );
        if (existing && String(existing.order_id) !== orderId) throw new Error('Stripe refund is already attached to another order');
        await tx.run(
          `INSERT INTO commerce_refunds
             (order_id, stripe_account_id, stripe_livemode, stripe_refund_id, amount_cents, currency, status,
              stripe_created_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE amount_cents = VALUES(amount_cents), currency = VALUES(currency),
             status = VALUES(status), stripe_created_at = VALUES(stripe_created_at), updated_at = VALUES(updated_at)`,
          [orderId, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, refund.id, refund.amountCents,
            refund.status, refund.createdAt, now, now],
        );
      }
      for (const previous of oldRefunds) {
        if (!fetchedById.has(previous.id)) {
          await tx.run(
            `UPDATE commerce_refunds SET status = 'canceled', updated_at = ?
              WHERE order_id = ? AND stripe_account_id = ? AND stripe_livemode = ? AND stripe_refund_id = ?
                AND status <> 'canceled'`,
            [now, orderId, dependencies.stripeAccountId, dependencies.livemode ? 1 : 0, previous.id],
          );
        }
      }
    }

    const derivedState = refundState(order.paidTotalCents, newRefundTotal);
    let appliedRevision = order.appliedRefundRevision;
    if (changed || appliedRevision < revision) {
      const items = await tx.all<MysqlRow>(
        'SELECT id, duration_ms, delivery_state FROM commerce_order_items WHERE order_id = ? ORDER BY ordinal FOR UPDATE',
        [orderId],
      );
      for (const item of items) {
        if (String(item.delivery_state) !== 'delivered') continue;
        const itemId = assertCommerceId(String(item.id));
        const durationMs = readBigint(item.duration_ms, 'item duration');
        const oldTarget = retainedDurationMs(durationMs, order.paidTotalCents, oldRefundTotal);
        const nextTarget = retainedDurationMs(durationMs, order.paidTotalCents, newRefundTotal);
        if (oldTarget === nextTarget) continue;
        const purchaseRow = await tx.first<MysqlRow>(
          `SELECT unit_id FROM commerce_unit_events
            WHERE order_item_id = ? AND event_type = 'PURCHASE' LIMIT 1 FOR UPDATE`,
          [itemId],
        );
        if (!purchaseRow) throw new Error('delivered commerce item has no purchase contribution');
        const projected = await appendRefundProjection(tx, {
          orderId,
          orderItemId: itemId,
          unitId: assertCommerceId(String(purchaseRow.unit_id)),
          userId: order.userId,
          refundRevision: revision,
          retainedDurationMs: nextTarget,
          refundedTotalCents: newRefundTotal,
          occurredAt: BigInt(now),
        });
        if (!projected) throw new Error('commerce refund contribution did not change');
      }
      appliedRevision = revision;
    }

    if (changed || order.refundSnapshotHash !== snapshotHash || order.appliedRefundRevision !== appliedRevision) {
      await tx.run(
        'UPDATE commerce_orders SET refund_snapshot_hash = ?, refund_revision = ?, applied_refund_revision = ?, refund_state = ?, updated_at = ? '
          + 'WHERE id = ?',
        [snapshotHash, revision, appliedRevision, derivedState, now, orderId],
      );
    }
    return result(orderId, 'synced', changed, revision, order.paidTotalCents, newRefundTotal);
  });
}
