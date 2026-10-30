import { getCommerceCatalog, priceLineCents, tierForDuration, type CommerceProductKey } from '@lastroweb/commerce';
import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import { assertCommerceId, createCommerceRepository, readLastInsertId, type CommerceRepository, type CommerceTransaction } from './repository';
import type { CommerceQuote, CommerceQuoteItem } from './quotes';
import type { PromotionPreview } from './promotion-preview';
import type { StripeClient } from './stripe-client';
import { createCheckoutSession, retrieveCheckoutSession, type CheckoutPriceLine, type CheckoutSessionSnapshot } from './checkout';
import { groupStripeCommerceLines } from './line-items';

const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const CHECKOUT_CREATION_MARGIN_MS = 30_000;
const MAX_ITEMS = 1000;
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export type CheckoutState = 'creating' | 'ready' | 'failed' | 'expired';
type QuoteOrderItem = Omit<CommerceQuoteItem, 'operation'> & { operation: 'ADD' | 'RENEW' | 'ALIGN' };
export interface StoredOrderItem extends QuoteOrderItem {
  stripeProductId: string;
}

export interface StoredCommerceOrder {
  orderId: string;
  userId: string;
  quoteId: string;
  requestHash: string;
  confirmationKeyDigest: string;
  pricingVersion: string;
  stripeAccountId: string;
  livemode: boolean;
  currency: 'CNY';
  items: StoredOrderItem[];
  accountPreview: CommerceQuote['accountPreview'];
  rawTotalCents: string;
  tierTotalCents: string;
  promoTotalCents: string | null;
  paidTotalCents: string;
  discountStrategy: 'term' | 'promotion_code';
  promotion: PromotionPreview | null;
  paymentMethodConfigurationId: string;
  siteOrigin: string;
  checkoutState: CheckoutState;
  stripeCheckoutSessionId: string | null;
  checkoutExpiresAt: number | null;
  createdAt: number;
}

export interface ReserveOrderInput {
  userId: string;
  quoteId: string;
  confirmationKeyDigest: string;
  pricingVersion: string;
  stripeAccountId: string;
  livemode: boolean;
  paymentMethodConfigurationId: string;
  productIds: Partial<Record<CommerceProductKey, string>>;
  siteOrigin: string;
  now: number;
}

export interface OrderRepository {
  reserveOrder(input: ReserveOrderInput): Promise<StoredCommerceOrder>;
  prepareCheckout(orderId: string, proposedExpiry: number, updatedAt: number): Promise<number>;
  markCheckoutReady(orderId: string, session: CheckoutSessionSnapshot, updatedAt: number): Promise<void>;
  markCheckoutFailed(orderId: string, updatedAt: number): Promise<void>;
  markCheckoutExpired(orderId: string, updatedAt: number): Promise<void>;
}

export interface OrderDependencies {
  repository: OrderRepository;
  stripe: StripeClient;
  now: () => number;
  pricingVersion: string;
  stripeAccountId: string;
  livemode: boolean;
  paymentMethodConfigurationId: string;
  productIds: Partial<Record<CommerceProductKey, string>>;
  siteOrigin: string;
  ensureCustomer(userId: string): Promise<string>;
}

export interface CheckoutOrderResult {
  orderId: string;
  checkoutUrl: string | null;
  expiresAt: number;
  paymentStatus: CheckoutSessionSnapshot['paymentStatus'];
}

export type CommerceOrderErrorCode =
  | 'COMMERCE_QUOTE_UNAVAILABLE'
  | 'COMMERCE_QUOTE_EXPIRED'
  | 'COMMERCE_PRICING_CHANGED'
  | 'COMMERCE_IDEMPOTENCY_CONFLICT'
  | 'COMMERCE_ORDER_EXPIRED'
  | 'COMMERCE_ORDER_UNAVAILABLE';

export class CommerceOrderError extends Error {
  constructor(public readonly code: CommerceOrderErrorCode) {
    super(code);
    this.name = 'CommerceOrderError';
  }
}

interface QuoteRow extends MysqlRow {
  id: string | number | bigint;
  user_id: string | number | bigint;
  pricing_version: string;
  currency: string;
  request_hash: string;
  input_snapshot: unknown;
  preview_snapshot: unknown;
  raw_total_cents: string | number | bigint;
  tier_total_cents: string | number | bigint;
  promo_total_cents: string | number | bigint | null;
  selected_total_cents: string | number | bigint;
  discount_strategy: string;
  promotion_snapshot: unknown;
  created_at: string | number | bigint;
  expires_at: string | number | bigint;
}

interface OrderRow extends MysqlRow {
  id: string | number | bigint;
  user_id: string | number | bigint;
  quote_id: string | number | bigint;
  request_hash: string;
  confirmation_idempotency_key: string;
  stripe_account_id: string;
  stripe_livemode: number | boolean | string;
  pricing_version: string;
  currency: string;
  items_snapshot: unknown;
  preview_snapshot: unknown;
  raw_total_cents: string | number | bigint;
  tier_total_cents: string | number | bigint;
  promo_total_cents: string | number | bigint | null;
  paid_total_cents: string | number | bigint;
  discount_strategy: string;
  promotion_snapshot: unknown;
  checkout_state: string;
  stripe_checkout_session_id: string | null;
  checkout_expires_at: string | number | bigint | null;
  created_at: string | number | bigint;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateCheckoutConfiguration(siteOrigin: unknown, paymentMethodConfigurationId: unknown): {
  siteOrigin: string;
  paymentMethodConfigurationId: string;
} {
  if (typeof siteOrigin !== 'string' || typeof paymentMethodConfigurationId !== 'string'
    || !/^pmc_[A-Za-z0-9]+$/u.test(paymentMethodConfigurationId)) throw new TypeError('invalid commerce checkout configuration');
  let origin: URL;
  try {
    origin = new URL(siteOrigin);
  } catch {
    throw new TypeError('invalid commerce checkout origin');
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('invalid commerce checkout origin');
  }
  return { siteOrigin: origin.origin, paymentMethodConfigurationId };
}

function readJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`invalid commerce ${field}`);
  }
}

function readBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) throw new TypeError(`missing commerce ${field}`);
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    throw new TypeError(`invalid commerce ${field}`);
  }
}

function readSafeAmount(value: unknown, field: string): string {
  const amount = readBigint(value, field);
  if (amount < 0n || amount > MAX_CENTS) throw new TypeError(`invalid commerce ${field}`);
  return amount.toString();
}

function readPromotion(value: unknown): PromotionPreview | null {
  if (value === null || value === undefined) return null;
  const snapshot = asRecord(readJson(value, 'promotion snapshot'));
  if (!snapshot || typeof snapshot.promotionCodeId !== 'string' || !/^promo_[A-Za-z0-9]+$/u.test(snapshot.promotionCodeId)
    || typeof snapshot.couponId !== 'string' || !/^coupon_[A-Za-z0-9]+$/u.test(snapshot.couponId)
    || !Number.isSafeInteger(snapshot.subtotalCents) || !Number.isSafeInteger(snapshot.totalCents)
    || !Number.isSafeInteger(snapshot.discountCents) || Number(snapshot.subtotalCents) < 0
    || Number(snapshot.totalCents) < 0 || Number(snapshot.discountCents) < 0 || snapshot.currency !== 'cny') {
    throw new TypeError('invalid commerce promotion snapshot');
  }
  return {
    promotionCodeId: snapshot.promotionCodeId,
    couponId: snapshot.couponId,
    subtotalCents: Number(snapshot.subtotalCents),
    totalCents: Number(snapshot.totalCents),
    discountCents: Number(snapshot.discountCents),
    currency: 'cny',
  };
}

function readQuoteItems(value: unknown, alignment: boolean | null): QuoteOrderItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) throw new TypeError('invalid commerce quote items');
  return value.map((candidate, index) => {
    const item = asRecord(candidate);
    if (!item || item.ordinal !== index + 1
      || (item.productKey !== 'slots' && item.productKey !== 'module:standalone')
      || (item.operation !== 'ADD' && item.operation !== 'RENEW' && !(alignment === null && item.operation === 'ALIGN'))
      || ![70, 80, 100].includes(Number(item.discountPercent))) {
      throw new TypeError('invalid commerce quote item');
    }
    const durationMs = readBigint(item.durationMs, 'quote item duration');
    const startsAt = readBigint(item.expectedStartsAt, 'quote item start');
    const expiresAt = readBigint(item.expectedExpiresAt, 'quote item expiry');
    if (durationMs <= 0n || expiresAt - startsAt !== durationMs) throw new TypeError('invalid commerce quote item window');
    const targetUnitId = item.targetUnitId === null ? null : assertCommerceId(String(item.targetUnitId));
    const targetEntitlementId = item.targetEntitlementId === null ? null : assertCommerceId(String(item.targetEntitlementId));
    return {
      ordinal: index + 1,
      productKey: item.productKey,
      operation: alignment === true ? 'ALIGN' : item.operation as QuoteOrderItem['operation'],
      targetUnitId,
      targetEntitlementId,
      durationMs: durationMs.toString(),
      expectedStartsAt: startsAt.toString(),
      expectedExpiresAt: expiresAt.toString(),
      discountPercent: Number(item.discountPercent) as 70 | 80 | 100,
      rawCents: readSafeAmount(item.rawCents, 'quote item raw amount'),
      tierCents: readSafeAmount(item.tierCents, 'quote item tier amount'),
      paidCents: readSafeAmount(item.paidCents, 'quote item paid amount'),
    };
  });
}

function readStoredOrderItems(value: unknown): StoredOrderItem[] {
  const items = readQuoteItems(value, null);
  const rows = value as unknown[];
  return items.map((item, index) => {
    const row = asRecord(rows[index]);
    if (typeof row?.stripeProductId !== 'string' || !/^prod_[A-Za-z0-9]+$/u.test(row.stripeProductId)) {
      throw new TypeError('invalid commerce order product snapshot');
    }
    return { ...item, stripeProductId: row.stripeProductId };
  });
}

function isAlignmentInput(value: unknown): boolean {
  const snapshot = asRecord(readJson(value, 'quote input'));
  const selection = snapshot?.selection;
  return Array.isArray(selection) && selection.some((item) => asRecord(item)?.type === 'align_all_paid');
}

function readAccountPreview(value: unknown): CommerceQuote['accountPreview'] {
  const snapshot = asRecord(value);
  const preview = snapshot?.accountPreview;
  const record = asRecord(preview);
  const before = asRecord(record?.before);
  const after = asRecord(record?.after);
  if (!record || !before || !after || !Array.isArray(before.entitlements) || !Array.isArray(after.entitlements)
    || !asRecord(before.effective) || !asRecord(after.effective)) {
    throw new TypeError('invalid commerce account preview');
  }
  return preview as CommerceQuote['accountPreview'];
}

function validateQuoteTotals(input: {
  pricingVersion: string;
  currency: string;
  items: readonly QuoteOrderItem[];
  rawTotalCents: string;
  tierTotalCents: string;
  promoTotalCents: string | null;
  selectedTotalCents: string;
  discountStrategy: string;
  promotion: PromotionPreview | null;
}): { paidTotalCents: string; discountStrategy: 'term' | 'promotion_code' } {
  if (input.currency !== 'CNY' || (input.discountStrategy !== 'term' && input.discountStrategy !== 'promotion_code')) {
    throw new TypeError('invalid commerce quote');
  }
  let rawTotal = 0n;
  let tierTotal = 0n;
  let paidTotal = 0n;
  for (const item of input.items) {
    const raw = BigInt(item.rawCents);
    const tier = BigInt(item.tierCents);
    const paid = BigInt(item.paidCents);
    rawTotal += raw;
    tierTotal += tier;
    paidTotal += paid;
  }
  if (rawTotal.toString() !== input.rawTotalCents || tierTotal.toString() !== input.tierTotalCents
    || paidTotal.toString() !== input.selectedTotalCents) throw new TypeError('commerce quote totals are inconsistent');
  if ((input.promoTotalCents === null) !== (input.promotion === null)) throw new TypeError('commerce promotion snapshot is inconsistent');
  if (input.promotion && (input.promotion.subtotalCents !== Number(rawTotal)
    || input.promotion.totalCents !== Number(input.promoTotalCents)
    || input.promotion.discountCents !== Number(rawTotal - BigInt(input.promoTotalCents!)))) {
    throw new TypeError('commerce promotion snapshot is inconsistent');
  }
  if (input.discountStrategy === 'term') {
    if (input.selectedTotalCents !== input.tierTotalCents) throw new TypeError('commerce term total is inconsistent');
  } else if (input.promoTotalCents !== input.selectedTotalCents || !input.promotion
    || BigInt(input.promoTotalCents ?? '-1') > rawTotal) {
    throw new TypeError('commerce promotion total is inconsistent');
  }
  return { paidTotalCents: input.selectedTotalCents, discountStrategy: input.discountStrategy };
}

function validateQuotePricing(
  input: Parameters<typeof validateQuoteTotals>[0],
  currentVersion: string,
): ReturnType<typeof validateQuoteTotals> {
  if (input.pricingVersion !== currentVersion) throw new CommerceOrderError('COMMERCE_PRICING_CHANGED');
  const catalog = getCommerceCatalog(currentVersion);
  const products = new Map(catalog.products.map((product) => [product.key, product]));
  for (const item of input.items) {
    const product = products.get(item.productKey);
    if (!product) throw new TypeError('invalid commerce quote product');
    const durationMs = BigInt(item.durationMs);
    const expectedTierPercent = tierForDuration(durationMs);
    if (item.discountPercent !== expectedTierPercent
      || BigInt(item.rawCents) !== priceLineCents(BigInt(product.monthlyUnitPriceCents), durationMs, 100)
      || BigInt(item.tierCents) !== priceLineCents(BigInt(product.monthlyUnitPriceCents), durationMs, expectedTierPercent)) {
      throw new TypeError('commerce quote prices are inconsistent');
    }
  }
  return validateQuoteTotals(input);
}

function readOrderRow(row: OrderRow): StoredCommerceOrder {
  const itemsSnapshot = asRecord({ items: readJson(row.items_snapshot, 'order items') });
  const rawItems = itemsSnapshot?.items;
  const previewSnapshot = asRecord(readJson(row.preview_snapshot, 'order preview'));
  const items = readStoredOrderItems(rawItems);
  const promotion = readPromotion(row.promotion_snapshot);
  const checkoutConfig = validateCheckoutConfiguration(previewSnapshot?.checkoutSiteOrigin, previewSnapshot?.paymentMethodConfigurationId);
  const stripeLivemode = row.stripe_livemode === true || row.stripe_livemode === 1 || row.stripe_livemode === '1';
  if (row.stripe_livemode !== true && row.stripe_livemode !== false && row.stripe_livemode !== 0
    && row.stripe_livemode !== 1 && row.stripe_livemode !== '0' && row.stripe_livemode !== '1') {
    throw new TypeError('invalid commerce order mode');
  }
  if (!/^acct_[A-Za-z0-9]+$/u.test(row.stripe_account_id)) throw new TypeError('invalid commerce order account');
  const rawTotalCents = readSafeAmount(row.raw_total_cents, 'order raw amount');
  const tierTotalCents = readSafeAmount(row.tier_total_cents, 'order tier amount');
  const promoTotalCents = row.promo_total_cents === null ? null : readSafeAmount(row.promo_total_cents, 'order promotion amount');
  const paidTotalCents = readSafeAmount(row.paid_total_cents, 'order paid amount');
  validateQuoteTotals({
    pricingVersion: row.pricing_version,
    currency: row.currency,
    items,
    rawTotalCents,
    tierTotalCents,
    promoTotalCents,
    selectedTotalCents: paidTotalCents,
    discountStrategy: row.discount_strategy,
    promotion,
  });
  const state = row.checkout_state;
  if (state !== 'creating' && state !== 'ready' && state !== 'failed' && state !== 'expired') throw new TypeError('invalid commerce order state');
  return {
    orderId: assertCommerceId(String(row.id)),
    userId: assertCommerceId(String(row.user_id)),
    quoteId: assertCommerceId(String(row.quote_id)),
    requestHash: String(row.request_hash),
    confirmationKeyDigest: String(row.confirmation_idempotency_key),
    pricingVersion: row.pricing_version,
    stripeAccountId: row.stripe_account_id,
    livemode: stripeLivemode,
    currency: 'CNY',
    items,
    accountPreview: readAccountPreview(previewSnapshot),
    rawTotalCents,
    tierTotalCents,
    promoTotalCents,
    paidTotalCents,
    discountStrategy: row.discount_strategy as 'term' | 'promotion_code',
    promotion,
    paymentMethodConfigurationId: checkoutConfig.paymentMethodConfigurationId,
    siteOrigin: checkoutConfig.siteOrigin,
    checkoutState: state,
    stripeCheckoutSessionId: row.stripe_checkout_session_id ?? null,
    checkoutExpiresAt: row.checkout_expires_at === null ? null : Number(readBigint(row.checkout_expires_at, 'order checkout expiry')),
    createdAt: Number(readBigint(row.created_at, 'order creation time')),
  };
}

function createQuoteRecord(row: QuoteRow, currentVersion: string): {
  requestHash: string;
  items: QuoteOrderItem[];
  accountPreview: CommerceQuote['accountPreview'];
  promotion: PromotionPreview | null;
  rawTotalCents: string;
  tierTotalCents: string;
  promoTotalCents: string | null;
  paidTotalCents: string;
  discountStrategy: 'term' | 'promotion_code';
} {
  const requestHash = String(row.request_hash);
  if (!/^[a-f0-9]{64}$/u.test(requestHash)) throw new TypeError('invalid commerce quote hash');
  const preview = asRecord(readJson(row.preview_snapshot, 'quote preview'));
  if (!preview) throw new TypeError('invalid commerce quote preview');
  const items = readQuoteItems(preview.items, isAlignmentInput(row.input_snapshot));
  const promotion = readPromotion(row.promotion_snapshot);
  const rawTotalCents = readSafeAmount(row.raw_total_cents, 'quote raw amount');
  const tierTotalCents = readSafeAmount(row.tier_total_cents, 'quote tier amount');
  const promoTotalCents = row.promo_total_cents === null ? null : readSafeAmount(row.promo_total_cents, 'quote promotion amount');
  const selectedTotalCents = readSafeAmount(row.selected_total_cents, 'quote selected amount');
  const { paidTotalCents, discountStrategy } = validateQuotePricing({
    pricingVersion: row.pricing_version,
    currency: row.currency,
    items,
    rawTotalCents,
    tierTotalCents,
    promoTotalCents,
    selectedTotalCents,
    discountStrategy: row.discount_strategy,
    promotion,
  }, currentVersion);
  return {
    requestHash,
    items,
    accountPreview: readAccountPreview(preview),
    promotion,
    rawTotalCents,
    tierTotalCents,
    promoTotalCents,
    paidTotalCents,
    discountStrategy,
  };
}

function safeDbAmount(value: string): string {
  const amount = BigInt(value);
  if (amount < 0n || amount > MAX_CENTS) throw new TypeError('invalid commerce order amount');
  return amount.toString();
}

async function loadOrderByKey(tx: CommerceTransaction, userId: string, keyDigest: string): Promise<StoredCommerceOrder | null> {
  const row = await tx.first<OrderRow>(
    `SELECT id, user_id, quote_id, request_hash, confirmation_idempotency_key, stripe_account_id, stripe_livemode, pricing_version, currency,
            items_snapshot, preview_snapshot, raw_total_cents, tier_total_cents, promo_total_cents, paid_total_cents,
            discount_strategy, promotion_snapshot, checkout_state, stripe_checkout_session_id, checkout_expires_at, created_at
       FROM commerce_orders
      WHERE user_id = ? AND confirmation_idempotency_key = ?
      LIMIT 1 FOR UPDATE`,
    [userId, keyDigest],
  );
  return row ? readOrderRow(row) : null;
}

function orderInsertValues(input: {
  userId: string;
  quoteId: string;
  stripeAccountId: string;
  livemode: boolean;
  quote: ReturnType<typeof createQuoteRecord>;
  orderItems: StoredOrderItem[];
  paymentMethodConfigurationId: string;
  siteOrigin: string;
  pricingVersion: string;
  confirmationKeyDigest: string;
  createdAt: number;
}): unknown[] {
  return [input.userId, input.quoteId, input.stripeAccountId, input.livemode ? 1 : 0, 'CNY',
    JSON.stringify(input.orderItems), input.pricingVersion,
    safeDbAmount(input.quote.rawTotalCents), safeDbAmount(input.quote.tierTotalCents),
    input.quote.promoTotalCents === null ? null : safeDbAmount(input.quote.promoTotalCents),
    safeDbAmount(input.quote.paidTotalCents), input.quote.discountStrategy,
    input.quote.promotion === null ? null : JSON.stringify(input.quote.promotion),
    JSON.stringify({ accountPreview: input.quote.accountPreview, paymentMethodConfigurationId: input.paymentMethodConfigurationId, checkoutSiteOrigin: input.siteOrigin }), input.confirmationKeyDigest,
    input.quote.requestHash, input.createdAt, input.createdAt];
}

async function insertOrder(tx: CommerceTransaction, input: ReserveOrderInput, quoteRow: QuoteRow): Promise<StoredCommerceOrder> {
  const orderQuote = createQuoteRecord(quoteRow, input.pricingVersion);
  const checkoutConfig = validateCheckoutConfiguration(input.siteOrigin, input.paymentMethodConfigurationId);
  const orderItems = orderQuote.items.map((item) => {
    const stripeProductId = input.productIds[item.productKey];
    if (!stripeProductId || !/^prod_[A-Za-z0-9]+$/u.test(stripeProductId)) throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
    return { ...item, stripeProductId };
  });
  const alignment = orderQuote.items.some((item) => item.operation === 'ALIGN');
  await tx.run(
    `INSERT INTO commerce_orders
       (user_id, quote_id, stripe_account_id, stripe_livemode, currency, items_snapshot, pricing_version,
        raw_total_cents, tier_total_cents, promo_total_cents, paid_total_cents, discount_strategy,
        promotion_snapshot, preview_snapshot, confirmation_idempotency_key, request_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orderInsertValues({ ...input, quote: orderQuote, orderItems, ...checkoutConfig, createdAt: input.now }),
  );
  const orderId = await readLastInsertId(tx);
  for (const item of orderItems) {
    const operation = alignment ? 'ALIGN' : item.operation;
    await tx.run(
      `INSERT INTO commerce_order_items
         (order_id, ordinal, product_key, resource, operation, target_unit_id, target_entitlement_id, target_ref,
          duration_ms, raw_cents, tier_percent, tier_cents, paid_cents, expected_starts_at, expected_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, item.ordinal, item.productKey, item.productKey, operation, item.targetUnitId, item.targetEntitlementId, null,
        item.durationMs, item.rawCents, item.discountPercent, item.tierCents, item.paidCents,
        item.expectedStartsAt, item.expectedExpiresAt, input.now],
    );
  }
  return {
    orderId, userId: input.userId, quoteId: input.quoteId,
    requestHash: orderQuote.requestHash, confirmationKeyDigest: input.confirmationKeyDigest,
    pricingVersion: input.pricingVersion, stripeAccountId: input.stripeAccountId, livemode: input.livemode,
    currency: 'CNY', items: orderItems,
    accountPreview: orderQuote.accountPreview, rawTotalCents: orderQuote.rawTotalCents,
    tierTotalCents: orderQuote.tierTotalCents, promoTotalCents: orderQuote.promoTotalCents,
    paidTotalCents: orderQuote.paidTotalCents, discountStrategy: orderQuote.discountStrategy,
    promotion: orderQuote.promotion,
    paymentMethodConfigurationId: checkoutConfig.paymentMethodConfigurationId,
    siteOrigin: checkoutConfig.siteOrigin,
    checkoutState: 'creating', stripeCheckoutSessionId: null,
    checkoutExpiresAt: null, createdAt: input.now,
  };
}

export function createOrderRepository(database: MysqlDatabase): OrderRepository {
  const commerceRepository: CommerceRepository = createCommerceRepository(database);
  return {
    reserveOrder(input) {
      const userId = assertCommerceId(input.userId);
      const quoteId = assertCommerceId(input.quoteId);
      if (!/^[a-f0-9]{64}$/u.test(input.confirmationKeyDigest)
        || !/^acct_[A-Za-z0-9]+$/u.test(input.stripeAccountId)
        || !/^[A-Za-z0-9._-]{1,32}$/u.test(input.pricingVersion)
        || !Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError('invalid commerce order input');
      const checkoutConfig = validateCheckoutConfiguration(input.siteOrigin, input.paymentMethodConfigurationId);
      return commerceRepository.transaction(async (tx) => {
        if (!await tx.lockUser(userId)) throw new CommerceOrderError('COMMERCE_QUOTE_UNAVAILABLE');
        const quoteRow = await tx.first<QuoteRow>(
          `SELECT id, user_id, pricing_version, currency, request_hash, input_snapshot, preview_snapshot,
                  raw_total_cents, tier_total_cents, promo_total_cents, selected_total_cents,
                  discount_strategy, promotion_snapshot, created_at, expires_at
             FROM commerce_quotes
            WHERE id = ? AND user_id = ?
            LIMIT 1 FOR UPDATE`,
          [quoteId, userId],
        );
        if (!quoteRow) throw new CommerceOrderError('COMMERCE_QUOTE_UNAVAILABLE');

        const byKey = await loadOrderByKey(tx, userId, input.confirmationKeyDigest);
        if (byKey) {
          if (byKey.requestHash !== String(quoteRow.request_hash)) throw new CommerceOrderError('COMMERCE_IDEMPOTENCY_CONFLICT');
          return byKey;
        }
        const byQuoteRow = await tx.first<OrderRow>(
          `SELECT id, user_id, quote_id, request_hash, confirmation_idempotency_key, stripe_account_id, stripe_livemode, pricing_version, currency,
                  items_snapshot, preview_snapshot, raw_total_cents, tier_total_cents, promo_total_cents, paid_total_cents,
                  discount_strategy, promotion_snapshot, checkout_state, stripe_checkout_session_id, checkout_expires_at, created_at
             FROM commerce_orders
            WHERE quote_id = ? AND user_id = ?
            LIMIT 1 FOR UPDATE`,
          [quoteId, userId],
        );
        if (byQuoteRow) {
          const existing = readOrderRow(byQuoteRow);
          if (existing.requestHash !== String(quoteRow.request_hash)) throw new CommerceOrderError('COMMERCE_IDEMPOTENCY_CONFLICT');
          return existing;
        }
        if (Number(readBigint(quoteRow.expires_at, 'quote expiry')) <= input.now) throw new CommerceOrderError('COMMERCE_QUOTE_EXPIRED');
        return insertOrder(tx, { ...input, ...checkoutConfig }, quoteRow);
      });
    },
    async prepareCheckout(orderIdInput, proposedExpiry, updatedAt) {
      const orderId = assertCommerceId(orderIdInput);
      if (!Number.isSafeInteger(proposedExpiry) || proposedExpiry <= 0 || proposedExpiry % 1000 !== 0
        || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new RangeError('invalid commerce checkout expiry');
      return commerceRepository.transaction(async (tx) => {
        await tx.run(
          `UPDATE commerce_orders
              SET checkout_expires_at = COALESCE(checkout_expires_at, ?), updated_at = ?
            WHERE id = ? AND checkout_state IN ('creating', 'failed')`,
          [proposedExpiry, updatedAt, orderId],
        );
        const row = await tx.first<{ checkout_expires_at: string | number | bigint | null }>(
          'SELECT checkout_expires_at FROM commerce_orders WHERE id = ? LIMIT 1', [orderId],
        );
        if (!row || row.checkout_expires_at === null) throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
        return Number(readBigint(row.checkout_expires_at, 'order checkout expiry'));
      });
    },
    async markCheckoutReady(orderIdInput, session, updatedAt) {
      const orderId = assertCommerceId(orderIdInput);
      await commerceRepository.transaction(async (tx) => {
        await tx.run(
          `UPDATE commerce_orders
              SET checkout_state = 'ready', stripe_checkout_session_id = ?, checkout_expires_at = ?, updated_at = ?
            WHERE id = ? AND checkout_state IN ('creating', 'failed')
              AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ?)`,
          [session.sessionId, session.expiresAt, updatedAt, orderId, session.sessionId],
        );
      });
    },
    async markCheckoutFailed(orderIdInput, updatedAt) {
      const orderId = assertCommerceId(orderIdInput);
      await commerceRepository.transaction(async (tx) => {
        await tx.run(
          `UPDATE commerce_orders SET checkout_state = 'failed', updated_at = ?
            WHERE id = ? AND checkout_state = 'creating'`,
          [updatedAt, orderId],
        );
      });
    },
    async markCheckoutExpired(orderIdInput, updatedAt) {
      const orderId = assertCommerceId(orderIdInput);
      await commerceRepository.transaction(async (tx) => {
        await tx.run(
          `UPDATE commerce_orders SET checkout_state = 'expired', updated_at = ?
            WHERE id = ? AND checkout_state IN ('creating', 'ready', 'failed')`,
          [updatedAt, orderId],
        );
      });
    },
  };
}

async function digestIdempotencyKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildPriceLines(order: StoredCommerceOrder): CheckoutPriceLine[] {
  const lines = groupStripeCommerceLines(order.items.map((item) => ({
    productKey: item.productKey,
    productId: item.stripeProductId,
    description: `${item.productKey}:${item.durationMs}`,
    rawUnitAmountCents: Number(item.rawCents),
    tierUnitAmountCents: Number(item.tierCents),
    durationMs: item.durationMs,
    quantity: 1,
  })));
  return lines.map(({ productKey, productId, rawUnitAmountCents, tierUnitAmountCents, quantity }) => {
    const amountCents = BigInt(order.discountStrategy === 'promotion_code' ? rawUnitAmountCents : tierUnitAmountCents);
    if (!productId || !/^prod_[A-Za-z0-9]+$/u.test(productId) || amountCents <= 0n || amountCents > MAX_CENTS) {
      throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
    }
    return { productKey, productId, amountCents: Number(amountCents), quantity };
  });
}

function validateOrder(order: StoredCommerceOrder, userId: string, dependencies: OrderDependencies): void {
  if (order.userId !== userId || !/^[a-f0-9]{64}$/u.test(order.requestHash)
    || !/^[a-f0-9]{64}$/u.test(order.confirmationKeyDigest)
    || order.currency !== 'CNY' || !Number.isSafeInteger(order.createdAt) || order.createdAt < 0
    || order.stripeAccountId !== dependencies.stripeAccountId || order.livemode !== dependencies.livemode) {
    throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
  }
  validateCheckoutConfiguration(order.siteOrigin, order.paymentMethodConfigurationId);
  validateQuoteTotals({
    pricingVersion: order.pricingVersion,
    currency: order.currency,
    items: order.items,
    rawTotalCents: order.rawTotalCents,
    tierTotalCents: order.tierTotalCents,
    promoTotalCents: order.promoTotalCents,
    selectedTotalCents: order.paidTotalCents,
    discountStrategy: order.discountStrategy,
    promotion: order.promotion,
  });
}

function proposeCheckoutExpiry(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
  return Math.ceil(now / 1000) * 1000 + CHECKOUT_TTL_MS + CHECKOUT_CREATION_MARGIN_MS;
}

export async function createOrderAndCheckout(
  input: { userId: string; quoteId: string; idempotencyKey: string },
  dependencies: OrderDependencies,
): Promise<CheckoutOrderResult> {
  let userId: string;
  let quoteId: string;
  try {
    userId = assertCommerceId(input.userId);
    quoteId = assertCommerceId(input.quoteId);
  } catch {
    throw new CommerceOrderError('COMMERCE_QUOTE_UNAVAILABLE');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255
    || !/^[\x21-\x7e]+$/u.test(input.idempotencyKey)) throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
  const keyDigest = await digestIdempotencyKey(input.idempotencyKey);
  const now = dependencies.now();
  const order = await dependencies.repository.reserveOrder({
    userId, quoteId, confirmationKeyDigest: keyDigest,
    pricingVersion: dependencies.pricingVersion,
    stripeAccountId: dependencies.stripeAccountId,
    livemode: dependencies.livemode,
    paymentMethodConfigurationId: dependencies.paymentMethodConfigurationId,
    productIds: dependencies.productIds,
    siteOrigin: dependencies.siteOrigin,
    now,
  });
  validateOrder(order, userId, dependencies);
  if (order.checkoutState === 'expired') throw new CommerceOrderError('COMMERCE_ORDER_EXPIRED');

  const checkoutDependencies = {
    stripe: dependencies.stripe,
    stripeAccountId: order.stripeAccountId,
    livemode: order.livemode,
    paymentMethodConfigurationId: order.paymentMethodConfigurationId,
    siteOrigin: order.siteOrigin,
  };

  if (order.checkoutState === 'ready') {
    if (!order.stripeCheckoutSessionId || !order.checkoutExpiresAt) throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
    if (order.checkoutExpiresAt <= now) {
      await dependencies.repository.markCheckoutExpired(order.orderId, now);
      throw new CommerceOrderError('COMMERCE_ORDER_EXPIRED');
    }
    let existingSession;
    try {
      existingSession = await retrieveCheckoutSession(order.stripeCheckoutSessionId, order.checkoutExpiresAt, checkoutDependencies);
    } catch {
      throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
    }
    if (existingSession.status === 'expired' || existingSession.expiresAt <= now) {
      await dependencies.repository.markCheckoutExpired(order.orderId, now);
      throw new CommerceOrderError('COMMERCE_ORDER_EXPIRED');
    }
    return {
      orderId: order.orderId,
      checkoutUrl: existingSession.checkoutUrl,
      expiresAt: existingSession.expiresAt,
      paymentStatus: existingSession.paymentStatus,
    };
  }

  if (order.checkoutExpiresAt !== null && order.checkoutExpiresAt <= dependencies.now()) {
    await dependencies.repository.markCheckoutExpired(order.orderId, dependencies.now());
    throw new CommerceOrderError('COMMERCE_ORDER_EXPIRED');
  }

  let customerId: string;
  try {
    customerId = await dependencies.ensureCustomer(userId);
  } catch {
    await dependencies.repository.markCheckoutFailed(order.orderId, dependencies.now());
    throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
  }

  const checkoutStartedAt = dependencies.now();
  const expiresAt = order.checkoutExpiresAt ?? await dependencies.repository.prepareCheckout(
    order.orderId, proposeCheckoutExpiry(checkoutStartedAt), checkoutStartedAt,
  );
  if (expiresAt <= now) {
    await dependencies.repository.markCheckoutExpired(order.orderId, now);
    throw new CommerceOrderError('COMMERCE_ORDER_EXPIRED');
  }

  let session: CheckoutSessionSnapshot;
  try {
    session = await createCheckoutSession({
      orderId: order.orderId,
      customerId,
      confirmationKeyDigest: order.confirmationKeyDigest,
      currency: order.currency,
      lineItems: buildPriceLines(order),
      promotionCodeId: order.discountStrategy === 'promotion_code' ? order.promotion?.promotionCodeId ?? null : null,
      expiresAt,
    }, checkoutDependencies);
  } catch (error) {
    await dependencies.repository.markCheckoutFailed(order.orderId, dependencies.now());
    if (error instanceof CommerceOrderError) throw error;
    throw new CommerceOrderError('COMMERCE_ORDER_UNAVAILABLE');
  }
  if (session.status === 'expired' || session.expiresAt <= dependencies.now()) {
    await dependencies.repository.markCheckoutExpired(order.orderId, dependencies.now());
    throw new CommerceOrderError('COMMERCE_ORDER_EXPIRED');
  }
  await dependencies.repository.markCheckoutReady(order.orderId, session, dependencies.now());
  return {
    orderId: order.orderId,
    checkoutUrl: session.checkoutUrl,
    expiresAt: session.expiresAt,
    paymentStatus: session.paymentStatus,
  };
}
