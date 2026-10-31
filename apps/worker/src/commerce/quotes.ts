import {
  chooseDiscountStrategy,
  COMMERCE_DAY_MS,
  COMMERCE_MONTH_MS,
  getCommerceCatalog,
  priceLineCents,
  tierForDuration,
  type CommerceProduct,
  type CommerceProductKey,
} from '@lastroweb/commerce';
import type { CommerceUnit } from './unit-repository';
import { assertCommerceId } from './repository';
import type { PromotionPreview, StripePreviewItem } from './promotion-preview';
import { PromotionCodeError } from './promotion-preview';
import type { CommerceTermDays, QuoteSelection } from './quote-input';

const QUOTE_TTL_MS = 2 * 60 * 1000;
const MAX_QUOTE_ITEMS = 1000;
const ALIGNMENT_MINIMUM_SPREAD_MS = COMMERCE_DAY_MS;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface QuoteEntitlement {
  id: string;
  unitId: string | null;
  resource: string;
  quantity: number;
  startsAt: bigint;
  expiresAt: bigint;
  source: string;
  sourceRef: string | null;
}

export interface QuoteAccountState {
  slotUnits: CommerceUnit[];
  entitlements: QuoteEntitlement[];
  effective: { slots: number; modules: ReadonlySet<string> };
}

export interface QuotePreviewEntitlement {
  entitlementId: string | null;
  unitId: string | null;
  resource: string;
  quantity: number;
  startsAt: string;
  expiresAt: string;
  productKey: CommerceProductKey | null;
  isGift: boolean;
  isNew?: boolean;
}

export interface CommerceQuoteItem {
  ordinal: number;
  productKey: CommerceProductKey;
  operation: 'ADD' | 'RENEW';
  targetUnitId: string | null;
  targetEntitlementId: string | null;
  durationMs: string;
  expectedStartsAt: string;
  expectedExpiresAt: string;
  discountPercent: 100 | 80 | 70;
  rawCents: string;
  tierCents: string;
  paidCents: string;
}

export interface CommerceQuote {
  quoteId: string;
  pricingVersion: string;
  currency: 'CNY';
  createdAt: string;
  expiresAt: string;
  requestHash: string;
  items: CommerceQuoteItem[];
  accountPreview: {
    before: { entitlements: QuotePreviewEntitlement[]; effective: { slots: number; modules: string[] } };
    after: { entitlements: QuotePreviewEntitlement[]; effective: { slots: number; modules: string[] } };
  };
  rawTotalCents: string;
  tierTotalCents: string;
  promoTotalCents: string | null;
  selectedTotalCents: string;
  discountStrategy: 'term' | 'promotion_code';
  promotion: PromotionPreview | null;
}

export interface QuotePersistenceRecord {
  userId: string;
  pricingVersion: string;
  currency: 'CNY';
  requestHash: string;
  inputSnapshot: Record<string, unknown>;
  previewSnapshot: Record<string, unknown>;
  rawTotalCents: bigint;
  tierTotalCents: bigint;
  promoTotalCents: bigint | null;
  selectedTotalCents: bigint;
  discountStrategy: 'term' | 'promotion_code';
  promotionSnapshot: PromotionPreview | null;
  createdAt: number;
  expiresAt: number;
}

export interface QuoteRepository {
  readAccount(userId: string, now: number): Promise<QuoteAccountState>;
  insertQuote(record: QuotePersistenceRecord): Promise<string>;
}

export interface QuoteDependencies {
  repository: QuoteRepository;
  pricingVersion: string;
  now: () => number;
  productIds: Partial<Record<CommerceProductKey, string>>;
  validateStripeConfiguration?: () => Promise<void>;
  previewPromotion?: (promotionCode: string, items: readonly StripePreviewItem[], userId: string) => Promise<PromotionPreview>;
}

export type CommerceQuoteErrorCode =
  | 'COMMERCE_SELECTION_INVALID'
  | 'COMMERCE_NO_RENEWABLE_SLOTS'
  | 'COMMERCE_TARGET_UNAVAILABLE'
  | 'COMMERCE_NO_CHARGEABLE_ITEMS'
  | 'COMMERCE_ALIGN_NOT_NEEDED'
  | 'COMMERCE_ITEM_LIMIT'
  | 'COMMERCE_PROMOTION_INVALID'
  | 'COMMERCE_PROMOTION_UNAVAILABLE';

export class CommerceQuoteError extends Error {
  constructor(public readonly code: CommerceQuoteErrorCode) {
    super(code);
    this.name = 'CommerceQuoteError';
  }
}

interface PendingQuoteItem {
  ordinal: number;
  product: CommerceProduct;
  productKey: CommerceProductKey;
  operation: 'ADD' | 'RENEW';
  targetUnitId: string | null;
  targetEntitlementId: string | null;
  durationMs: bigint;
  expectedStartsAt: bigint;
  expectedExpiresAt: bigint;
  discountPercent: 100 | 80 | 70;
  rawCents: bigint;
  tierCents: bigint;
  paidCents: bigint;
}

function invalidSelection(): never {
  throw new CommerceQuoteError('COMMERCE_SELECTION_INVALID');
}

function isTermDays(value: number): value is CommerceTermDays {
  return value === 30 || value === 90 || value === 180 || value === 360;
}

function validateSelection(selection: readonly QuoteSelection[]): void {
  if (!Array.isArray(selection) || selection.length < 1 || selection.length > 2) invalidSelection();
  const types = selection.map((item) => item?.type);
  if (types.some((type) => !['slot_add', 'slot_renew', 'standalone', 'align_all_paid'].includes(type))
    || new Set(types).size !== types.length
    || types.filter((type) => type === 'slot_add' || type === 'slot_renew' || type === 'align_all_paid').length > 1
    || (types.includes('align_all_paid') && selection.length !== 1)) invalidSelection();

  for (const item of selection) {
    if (!item || !isTermDays(item.termDays)) invalidSelection();
    if (item.type === 'slot_add') {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) invalidSelection();
      if (item.quantity > MAX_QUOTE_ITEMS) throw new CommerceQuoteError('COMMERCE_ITEM_LIMIT');
    }
    if (item.type === 'slot_renew') {
      if (!Array.isArray(item.unitIds)) invalidSelection();
      if (item.unitIds.length > MAX_QUOTE_ITEMS) throw new CommerceQuoteError('COMMERCE_ITEM_LIMIT');
      let ids: string[];
      try {
        ids = item.unitIds.map((id) => assertCommerceId(id));
      } catch {
        invalidSelection();
      }
      if (new Set(ids).size !== ids.length) invalidSelection();
    }
  }

  const requestedUnits = selection.reduce((total, item) => total + (item.type === 'slot_add' ? item.quantity : item.type === 'slot_renew' ? item.unitIds.length : 0), 0)
    + Number(types.includes('standalone'));
  if (requestedUnits > MAX_QUOTE_ITEMS) throw new CommerceQuoteError('COMMERCE_ITEM_LIMIT');
}

function productFor(products: readonly CommerceProduct[], key: CommerceProductKey): CommerceProduct {
  const product = products.find((candidate) => candidate.key === key);
  if (!product) throw new Error('commerce product missing');
  return product;
}

function isPermanentGiftEntitlement(row: Pick<QuoteEntitlement, 'resource' | 'source' | 'sourceRef'>): boolean {
  return (row.resource === 'slots' && row.source === 'signup' && row.sourceRef === 'email-verified:slots')
    || (row.resource === 'module:core' && row.source === 'signup' && row.sourceRef === 'email-verified:module:core')
    || (row.resource === 'module:standalone' && row.source === 'signup' && row.sourceRef === 'email-verified:module:standalone');
}

function currentEntitlementPreview(state: QuoteAccountState): QuotePreviewEntitlement[] {
  const unitsByEntitlement = new Map(state.slotUnits.map((unit) => [unit.keEntitlementId, unit.unitId]));
  return state.entitlements.map((row) => ({
    entitlementId: row.id,
    unitId: row.unitId ?? unitsByEntitlement.get(row.id) ?? null,
    resource: row.resource,
    quantity: row.quantity,
    startsAt: String(row.startsAt),
    expiresAt: String(row.expiresAt),
    productKey: row.resource === 'slots' || row.resource === 'module:standalone' ? row.resource : null,
    isGift: isPermanentGiftEntitlement(row),
  }));
}

function safeCents(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) throw new CommerceQuoteError('COMMERCE_ITEM_LIMIT');
  return Number(value);
}

function formatDuration(durationMs: bigint): string {
  const dayMs = COMMERCE_DAY_MS;
  const days = durationMs / dayMs;
  const hours = (durationMs % dayMs) / (60n * 60n * 1000n);
  const minutes = (durationMs % (60n * 60n * 1000n)) / (60n * 1000n);
  return `${days}天${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分钟` : ''}`;
}

function createPendingItem(input: {
  ordinal: number;
  product: CommerceProduct;
  productKey: CommerceProductKey;
  operation: 'ADD' | 'RENEW';
  targetUnitId?: string | null;
  targetEntitlementId?: string | null;
  durationMs: bigint;
  expectedStartsAt: bigint;
  expectedExpiresAt: bigint;
}): PendingQuoteItem {
  const monthlyCents = BigInt(input.product.monthlyUnitPriceCents);
  const discountPercent = tierForDuration(input.durationMs);
  const rawCents = priceLineCents(monthlyCents, input.durationMs, 100);
  const tierCents = priceLineCents(monthlyCents, input.durationMs, discountPercent);
  return {
    ordinal: input.ordinal,
    product: input.product,
    productKey: input.productKey,
    operation: input.operation,
    targetUnitId: input.targetUnitId ?? null,
    targetEntitlementId: input.targetEntitlementId ?? null,
    durationMs: input.durationMs,
    expectedStartsAt: input.expectedStartsAt,
    expectedExpiresAt: input.expectedExpiresAt,
    discountPercent,
    rawCents,
    tierCents,
    paidCents: tierCents,
  };
}

function buildPendingItems(
  selection: readonly QuoteSelection[],
  state: QuoteAccountState,
  products: readonly CommerceProduct[],
  now: bigint,
): PendingQuoteItem[] {
  const items: PendingQuoteItem[] = [];
  const add = (input: Omit<Parameters<typeof createPendingItem>[0], 'ordinal'>) => {
    if (items.length >= MAX_QUOTE_ITEMS) throw new CommerceQuoteError('COMMERCE_ITEM_LIMIT');
    items.push(createPendingItem({ ...input, ordinal: items.length + 1 }));
  };

  for (const choice of selection) {
    const termMs = BigInt(choice.termDays) * COMMERCE_DAY_MS;
    if (choice.type === 'slot_add') {
      const product = productFor(products, 'slots');
      for (let count = 0; count < choice.quantity; count += 1) {
        add({ product, productKey: 'slots', operation: 'ADD', durationMs: termMs, expectedStartsAt: now, expectedExpiresAt: now + termMs });
      }
    } else if (choice.type === 'slot_renew') {
      if (choice.unitIds.length === 0) throw new CommerceQuoteError('COMMERCE_NO_RENEWABLE_SLOTS');
      const selected = choice.unitIds.map((unitId) => state.slotUnits.find((unit) => unit.unitId === unitId && unit.currentQuantity > 0
        && unit.currentStartsAt <= now && unit.currentExpiresAt > now));
      if (selected.some((unit) => !unit)) throw new CommerceQuoteError('COMMERCE_TARGET_UNAVAILABLE');
      const product = productFor(products, 'slots');
      for (const unit of selected as CommerceUnit[]) {
        add({ product, productKey: 'slots', operation: 'RENEW', targetUnitId: unit.unitId, targetEntitlementId: unit.keEntitlementId,
          durationMs: termMs, expectedStartsAt: unit.currentExpiresAt, expectedExpiresAt: unit.currentExpiresAt + termMs });
      }
    } else if (choice.type === 'standalone') {
      const product = productFor(products, 'module:standalone');
      const current = state.effective.modules.has('standalone') ? state.entitlements.filter((row) => row.resource === 'module:standalone' && row.quantity > 0
        && row.startsAt <= now && row.expiresAt > now && !(row.source === 'signup' && row.sourceRef === 'email-verified:module:standalone'))
        .sort((left, right) => left.expiresAt === right.expiresAt ? BigInt(left.id) < BigInt(right.id) ? -1 : 1 : left.expiresAt > right.expiresAt ? -1 : 1)[0] : undefined;
      add({ product, productKey: 'module:standalone', operation: current ? 'RENEW' : 'ADD',
        targetEntitlementId: current?.id ?? null, durationMs: termMs, expectedStartsAt: current?.expiresAt ?? now,
        expectedExpiresAt: (current?.expiresAt ?? now) + termMs });
    } else {
      const slots = state.slotUnits.filter((unit) => unit.currentQuantity > 0 && unit.currentStartsAt <= now && unit.currentExpiresAt > now);
      const standalone = state.effective.modules.has('standalone') ? state.entitlements.filter((row) => row.resource === 'module:standalone' && row.quantity > 0
        && row.startsAt <= now && row.expiresAt > now && !(row.source === 'signup' && row.sourceRef === 'email-verified:module:standalone'))
        .sort((left, right) => left.expiresAt === right.expiresAt ? BigInt(left.id) < BigInt(right.id) ? -1 : 1 : left.expiresAt > right.expiresAt ? -1 : 1)[0] : undefined;
      const expiries = [...slots.map((unit) => unit.currentExpiresAt), ...(standalone ? [standalone.expiresAt] : [])];
      if (expiries.length === 0) throw new CommerceQuoteError('COMMERCE_NO_CHARGEABLE_ITEMS');
      const latest = expiries.reduce((value, expiry) => expiry > value ? expiry : value);
      const earliest = expiries.reduce((value, expiry) => expiry < value ? expiry : value);
      if (latest - earliest < ALIGNMENT_MINIMUM_SPREAD_MS) throw new CommerceQuoteError('COMMERCE_ALIGN_NOT_NEEDED');
      const target = latest + termMs;
      const product = productFor(products, 'slots');
      for (const unit of slots) {
        add({ product, productKey: 'slots', operation: 'RENEW', targetUnitId: unit.unitId, targetEntitlementId: unit.keEntitlementId,
          durationMs: target - unit.currentExpiresAt, expectedStartsAt: unit.currentExpiresAt, expectedExpiresAt: target });
      }
      if (standalone) {
        const feature = productFor(products, 'module:standalone');
        add({ product: feature, productKey: 'module:standalone', operation: 'RENEW', targetEntitlementId: standalone.id,
          durationMs: target - standalone.expiresAt, expectedStartsAt: standalone.expiresAt, expectedExpiresAt: target });
      }
      if (!items.some((item) => item.durationMs > COMMERCE_MONTH_MS)) throw new CommerceQuoteError('COMMERCE_SELECTION_INVALID');
    }
  }
  if (items.length === 0) throw new CommerceQuoteError('COMMERCE_NO_CHARGEABLE_ITEMS');
  return items;
}

function allocatePromotion(items: PendingQuoteItem[], totalCents: bigint, rawTotalCents: bigint): void {
  let allocated = 0n;
  const remainders: Array<{ item: PendingQuoteItem; remainder: bigint }> = [];
  for (const item of items) {
    const numerator = item.rawCents * totalCents;
    item.paidCents = numerator / rawTotalCents;
    allocated += item.paidCents;
    remainders.push({ item, remainder: numerator % rawTotalCents });
  }
  let remaining = totalCents - allocated;
  remainders.sort((left, right) => left.remainder === right.remainder
    ? left.item.ordinal - right.item.ordinal
    : left.remainder > right.remainder ? -1 : 1);
  for (const entry of remainders) {
    if (remaining <= 0n) break;
    entry.item.paidCents += 1n;
    remaining -= 1n;
  }
  if (remaining !== 0n) throw new Error('promotion allocation failed');
}

function snapshotEntitlement(row: QuoteEntitlement): QuotePreviewEntitlement {
  return {
    entitlementId: row.id,
    unitId: row.unitId,
    resource: row.resource,
    quantity: row.quantity,
    startsAt: String(row.startsAt),
    expiresAt: String(row.expiresAt),
    productKey: row.resource === 'slots' || row.resource === 'module:standalone' ? row.resource : null,
    isGift: isPermanentGiftEntitlement(row),
  };
}

function afterPreview(state: QuoteAccountState, items: readonly PendingQuoteItem[]): QuotePreviewEntitlement[] {
  const entitlements = state.entitlements.map(snapshotEntitlement);
  for (const item of items) {
    const existing = item.targetEntitlementId ? entitlements.find((row) => row.entitlementId === item.targetEntitlementId) : undefined;
    if (existing) {
      existing.expiresAt = String(item.expectedExpiresAt);
      continue;
    }
    entitlements.push({
      entitlementId: null,
      unitId: null,
      resource: item.productKey,
      quantity: 1,
      startsAt: String(item.operation === 'ADD' ? item.expectedStartsAt : item.expectedStartsAt),
      expiresAt: String(item.expectedExpiresAt),
      productKey: item.productKey,
      isGift: false,
      isNew: true,
    });
  }
  return entitlements;
}

function toQuoteItem(item: PendingQuoteItem): CommerceQuoteItem {
  return {
    ordinal: item.ordinal,
    productKey: item.productKey,
    operation: item.operation,
    targetUnitId: item.targetUnitId,
    targetEntitlementId: item.targetEntitlementId,
    durationMs: String(item.durationMs),
    expectedStartsAt: String(item.expectedStartsAt),
    expectedExpiresAt: String(item.expectedExpiresAt),
    discountPercent: item.discountPercent,
    rawCents: String(item.rawCents),
    tierCents: String(item.tierCents),
    paidCents: String(item.paidCents),
  };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashInput(input: { selection: readonly QuoteSelection[]; promotionCode?: string }): Promise<string> {
  const canonical = JSON.stringify({ selection: input.selection, promotionCode: input.promotionCode?.toUpperCase() ?? null });
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))));
}

export async function createQuote(
  input: { userId: string; selection: QuoteSelection[]; promotionCode?: string },
  dependencies: QuoteDependencies,
): Promise<CommerceQuote> {
  let userId: string;
  try {
    userId = assertCommerceId(input.userId);
  } catch {
    invalidSelection();
  }
  validateSelection(input.selection);
  if (dependencies.validateStripeConfiguration) await dependencies.validateStripeConfiguration();
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0 || now + QUOTE_TTL_MS > Number.MAX_SAFE_INTEGER) throw new Error('invalid commerce quote timestamp');
  const catalog = getCommerceCatalog(dependencies.pricingVersion);
  const state = await dependencies.repository.readAccount(userId!, now);
  const pendingItems = buildPendingItems(input.selection, state, catalog.products, BigInt(now));
  const rawTotalCents = pendingItems.reduce((total, item) => total + item.rawCents, 0n);
  const tierTotalCents = pendingItems.reduce((total, item) => total + item.tierCents, 0n);
  safeCents(rawTotalCents);
  safeCents(tierTotalCents);

  let promotion: PromotionPreview | null = null;
  if (input.promotionCode) {
    if (!dependencies.previewPromotion) throw new CommerceQuoteError('COMMERCE_PROMOTION_UNAVAILABLE');
    const stripeItems: StripePreviewItem[] = pendingItems.map((item) => {
      const productId = dependencies.productIds[item.productKey];
      if (!productId) throw new CommerceQuoteError('COMMERCE_PROMOTION_UNAVAILABLE');
      return {
        productKey: item.productKey,
        productId,
        description: `${item.product.name}（${formatDuration(item.durationMs)}）`,
        rawUnitAmountCents: safeCents(item.rawCents),
        tierUnitAmountCents: safeCents(item.tierCents),
        durationMs: String(item.durationMs),
        quantity: 1,
      };
    });
    try {
      promotion = await dependencies.previewPromotion(input.promotionCode, stripeItems, userId!);
    } catch (error) {
      throw new CommerceQuoteError(error instanceof PromotionCodeError ? 'COMMERCE_PROMOTION_INVALID' : 'COMMERCE_PROMOTION_UNAVAILABLE');
    }
    if (promotion.currency !== 'cny' || typeof promotion.promotionCodeId !== 'string' || !promotion.promotionCodeId
      || typeof promotion.couponId !== 'string' || !promotion.couponId
      || !Number.isSafeInteger(promotion.subtotalCents) || promotion.subtotalCents <= 0
      || !Number.isSafeInteger(promotion.totalCents) || promotion.totalCents < 0 || promotion.totalCents >= promotion.subtotalCents
      || !Number.isSafeInteger(promotion.discountCents)
      || promotion.discountCents !== promotion.subtotalCents - promotion.totalCents
      || BigInt(promotion.subtotalCents) !== rawTotalCents) {
      throw new CommerceQuoteError('COMMERCE_PROMOTION_INVALID');
    }
  }
  const promoTotalCents = promotion ? BigInt(promotion.totalCents) : null;
  const discountStrategy = chooseDiscountStrategy(tierTotalCents, promoTotalCents);
  const selectedTotalCents = discountStrategy === 'promotion_code' ? promoTotalCents! : tierTotalCents;
  if (discountStrategy === 'promotion_code') allocatePromotion(pendingItems, selectedTotalCents, rawTotalCents);

  const previewEntitlements = currentEntitlementPreview(state);
  const afterEntitlements = afterPreview(state, pendingItems);
  const addedSlots = pendingItems.filter((item) => item.productKey === 'slots' && item.operation === 'ADD').length;
  const signedSlots = state.entitlements.filter((row) => row.resource === 'slots').reduce((total, row) => total + row.quantity, 0);
  const moduleQuantities = new Map<string, number>();
  for (const row of state.entitlements) {
    if (row.resource.startsWith('module:')) {
      const module = row.resource.slice('module:'.length);
      moduleQuantities.set(module, (moduleQuantities.get(module) ?? 0) + row.quantity);
    }
  }
  for (const item of pendingItems) {
    if (item.productKey.startsWith('module:') && item.operation === 'ADD') {
      const module = item.productKey.slice('module:'.length);
      moduleQuantities.set(module, (moduleQuantities.get(module) ?? 0) + 1);
    }
  }
  const afterEffective = {
    slots: Math.max(0, signedSlots + addedSlots),
    modules: [...moduleQuantities].filter(([, quantity]) => quantity > 0).map(([module]) => module).sort(),
  };
  const createdAt = now;
  const expiresAt = now + QUOTE_TTL_MS;
  const requestHash = await hashInput(input);
  const quoteItems = pendingItems.map(toQuoteItem);
  const accountPreview = {
    before: { entitlements: previewEntitlements, effective: { slots: state.effective.slots, modules: [...state.effective.modules].sort() } },
    after: { entitlements: afterEntitlements, effective: afterEffective },
  };
  const promotionSnapshot = promotion ? { ...promotion } : null;
  const quoteId = await dependencies.repository.insertQuote({
    userId,
    pricingVersion: catalog.pricingVersion,
    currency: catalog.currency,
    requestHash,
    inputSnapshot: { selection: input.selection, promotionCode: input.promotionCode?.toUpperCase() ?? null },
    previewSnapshot: { items: quoteItems, accountPreview },
    rawTotalCents,
    tierTotalCents,
    promoTotalCents,
    selectedTotalCents,
    discountStrategy,
    promotionSnapshot,
    createdAt,
    expiresAt,
  });

  return {
    quoteId,
    pricingVersion: catalog.pricingVersion,
    currency: catalog.currency,
    createdAt: String(createdAt),
    expiresAt: String(expiresAt),
    requestHash,
    items: quoteItems,
    accountPreview,
    rawTotalCents: String(rawTotalCents),
    tierTotalCents: String(tierTotalCents),
    promoTotalCents: promoTotalCents === null ? null : String(promoTotalCents),
    selectedTotalCents: String(selectedTotalCents),
    discountStrategy,
    promotion: promotionSnapshot,
  };
}
