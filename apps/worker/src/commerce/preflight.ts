import type { CommerceConfig } from '../env';
import type { StripeClient } from './stripe-client';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function matchesResource(value: unknown, expected: { id: string; livemode: boolean; active?: boolean }): boolean {
  const resource = record(value);
  return resource?.id === expected.id
    && resource.livemode === expected.livemode
    && (expected.active === undefined || resource.active === expected.active);
}

function matchesProductKey(value: unknown, expectedKey: string): boolean {
  const product = record(value);
  const metadata = record(product?.metadata);
  return metadata?.ltsd_commerce_product_key === expectedKey;
}

function matchesAccount(value: unknown, expectedId: string): boolean {
  const account = record(value);
  // Stripe's current Account object has no livemode field; the configured key prefix carries that mode.
  return account?.id === expectedId && account.object === 'account';
}

export async function verifyStripeCommerceConfiguration(config: CommerceConfig, stripe: StripeClient): Promise<void> {
  const [, slotsResult, standaloneResult, paymentConfigurationResult] = await Promise.all([
    verifyStripeAccount(config, stripe),
    stripe.get<unknown>(`/products/${encodeURIComponent(config.productIds.slots)}`),
    stripe.get<unknown>(`/products/${encodeURIComponent(config.productIds['module:standalone'])}`),
    stripe.get<unknown>(`/payment_method_configurations/${encodeURIComponent(config.paymentMethodConfigurationId)}`),
  ]);
  const paymentConfiguration = record(paymentConfigurationResult);
  const alipay = record(paymentConfiguration?.alipay);
  const displayPreference = record(alipay?.display_preference);
  if (!matchesResource(slotsResult, { id: config.productIds.slots, livemode: config.livemode, active: true })
    || !matchesProductKey(slotsResult, 'slots')
    || !matchesResource(standaloneResult, { id: config.productIds['module:standalone'], livemode: config.livemode, active: true })
    || !matchesProductKey(standaloneResult, 'module:standalone')
    || paymentConfiguration?.id !== config.paymentMethodConfigurationId
    || paymentConfiguration.active !== true
    || paymentConfiguration.livemode !== config.livemode
    || alipay?.available !== true
    || displayPreference?.value !== 'on') {
    throw new Error('commerce Stripe configuration is unavailable');
  }
}

export async function verifyStripeAccount(config: CommerceConfig, stripe: StripeClient): Promise<void> {
  const account = await stripe.get<unknown>('/account');
  if (!matchesAccount(account, config.stripeAccountId)) {
    throw new Error('commerce Stripe account is unavailable');
  }
}
