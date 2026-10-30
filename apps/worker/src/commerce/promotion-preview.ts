import type { StripeClient } from './stripe-client';
import { StripeRequestError, type StripeForm } from './stripe-client';

export interface StripePreviewItem {
  productId: string;
  description: string;
  amountCents: number;
}

export interface PromotionPreview {
  promotionCodeId: string;
  couponId: string;
  subtotalCents: number;
  totalCents: number;
  discountCents: number;
  currency: 'cny';
}

interface StripePromotionCode {
  id?: unknown;
  code?: unknown;
  active?: unknown;
  customer?: unknown;
  coupon?: unknown;
}

interface StripeCoupon {
  id?: unknown;
  valid?: unknown;
}

interface StripeInvoicePreview {
  currency?: unknown;
  subtotal?: unknown;
  total?: unknown;
}

export class PromotionCodeError extends Error {
  constructor() {
    super('优惠码无效或不适用于此订单');
    this.name = 'PromotionCodeError';
  }
}

function objectId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function customerId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return objectId(value);
}

function safeAmount(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function matchesCode(code: StripePromotionCode, requestedCode: string, expectedCustomerId: string): boolean {
  if (code.active !== true || typeof code.code !== 'string' || code.code.toLowerCase() !== requestedCode.toLowerCase()) return false;
  const restrictedCustomer = customerId(code.customer);
  return restrictedCustomer === null || restrictedCustomer === expectedCustomerId;
}

function selectPromotion(codes: readonly StripePromotionCode[], requestedCode: string, customerIdValue: string): { id: string; couponId: string } {
  const candidates = codes.filter((code) => matchesCode(code, requestedCode, customerIdValue));
  candidates.sort((left, right) => Number(customerId(right.customer) === customerIdValue) - Number(customerId(left.customer) === customerIdValue));
  for (const candidate of candidates) {
    const promotionCodeId = objectId(candidate.id);
    const couponId = objectId(candidate.coupon);
    if (!promotionCodeId || !couponId) continue;
    const expandedCoupon = candidate.coupon && typeof candidate.coupon === 'object' ? candidate.coupon as StripeCoupon : null;
    if (expandedCoupon?.valid === false) continue;
    return { id: promotionCodeId, couponId };
  }
  throw new PromotionCodeError();
}

export async function previewPromotion(
  input: {
    customerId: string;
    items: readonly StripePreviewItem[];
    promotionCode: string;
  },
  stripe: StripeClient,
): Promise<PromotionPreview> {
  const customer = input.customerId.trim();
  const promotionCode = input.promotionCode.trim();
  if (!/^cus_[A-Za-z0-9]+$/u.test(customer) || promotionCode.length < 1 || promotionCode.length > 100 || input.items.length < 1 || input.items.length > 1000) {
    throw new PromotionCodeError();
  }
  const groupedItems = new Map<string, StripePreviewItem>();
  let expectedSubtotalCents = 0;
  for (const item of input.items) {
    if (!/^prod_[A-Za-z0-9]+$/u.test(item.productId) || !item.description.trim() || item.description.length > 500 || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) {
      throw new PromotionCodeError();
    }
    expectedSubtotalCents += item.amountCents;
    if (!Number.isSafeInteger(expectedSubtotalCents)) throw new PromotionCodeError();
    const groupKey = JSON.stringify([item.productId, item.description]);
    const existing = groupedItems.get(groupKey);
    const amountCents = (existing?.amountCents ?? 0) + item.amountCents;
    if (!Number.isSafeInteger(amountCents)) throw new PromotionCodeError();
    groupedItems.set(groupKey, { productId: item.productId, description: item.description, amountCents });
  }
  if (groupedItems.size > 250) {
    throw new PromotionCodeError();
  }

  const response = await stripe.get<{ data?: StripePromotionCode[] }>('/promotion_codes', {
    active: true,
    code: promotionCode,
    limit: 100,
  });
  const promotion = selectPromotion(Array.isArray(response.data) ? response.data : [], promotionCode, customer);
  const invoiceItems: StripeForm[] = [...groupedItems.values()].map((item) => ({
    description: item.description,
    discountable: true,
    price_data: {
      currency: 'cny',
      product: item.productId,
      unit_amount: item.amountCents,
    },
  }));

  let preview: StripeInvoicePreview;
  try {
    preview = await stripe.post<StripeInvoicePreview>('/invoices/create_preview', {
      customer,
      currency: 'cny',
      automatic_tax: { enabled: false },
      invoice_items: invoiceItems,
      discounts: [{ promotion_code: promotion.id }],
    });
  } catch (error) {
    if (error instanceof StripeRequestError && error.status === 400 && error.providerCode && /(?:coupon|promotion|discount)/iu.test(error.providerCode)) {
      throw new PromotionCodeError();
    }
    throw error;
  }

  const subtotalCents = safeAmount(preview.subtotal);
  const totalCents = safeAmount(preview.total);
  if (preview.currency !== 'cny' || subtotalCents === null || totalCents === null || subtotalCents !== expectedSubtotalCents || totalCents > subtotalCents || subtotalCents === 0 || totalCents === subtotalCents) {
    throw new PromotionCodeError();
  }

  return {
    promotionCodeId: promotion.id,
    couponId: promotion.couponId,
    subtotalCents,
    totalCents,
    discountCents: subtotalCents - totalCents,
    currency: 'cny',
  };
}
