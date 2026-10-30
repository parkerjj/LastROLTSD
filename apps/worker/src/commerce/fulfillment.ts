import type { MysqlRow } from '../db/mysql-client';
import { assertCommerceId, readLastInsertId, type CommerceRepository, type CommerceTransaction } from './repository';
import { applyUnitProjection, replayCommerceUnit, type CommerceUnitEvent, type CommerceUnitEventType } from './projection';
import { appendRefundProjection, retainedDurationMs, syncOrderRefunds } from './refunds';
import type { StripeClient } from './stripe-client';

const MAX_SAFE_MILLIS = BigInt(Number.MAX_SAFE_INTEGER);
const MODULE_RESOURCE = 'module:standalone';

interface OrderSnapshot {
  orderId: string;
  userId: string;
  stripeAccountId: string;
  livemode: boolean;
  paidTotalCents: bigint;
  checkoutState: string;
  paymentState: string;
  fulfillmentState: string;
  refundRevision: number;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
}

interface OrderItem {
  id: string;
  ordinal: number;
  productKey: 'slots' | 'module:standalone';
  resource: 'slots' | 'module:standalone';
  operation: 'ADD' | 'RENEW' | 'ALIGN';
  targetUnitId: string | null;
  durationMs: bigint;
  deliveryState: string;
}

interface UnitSnapshot {
  id: string;
  userId: string;
  resource: string;
  unitKind: 'commerce' | 'legacy';
  entitlementId: string | null;
  baselineQuantity: number;
  baselineStartsAt: bigint | null;
  baselineExpiresAt: bigint | null;
  adminRevokedAt: bigint | null;
  refundZeroedAt: bigint | null;
}

interface StripeEventPaymentSnapshot {
  status: string;
  paymentStatus: string;
  paymentIntentId: string | null;
  confirmedPaid: boolean;
}

export interface FulfillmentDependencies {
  repository: CommerceRepository;
  stripe: StripeClient;
  stripeAccountId: string;
  livemode: boolean;
  now: () => number;
}

export interface FulfillmentResult {
  orderId: string;
  status: 'fulfilled' | 'pending' | 'not_paid';
}

class InvalidPaymentSnapshot extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

function readNullableBigint(value: unknown, field: string): bigint | null {
  return value === null || value === undefined ? null : readBigint(value, field);
}

function readSignedBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) throw new TypeError('missing commerce ' + field);
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    throw new TypeError('invalid commerce ' + field);
  }
}

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      throw new TypeError('invalid commerce event detail');
    }
  }
  return asRecord(value);
}

function readSmallNumber(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError('invalid commerce ' + field);
  return result;
}

function mysqlMillis(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_MILLIS) throw new RangeError('invalid commerce ' + field);
  const result = Number(value);
  if (BigInt(result) !== value) throw new RangeError('invalid commerce ' + field);
  return result;
}

function readLivemode(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new TypeError('invalid commerce livemode');
}

function parseOrderSnapshot(row: MysqlRow): OrderSnapshot {
  const stripeCheckoutSessionId = row.stripe_checkout_session_id;
  if (typeof stripeCheckoutSessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/u.test(stripeCheckoutSessionId)) {
    throw new Error('commerce order has no Checkout Session');
  }
  const stripeAccountId = String(row.stripe_account_id);
  if (!/^acct_[A-Za-z0-9]+$/u.test(stripeAccountId)) throw new TypeError('invalid commerce account');
  return {
    orderId: assertCommerceId(String(row.id)),
    userId: assertCommerceId(String(row.user_id)),
    stripeAccountId,
    livemode: readLivemode(row.stripe_livemode),
    paidTotalCents: readBigint(row.paid_total_cents, 'paid total'),
    checkoutState: String(row.checkout_state),
    paymentState: String(row.payment_state),
    fulfillmentState: String(row.fulfillment_state),
    refundRevision: readSmallNumber(row.refund_revision ?? 0, 'refund revision'),
    stripeCheckoutSessionId,
    stripePaymentIntentId: row.stripe_payment_intent_id === null || row.stripe_payment_intent_id === undefined
      ? null
      : String(row.stripe_payment_intent_id),
  };
}

function readOrderItem(row: MysqlRow): OrderItem {
  const productKey = String(row.product_key);
  const operation = String(row.operation);
  if ((productKey !== 'slots' && productKey !== MODULE_RESOURCE)
    || (operation !== 'ADD' && operation !== 'RENEW' && operation !== 'ALIGN')) {
    throw new TypeError('invalid commerce order item');
  }
  const targetUnitId = row.target_unit_id === null || row.target_unit_id === undefined
    ? null
    : assertCommerceId(String(row.target_unit_id));
  const durationMs = readBigint(row.duration_ms, 'item duration');
  if (durationMs <= 0n) throw new TypeError('invalid commerce item duration');
  return {
    id: assertCommerceId(String(row.id)),
    ordinal: readSmallNumber(row.ordinal, 'item ordinal'),
    productKey,
    resource: productKey,
    operation,
    targetUnitId,
    durationMs,
    deliveryState: String(row.delivery_state),
  };
}

function parseUnitSnapshot(row: MysqlRow): UnitSnapshot {
  const unitKind = String(row.unit_kind);
  if (unitKind !== 'commerce' && unitKind !== 'legacy') throw new TypeError('invalid commerce unit kind');
  return {
    id: assertCommerceId(String(row.id)),
    userId: assertCommerceId(String(row.user_id)),
    resource: String(row.resource),
    unitKind,
    entitlementId: row.ke_entitlement_id === null || row.ke_entitlement_id === undefined
      ? null
      : assertCommerceId(String(row.ke_entitlement_id)),
    baselineQuantity: readSmallNumber(row.baseline_quantity, 'unit baseline quantity'),
    baselineStartsAt: readNullableBigint(row.baseline_starts_at, 'unit baseline start'),
    baselineExpiresAt: readNullableBigint(row.baseline_expires_at, 'unit baseline expiry'),
    adminRevokedAt: readNullableBigint(row.admin_revoked_at, 'admin revocation'),
    refundZeroedAt: readNullableBigint(row.refund_zeroed_at, 'refund zeroing'),
  };
}

function readUnitEvent(row: MysqlRow): CommerceUnitEvent {
  const eventType = String(row.event_type) as CommerceUnitEventType;
  if (!['BASELINE', 'PURCHASE', 'ADMIN_DELTA', 'ADMIN_CUTOFF', 'ADMIN_REVOKE', 'ADMIN_RESTORE', 'REFUND_REPROJECT'].includes(eventType)) {
    throw new TypeError('invalid commerce unit event');
  }
  const detail = readJsonRecord(row.detail_json);
  return {
    unitSeq: readSmallNumber(row.unit_seq, 'unit event sequence'),
    eventType,
    orderItemId: row.order_item_id === null || row.order_item_id === undefined
      ? null
      : assertCommerceId(String(row.order_item_id)),
    refundRevision: row.refund_revision === null || row.refund_revision === undefined
      ? null
      : readSmallNumber(row.refund_revision, 'refund event revision'),
    occurredAt: readBigint(row.occurred_at, 'unit event timestamp'),
    deliveredAt: readNullableBigint(row.delivered_at, 'unit event delivery timestamp'),
    durationMs: row.duration_ms === null || row.duration_ms === undefined
      ? undefined
      : readSignedBigint(row.duration_ms, 'unit event duration'),
    requestedExpiresAt: eventType === 'ADMIN_CUTOFF' && detail?.afterExpiresAt !== null && detail?.afterExpiresAt !== undefined
      ? readBigint(detail.afterExpiresAt, 'admin requested expiry')
      : undefined,
    retainedDurationMs: eventType === 'REFUND_REPROJECT' && detail?.retainedDurationMs !== null && detail?.retainedDurationMs !== undefined
      ? readBigint(detail.retainedDurationMs, 'retained refund duration')
      : undefined,
  };
}

function stripeObjectId(value: unknown, prefix: string): string | null {
  if (typeof value === 'string') return new RegExp('^' + prefix + '_[A-Za-z0-9_]+$', 'u').test(value) ? value : null;
  const record = asRecord(value);
  return record ? stripeObjectId(record.id, prefix) : null;
}

function paymentIntentMetadata(value: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.metadata);
}

async function fetchSessionPayment(
  order: OrderSnapshot,
  dependencies: FulfillmentDependencies,
): Promise<StripeEventPaymentSnapshot> {
  if (order.stripeAccountId !== dependencies.stripeAccountId || order.livemode !== dependencies.livemode
    || order.paidTotalCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidPaymentSnapshot();
  }
  const sessionResponse = await dependencies.stripe.get<unknown>('/checkout/sessions/' + order.stripeCheckoutSessionId);
  const session = asRecord(sessionResponse);
  const metadata = asRecord(session?.metadata);
  if (!session || session.id !== order.stripeCheckoutSessionId
    || session.object !== 'checkout.session'
    || session.livemode !== order.livemode
    || session.mode !== 'payment'
    || (session.status !== 'complete' && session.status !== 'open' && session.status !== 'expired')
    || (session.payment_status !== 'unpaid' && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required')
    || session.client_reference_id !== order.orderId
    || metadata?.ltsd_commerce_order_id !== order.orderId
    || !Number.isSafeInteger(session.amount_total)
    || session.amount_total !== Number(order.paidTotalCents)
    || session.currency !== 'cny') {
    throw new InvalidPaymentSnapshot();
  }

  const paymentIntentId = stripeObjectId(session.payment_intent, 'pi');
  if (session.payment_status === 'no_payment_required') {
    if (order.paidTotalCents !== 0n || session.status !== 'complete'
      || (session.payment_intent !== null && session.payment_intent !== undefined)) {
      throw new InvalidPaymentSnapshot();
    }
    return { status: 'complete', paymentStatus: 'no_payment_required', paymentIntentId: null, confirmedPaid: true };
  }
  if (session.payment_status !== 'paid') {
    return { status: String(session.status), paymentStatus: String(session.payment_status), paymentIntentId, confirmedPaid: false };
  }
  if (!paymentIntentId) {
    if (session.status === 'complete' && session.payment_status === 'paid' && order.paidTotalCents === 0n) {
      return { status: 'complete', paymentStatus: 'paid', paymentIntentId: null, confirmedPaid: true };
    }
    return { status: String(session.status), paymentStatus: String(session.payment_status), paymentIntentId: null, confirmedPaid: false };
  }

  const intentResponse = await dependencies.stripe.get<unknown>('/payment_intents/' + paymentIntentId);
  const intent = asRecord(intentResponse);
  const intentMetadata = paymentIntentMetadata(intent);
  if (!intent || intent.id !== paymentIntentId
    || intent.object !== 'payment_intent'
    || intent.livemode !== order.livemode
    || intentMetadata?.ltsd_commerce_order_id !== order.orderId
    || !Number.isSafeInteger(intent.amount)
    || intent.amount !== Number(order.paidTotalCents)
    || intent.currency !== 'cny'
    || !['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'succeeded', 'canceled'].includes(String(intent.status))) {
    throw new InvalidPaymentSnapshot();
  }
  if (intent.status !== 'succeeded' || intent.amount_received !== Number(order.paidTotalCents)) {
    return { status: String(session.status), paymentStatus: String(session.payment_status), paymentIntentId, confirmedPaid: false };
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return { status: String(session.status), paymentStatus: String(session.payment_status), paymentIntentId, confirmedPaid: false };
  }
  return { status: 'complete', paymentStatus: 'paid', paymentIntentId, confirmedPaid: true };
}

function fulfillmentResult(orderId: string, status: FulfillmentResult['status']): FulfillmentResult {
  return { orderId, status };
}

async function readOrder(repository: CommerceRepository, orderId: string): Promise<OrderSnapshot> {
  return repository.transaction(async (tx) => {
    const row = await tx.first<MysqlRow>(
      'SELECT id, user_id, stripe_account_id, stripe_livemode, paid_total_cents, checkout_state, payment_state, '
      + 'fulfillment_state, refund_revision, stripe_checkout_session_id, stripe_payment_intent_id '
        + 'FROM commerce_orders WHERE id = ? LIMIT 1',
      [orderId],
    );
    if (!row) throw new Error('commerce order not found');
    return parseOrderSnapshot(row);
  });
}

async function readOrderItems(tx: CommerceTransaction, orderId: string): Promise<OrderItem[]> {
  const rows = await tx.all<MysqlRow>(
    'SELECT id, ordinal, product_key, resource, operation, target_unit_id, duration_ms, delivery_state '
      + 'FROM commerce_order_items WHERE order_id = ? ORDER BY ordinal FOR UPDATE',
    [orderId],
  );
  return rows.map(readOrderItem);
}

async function readUnitEvents(tx: CommerceTransaction, unitId: string): Promise<CommerceUnitEvent[]> {
  const rows = await tx.all<MysqlRow>(
    'SELECT unit_seq, event_type, order_item_id, refund_revision, occurred_at, delivered_at, duration_ms, detail_json '
      + 'FROM commerce_unit_events WHERE unit_id = ? ORDER BY unit_seq FOR UPDATE',
    [unitId],
  );
  return rows.map(readUnitEvent);
}

async function readUnit(tx: CommerceTransaction, unitId: string, userId: string, resource: string): Promise<UnitSnapshot> {
  const row = await tx.first<MysqlRow>(
    'SELECT id, user_id, resource, unit_kind, ke_entitlement_id, baseline_quantity, baseline_starts_at, '
      + 'baseline_expires_at, admin_revoked_at, refund_zeroed_at FROM commerce_units '
      + 'WHERE id = ? AND user_id = ? AND resource = ? FOR UPDATE',
    [unitId, userId, resource],
  );
  if (!row) throw new Error('commerce target unit is unavailable');
  return parseUnitSnapshot(row);
}

async function createUnit(
  tx: CommerceTransaction,
  userId: string,
  resource: string,
  now: number,
  kind: 'commerce' | 'legacy',
  baseline?: { entitlementId: string; quantity: number; startsAt: bigint; expiresAt: bigint; source: string; sourceRef: string },
): Promise<string> {
  await tx.run(
    'INSERT INTO commerce_units '
      + '(user_id, resource, unit_kind, ke_entitlement_id, baseline_source, baseline_source_ref, baseline_quantity, '
      + 'baseline_starts_at, baseline_expires_at, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, resource, kind, baseline?.entitlementId ?? null, baseline?.source ?? null, baseline?.sourceRef ?? null,
      baseline?.quantity ?? (kind === 'commerce' ? 1 : 0),
      baseline ? mysqlMillis(baseline.startsAt, 'unit baseline start') : null,
      baseline ? mysqlMillis(baseline.expiresAt, 'unit baseline expiry') : null, now, now],
  );
  const unitId = await readLastInsertId(tx);
  if (baseline) {
    await tx.run(
      'INSERT INTO commerce_unit_events '
        + '(unit_id, unit_seq, event_type, after_starts_at, after_expires_at, occurred_at, duration_ms, dedupe_key, detail_json, created_at) '
        + 'VALUES (?, 1, \'BASELINE\', ?, ?, ?, 0, ?, ?, ?)',
      [unitId, mysqlMillis(baseline.startsAt, 'unit baseline start'), mysqlMillis(baseline.expiresAt, 'unit baseline expiry'),
        now, 'baseline:' + unitId, JSON.stringify({ source: baseline.source, sourceRef: baseline.sourceRef }), now],
    );
  }
  return unitId;
}

async function resolveStandaloneUnit(
  tx: CommerceTransaction,
  userId: string,
  now: number,
): Promise<string> {
  const row = await tx.first<MysqlRow>(
    'SELECT e.id AS entitlement_id, e.quantity, e.starts_at, e.expires_at, e.source, e.source_ref, '
      + 'u.id AS unit_id FROM ke_entitlements e '
      + 'LEFT JOIN commerce_units u ON u.ke_entitlement_id = e.id '
      + 'WHERE e.user_id = ? AND e.resource = ? AND e.quantity > 0 '
      + 'AND e.starts_at <= ? AND e.expires_at > ? AND e.revoked_at IS NULL '
      + 'ORDER BY e.expires_at DESC, e.id ASC LIMIT 1 FOR UPDATE',
    [userId, MODULE_RESOURCE, now, now],
  );
  if (!row) return createUnit(tx, userId, MODULE_RESOURCE, now, 'commerce');
  if (row.unit_id !== null && row.unit_id !== undefined) {
    return assertCommerceId(String(row.unit_id));
  }
  const startsAt = readBigint(row.starts_at, 'module start');
  const expiresAt = readBigint(row.expires_at, 'module expiry');
  const entitlementId = assertCommerceId(String(row.entitlement_id));
  const quantity = readSmallNumber(row.quantity, 'module quantity');
  if (quantity <= 0 || expiresAt <= startsAt) throw new TypeError('invalid commerce module baseline');
  return createUnit(tx, userId, MODULE_RESOURCE, now, 'legacy', {
    entitlementId,
    quantity,
    startsAt,
    expiresAt,
    source: String(row.source),
    sourceRef: String(row.source_ref ?? 'legacy-standalone'),
  });
}

async function deliverItem(
  tx: CommerceTransaction,
  order: OrderSnapshot,
  item: OrderItem,
  deliveredAt: bigint,
): Promise<void> {
  let unitId: string;
  if (item.productKey === MODULE_RESOURCE) {
    unitId = await resolveStandaloneUnit(tx, order.userId, mysqlMillis(deliveredAt, 'delivery timestamp'));
  } else if (item.operation === 'ADD') {
    unitId = await createUnit(tx, order.userId, 'slots', mysqlMillis(deliveredAt, 'delivery timestamp'), 'commerce');
  } else {
    if (item.targetUnitId === null) throw new Error('commerce renewal target is missing');
    unitId = item.targetUnitId;
  }

  const unit = await readUnit(tx, unitId, order.userId, item.resource);
  if (unit.entitlementId === null && unit.unitKind !== 'commerce') throw new Error('commerce unit projection is missing');
  const existingEvents = await readUnitEvents(tx, unitId);
  const lastSequence = existingEvents.reduce((maximum, event) => Math.max(maximum, event.unitSeq), 0);
  if (!Number.isSafeInteger(lastSequence + 1)) throw new RangeError('commerce event sequence exhausted');
  const before = replayCommerceUnit({
    quantity: unit.baselineQuantity,
    startsAt: unit.baselineStartsAt,
    expiresAt: unit.baselineExpiresAt,
    adminRevokedAt: unit.adminRevokedAt,
    refundZeroedAt: unit.refundZeroedAt,
  }, existingEvents);
  const after = replayCommerceUnit({
    quantity: unit.baselineQuantity,
    startsAt: unit.baselineStartsAt,
    expiresAt: unit.baselineExpiresAt,
    adminRevokedAt: unit.adminRevokedAt,
    refundZeroedAt: unit.refundZeroedAt,
  }, [...existingEvents, {
    unitSeq: lastSequence + 1,
    eventType: 'PURCHASE',
    occurredAt: deliveredAt,
    deliveredAt,
    durationMs: item.durationMs,
  }]);

  const refundRow = await tx.first<MysqlRow>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS refunded_cents FROM commerce_refunds
      WHERE order_id = ? AND status = 'succeeded'`,
    [order.orderId],
  );
  const refundedCents = readBigint(refundRow?.refunded_cents ?? 0, 'successful refund total');
  const retainedDuration = retainedDurationMs(item.durationMs, order.paidTotalCents, refundedCents);

  await tx.run(
    'INSERT INTO commerce_unit_events '
      + '(unit_id, unit_seq, event_type, order_item_id, before_starts_at, before_expires_at, '
      + 'after_starts_at, after_expires_at, occurred_at, delivered_at, duration_ms, dedupe_key, detail_json, created_at) '
      + 'VALUES (?, ?, \'PURCHASE\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [unitId, lastSequence + 1, item.id, before.startsAt === null ? null : mysqlMillis(before.startsAt, 'before start'),
      before.expiresAt === null ? null : mysqlMillis(before.expiresAt, 'before expiry'),
      after.startsAt === null ? null : mysqlMillis(after.startsAt, 'after start'),
      after.expiresAt === null ? null : mysqlMillis(after.expiresAt, 'after expiry'),
      mysqlMillis(deliveredAt, 'delivery timestamp'), mysqlMillis(deliveredAt, 'delivery timestamp'),
      item.durationMs, 'order-item:' + item.id, JSON.stringify({ operation: item.operation, orderId: order.orderId }),
      mysqlMillis(deliveredAt, 'delivery timestamp')],
  );
  const refundApplied = retainedDuration < item.durationMs
    ? await appendRefundProjection(tx, {
      orderId: order.orderId,
      orderItemId: item.id,
      unitId,
      userId: order.userId,
      refundRevision: order.refundRevision,
      retainedDurationMs: retainedDuration,
      refundedTotalCents: refundedCents,
      occurredAt: deliveredAt,
    })
    : false;
  if (!refundApplied) await applyUnitProjection(tx, unitId, { ...after, appliedAt: deliveredAt });
  await tx.run(
    'UPDATE commerce_order_items SET delivery_state = \'delivered\', delivered_at = ? '
      + 'WHERE id = ? AND order_id = ? AND delivery_state = \'pending\'',
    [mysqlMillis(deliveredAt, 'delivery timestamp'), item.id, order.orderId],
  );
}

export async function reconcilePaidOrder(orderIdInput: string, dependencies: FulfillmentDependencies): Promise<FulfillmentResult> {
  const orderId = assertCommerceId(orderIdInput);
  const order = await readOrder(dependencies.repository, orderId);
  if (order.fulfillmentState === 'fulfilled' || order.fulfillmentState === 'settled') {
    return fulfillmentResult(orderId, 'fulfilled');
  }

  const payment = await fetchSessionPayment(order, dependencies);
  if (!payment.confirmedPaid) {
    return fulfillmentResult(orderId, payment.status === 'expired' ? 'not_paid' : 'pending');
  }

  await syncOrderRefunds(orderId, {
    repository: dependencies.repository,
    stripe: dependencies.stripe,
    stripeAccountId: dependencies.stripeAccountId,
    livemode: dependencies.livemode,
    now: dependencies.now,
  }, payment.paymentIntentId);

  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('invalid commerce delivery time');
  return dependencies.repository.transaction(async (tx) => {
    if (!await tx.lockUser(order.userId)) throw new Error('commerce user not found');
    const row = await tx.first<MysqlRow>(
      'SELECT id, user_id, stripe_account_id, stripe_livemode, paid_total_cents, checkout_state, payment_state, '
        + 'fulfillment_state, refund_revision, stripe_checkout_session_id, stripe_payment_intent_id '
        + 'FROM commerce_orders WHERE id = ? FOR UPDATE',
      [orderId],
    );
    if (!row) throw new Error('commerce order not found');
    const current = parseOrderSnapshot(row);
    if (current.userId !== order.userId
      || current.stripeAccountId !== order.stripeAccountId
      || current.livemode !== order.livemode
      || current.paidTotalCents !== order.paidTotalCents
      || current.stripeCheckoutSessionId !== order.stripeCheckoutSessionId) {
      throw new InvalidPaymentSnapshot();
    }
    if (current.fulfillmentState === 'fulfilled' || current.fulfillmentState === 'settled') {
      return fulfillmentResult(orderId, 'fulfilled');
    }

    const items = await readOrderItems(tx, orderId);
    if (items.length === 0) throw new Error('commerce order contains no items');
    const pendingItems = items.filter((item) => item.deliveryState === 'pending');
    if (pendingItems.length > 0) {
      const deliveredAt = BigInt(now);
      for (const item of pendingItems) await deliverItem(tx, current, item, deliveredAt);
    }

    await tx.run(
      'UPDATE commerce_orders SET payment_state = \'paid\', fulfillment_state = \'fulfilled\', '
        + 'stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id), '
        + 'applied_refund_revision = refund_revision, paid_at = COALESCE(paid_at, ?), '
        + 'fulfilled_at = COALESCE(fulfilled_at, ?), updated_at = ? WHERE id = ?',
      [payment.paymentIntentId, now, now, now, orderId],
    );
    return fulfillmentResult(orderId, 'fulfilled');
  });
}
