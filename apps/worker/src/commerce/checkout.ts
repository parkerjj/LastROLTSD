import type { CommerceProductKey } from '@lastroweb/commerce';
import type { StripeClient, StripeForm } from './stripe-client';
import { MAX_STRIPE_CHECKOUT_LINE_ITEMS } from './line-items';

export interface CheckoutPriceLine {
  productKey: CommerceProductKey;
  productId: string;
  amountCents: number;
  quantity: number;
}

export interface CheckoutSessionSnapshot {
  sessionId: string;
  checkoutUrl: string | null;
  expiresAt: number;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'unpaid' | 'paid' | 'no_payment_required';
}

export interface CreateCheckoutSessionInput {
  orderId: string;
  customerId: string;
  confirmationKeyDigest: string;
  currency: 'CNY';
  lineItems: readonly CheckoutPriceLine[];
  promotionCodeId: string | null;
  expiresAt: number;
}

export interface CheckoutSessionDependencies {
  stripe: StripeClient;
  stripeAccountId: string;
  livemode: boolean;
  paymentMethodConfigurationId: string;
  siteOrigin: string;
}

export class CommerceCheckoutError extends Error {
  constructor() {
    super('Stripe Checkout 暂不可用，请稍后重试');
    this.name = 'CommerceCheckoutError';
  }
}

function validUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new CommerceCheckoutError();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password) {
      throw new CommerceCheckoutError();
    }
    return url.toString();
  } catch {
    throw new CommerceCheckoutError();
  }
}

function readSession(
  value: unknown,
  expected: { expiresAt: number; livemode: boolean },
): CheckoutSessionSnapshot {
  if (!value || typeof value !== 'object') throw new CommerceCheckoutError();
  const session = value as Record<string, unknown>;
  if (typeof session.id !== 'string' || !/^cs_[A-Za-z0-9_]+$/u.test(session.id)
    || session.livemode !== expected.livemode
    || !Number.isSafeInteger(session.expires_at)
    || Number(session.expires_at) * 1000 !== expected.expiresAt
    || (session.status !== 'open' && session.status !== 'complete' && session.status !== 'expired')
    || (session.payment_status !== 'unpaid' && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required')) {
    throw new CommerceCheckoutError();
  }
  const checkoutUrl = validUrl(session.url);
  if (!checkoutUrl && session.status !== 'complete' && session.status !== 'expired') {
    throw new CommerceCheckoutError();
  }
  return {
    sessionId: session.id,
    checkoutUrl,
    expiresAt: Number(session.expires_at) * 1000,
    status: session.status,
    paymentStatus: session.payment_status,
  };
}

function integrationIdentifier(confirmationKeyDigest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(confirmationKeyDigest)) throw new CommerceCheckoutError();
  const suffix = [...confirmationKeyDigest.slice(0, 8)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('');
  return `ltsd-ke-commerce-${suffix}`;
}

function checkoutUrls(siteOrigin: string, orderId: string): { successUrl: string; cancelUrl: string } {
  let origin: URL;
  try {
    origin = new URL(siteOrigin);
  } catch {
    throw new CommerceCheckoutError();
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new CommerceCheckoutError();
  }
  const base = `${origin.origin}/ke/buy`;
  return {
    successUrl: `${base}?checkout=success&order_id=${encodeURIComponent(orderId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}?checkout=cancelled&order_id=${encodeURIComponent(orderId)}`,
  };
}

function validateCheckoutInput(input: CreateCheckoutSessionInput, dependencies: CheckoutSessionDependencies): void {
  if (!/^[1-9]\d{0,19}$/u.test(input.orderId)
    || !/^cus_[A-Za-z0-9]+$/u.test(input.customerId)
    || !/^acct_[A-Za-z0-9]+$/u.test(dependencies.stripeAccountId)
    || !/^pmc_[A-Za-z0-9]+$/u.test(dependencies.paymentMethodConfigurationId)
    || !/^[a-f0-9]{64}$/u.test(input.confirmationKeyDigest)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0 || input.expiresAt % 1000 !== 0
    || input.lineItems.length === 0 || input.lineItems.length > MAX_STRIPE_CHECKOUT_LINE_ITEMS) {
    throw new CommerceCheckoutError();
  }
  if (input.promotionCodeId !== null && !/^promo_[A-Za-z0-9]+$/u.test(input.promotionCodeId)) {
    throw new CommerceCheckoutError();
  }
  const products = new Map<CommerceProductKey, string>();
  for (const item of input.lineItems) {
    const configuredProductId = products.get(item.productKey);
    if ((item.productKey !== 'slots' && item.productKey !== 'module:standalone')
      || !/^prod_[A-Za-z0-9]+$/u.test(item.productId)
      || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1
      || (configuredProductId !== undefined && configuredProductId !== item.productId)) {
      throw new CommerceCheckoutError();
    }
    products.set(item.productKey, item.productId);
  }
}

function requestParameters(input: CreateCheckoutSessionInput, dependencies: CheckoutSessionDependencies): StripeForm {
  validateCheckoutInput(input, dependencies);
  const urls = checkoutUrls(dependencies.siteOrigin, input.orderId);
  const metadata = { ltsd_commerce_order_id: input.orderId };
  return {
    mode: 'payment',
    customer: input.customerId,
    client_reference_id: input.orderId,
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    expires_at: input.expiresAt / 1000,
    line_items: input.lineItems.map((item) => ({
      price_data: {
        currency: input.currency.toLowerCase(),
        product: item.productId,
        unit_amount: item.amountCents,
      },
      quantity: item.quantity,
    })),
    payment_method_configuration: dependencies.paymentMethodConfigurationId,
    managed_payments: { enabled: false },
    adaptive_pricing: { enabled: false },
    ...(input.promotionCodeId
      ? { discounts: [{ promotion_code: input.promotionCodeId }] }
      : { allow_promotion_codes: false }),
    metadata,
    payment_intent_data: { metadata },
    integration_identifier: integrationIdentifier(input.confirmationKeyDigest),
  };
}

function stripeIdempotencyKey(input: CreateCheckoutSessionInput, dependencies: CheckoutSessionDependencies): string {
  return `ke-commerce:checkout:v1:${dependencies.livemode ? 'live' : 'test'}:${dependencies.stripeAccountId}:${input.orderId}`;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  dependencies: CheckoutSessionDependencies,
): Promise<CheckoutSessionSnapshot> {
  const response = await dependencies.stripe.post<unknown>(
    '/checkout/sessions',
    requestParameters(input, dependencies),
    { idempotencyKey: stripeIdempotencyKey(input, dependencies) },
  );
  return readSession(response, { expiresAt: input.expiresAt, livemode: dependencies.livemode });
}

export async function retrieveCheckoutSession(
  sessionId: string,
  expectedExpiresAt: number,
  dependencies: CheckoutSessionDependencies,
): Promise<CheckoutSessionSnapshot> {
  if (!/^cs_[A-Za-z0-9_]+$/u.test(sessionId)) throw new CommerceCheckoutError();
  const response = await dependencies.stripe.get<unknown>(`/checkout/sessions/${sessionId}`);
  const session = readSession(response, { expiresAt: expectedExpiresAt, livemode: dependencies.livemode });
  if (session.sessionId !== sessionId) throw new CommerceCheckoutError();
  return session;
}
