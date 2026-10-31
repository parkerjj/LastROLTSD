import { describe, expect, it } from 'vitest';
import { commerceConfigIssueFields, resolveAppEnv, resolveCommerceConfig, type AppEnv } from '../src/env';
import { createApp } from '../src/index';

describe('commerce worker wiring', () => {
  it('identifies invalid Commerce binding names without exposing their values', () => {
    const env = {
      ENVIRONMENT: 'production',
      COMMERCE_ENABLED: 'true',
      COMMERCE_STRIPE_LIVEMODE: 'true',
      COMMERCE_STRIPE_SECRET_KEY: 'rk_live_testkey123',
      COMMERCE_STRIPE_WEBHOOK_SECRET: 'stripe_test_not_a_webhook_secret',
      COMMERCE_STRIPE_ACCOUNT_ID: 'acct_123',
      COMMERCE_PRICING_VERSION: 'ke-commerce-v1',
      COMMERCE_STRIPE_PRODUCT_SLOTS_ID: 'prod_slots',
      COMMERCE_STRIPE_PRODUCT_STANDALONE_ID: 'prod_standalone',
      COMMERCE_STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: 'pmc_123',
      COMMERCE_SITE_ORIGIN: 'https://ltsd.ro',
    } as AppEnv;
    const fields = commerceConfigIssueFields(env);

    expect(fields).toEqual(['COMMERCE_STRIPE_WEBHOOK_SECRET']);
    expect(JSON.stringify(fields)).not.toContain('stripe_test_not_a_webhook_secret');
    expect(resolveCommerceConfig(env)).toBeNull();
    expect(resolveCommerceConfig({ ...env, COMMERCE_STRIPE_WEBHOOK_SECRET: `whsec_${'A'.repeat(32)}` })).not.toBeNull();
  });

  it('returns fixed unavailable responses for commerce routes when deployment configuration is missing', async () => {
    const env = resolveAppEnv({ ENVIRONMENT: 'local', BUILD_VERSION: 'test' });
    const app = createApp(env);

    const quote = await app.request('https://ltsd.example/api/v1/commerce/quotes', { method: 'POST' });
    const order = await app.request('https://ltsd.example/api/v1/commerce/orders', { method: 'POST' });
    const webhook = await app.request('https://ltsd.example/api/v1/commerce/stripe/webhook', { method: 'POST' });

    expect(quote.status).toBe(503);
    expect(order.status).toBe(503);
    expect(webhook.status).toBe(503);
    for (const response of [quote, order]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(webhook.headers.get('cache-control')).toBe('no-store');
  });
});
