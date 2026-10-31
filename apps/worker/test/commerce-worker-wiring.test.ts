import { describe, expect, it } from 'vitest';
import { resolveAppEnv } from '../src/env';
import { createApp } from '../src/index';

describe('commerce worker wiring', () => {
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
