import { describe, expect, it, vi } from 'vitest';
import { resolveCommerceConfig, type AppEnv } from '../src/env';
import { verifyStripeCommerceConfiguration } from '../src/commerce/preflight';
import type { StripeClient } from '../src/commerce/stripe-client';

function testBindings(overrides: Record<string, unknown> = {}): AppEnv {
  return {
    ENVIRONMENT: 'staging',
    COMMERCE_ENABLED: 'true',
    COMMERCE_STRIPE_SECRET_KEY: 'sk_test_commercekey',
    COMMERCE_STRIPE_WEBHOOK_SECRET: `whsec_${'A'.repeat(43)}=`,
    COMMERCE_STRIPE_ACCOUNT_ID: 'acct_test',
    COMMERCE_STRIPE_LIVEMODE: 'false',
    COMMERCE_PRICING_VERSION: 'ke-commerce-2026-10-v1',
    COMMERCE_STRIPE_PRODUCT_SLOTS_ID: 'prod_slotstest',
    COMMERCE_STRIPE_PRODUCT_STANDALONE_ID: 'prod_offlinetest',
    COMMERCE_STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: 'pmc_alipaytest',
    COMMERCE_SITE_ORIGIN: 'https://staging.ltsd.example',
    ...overrides,
  } as unknown as AppEnv;
}

function mockStripe(overrides: {
  account?: Record<string, unknown>;
  products?: Record<string, Record<string, unknown>>;
  paymentConfiguration?: Record<string, unknown>;
} = {}): StripeClient {
  const values: Record<string, unknown> = {
    '/account': { id: 'acct_test', object: 'account', ...overrides.account },
    '/products/prod_slotstest': {
      id: 'prod_slotstest', object: 'product', active: true, livemode: false,
      metadata: { ltsd_commerce_product_key: 'slots' }, ...overrides.products?.slots,
    },
    '/products/prod_offlinetest': {
      id: 'prod_offlinetest', object: 'product', active: true, livemode: false,
      metadata: { ltsd_commerce_product_key: 'module:standalone' }, ...overrides.products?.offline,
    },
    '/payment_method_configurations/pmc_alipaytest': {
      id: 'pmc_alipaytest', object: 'payment_method_configuration', active: true, livemode: false,
      alipay: { available: true, display_preference: { value: 'on' } },
      ...overrides.paymentConfiguration,
    },
  };
  return {
    get: vi.fn(async (path: string) => values[path]),
    post: vi.fn(),
  } as unknown as StripeClient;
}

describe('commerce deployment configuration preflight', () => {
  it('fails closed when commerce is not fully configured even if a donation key exists', () => {
    expect(resolveCommerceConfig({
      ENVIRONMENT: 'production',
      STRIPE_SECRET_KEY: 'sk_live_donationkey',
    } as never)).toBeNull();
    expect(resolveCommerceConfig(testBindings({ COMMERCE_STRIPE_WEBHOOK_SECRET: undefined } as never))).toBeNull();
  });

  it('requires the commerce-specific key even when a donation key is configured', () => {
    expect(resolveCommerceConfig(testBindings({
      ENVIRONMENT: 'production', COMMERCE_STRIPE_LIVEMODE: 'true',
      COMMERCE_STRIPE_SECRET_KEY: undefined, STRIPE_SECRET_KEY: 'sk_live_donationkey',
      COMMERCE_STRIPE_ACCOUNT_ID: 'acct_live',
      COMMERCE_STRIPE_PRODUCT_SLOTS_ID: 'prod_slotslive',
      COMMERCE_STRIPE_PRODUCT_STANDALONE_ID: 'prod_offlinelive',
      COMMERCE_STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: 'pmc_live',
      COMMERCE_SITE_ORIGIN: 'https://ltsd.ro',
    } as never))).toBeNull();
  });

  it('uses the commerce-specific key while keeping the donation key separate', () => {
    expect(resolveCommerceConfig(testBindings({
      STRIPE_SECRET_KEY: 'sk_test_donationkey',
    } as never))).toMatchObject({
      stripeSecretKey: 'sk_test_commercekey', salesEnabled: true, livemode: false, stripeAccountId: 'acct_test',
    });
  });

  it('accepts the 64-hex signing secret emitted by Stripe CLI', () => {
    const secret = `whsec_${'a'.repeat(64)}`;

    expect(resolveCommerceConfig(testBindings({ COMMERCE_STRIPE_WEBHOOK_SECRET: secret } as never)))
      .toMatchObject({ webhookSecret: secret, salesEnabled: true, livemode: false });
  });

  it('requires the Stripe key prefix and explicit livemode to match the deployment environment', () => {
    expect(resolveCommerceConfig(testBindings({ COMMERCE_STRIPE_LIVEMODE: 'true' } as never))).toBeNull();
    expect(resolveCommerceConfig(testBindings({ COMMERCE_STRIPE_SECRET_KEY: 'sk_live_commerce_key' } as never))).toBeNull();
    expect(resolveCommerceConfig(testBindings({
      ENVIRONMENT: 'production', COMMERCE_STRIPE_LIVEMODE: 'true',
      COMMERCE_STRIPE_SECRET_KEY: 'sk_live_commercekey', COMMERCE_STRIPE_ACCOUNT_ID: 'acct_live',
      COMMERCE_STRIPE_PRODUCT_SLOTS_ID: 'prod_slotslive', COMMERCE_STRIPE_PRODUCT_STANDALONE_ID: 'prod_offlinelive',
      COMMERCE_STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: 'pmc_live', COMMERCE_SITE_ORIGIN: 'https://ltsd.ro',
    } as never))).toMatchObject({ salesEnabled: true, livemode: true, stripeAccountId: 'acct_live' });
  });

  it('keeps webhook and job credentials available while new sales are disabled', () => {
    expect(resolveCommerceConfig(testBindings({ COMMERCE_ENABLED: 'false' } as never)))
      .toMatchObject({ salesEnabled: false, livemode: false, stripeAccountId: 'acct_test' });
  });

  it('verifies account, active products, mode, and Alipay configuration before accepting an order', async () => {
    const config = resolveCommerceConfig(testBindings() as never);
    expect(config).not.toBeNull();
    const stripe = mockStripe();

    await expect(verifyStripeCommerceConfiguration(config!, stripe)).resolves.toBeUndefined();
    expect(vi.mocked(stripe.get).mock.calls.map(([path]) => path).sort()).toEqual([
      '/account',
      '/payment_method_configurations/pmc_alipaytest',
      '/products/prod_offlinetest',
      '/products/prod_slotstest',
    ]);
  });

  it('checks the API key account identity without requiring Account.livemode', async () => {
    const config = resolveCommerceConfig(testBindings() as never)!;
    const stripe = mockStripe();

    await expect(verifyStripeCommerceConfiguration(config, stripe)).resolves.toBeUndefined();
    await expect(verifyStripeCommerceConfiguration(config, mockStripe({ account: { id: 'acct_other' } })))
      .rejects.toThrow();
  });

  it('rejects an inactive Alipay method or resources from another Stripe mode', async () => {
    const config = resolveCommerceConfig(testBindings() as never)!;
    const disabledAlipay = mockStripe({ paymentConfiguration: { alipay: { available: false, display_preference: { value: 'off' } } } });
    const wrongModeProduct = mockStripe({ products: { slots: { livemode: true } } });

    await expect(verifyStripeCommerceConfiguration(config, disabledAlipay)).rejects.toThrow();
    await expect(verifyStripeCommerceConfiguration(config, wrongModeProduct)).rejects.toThrow();
  });

  it('rejects Product IDs mapped to the wrong commerce item', async () => {
    const config = resolveCommerceConfig(testBindings() as never)!;
    const swappedProductKeys = mockStripe({
      products: { slots: { metadata: { ltsd_commerce_product_key: 'module:standalone' } } },
    });

    await expect(verifyStripeCommerceConfiguration(config, swappedProductKeys)).rejects.toThrow();
  });
});
