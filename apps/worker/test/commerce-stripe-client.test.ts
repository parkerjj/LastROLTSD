import { describe, expect, it, vi } from 'vitest';
import type { CommerceRepository, CommerceTransaction } from '../src/commerce/repository';
import { ensureCommerceCustomer } from '../src/commerce/customers';
import { createStripeClient, StripeRequestError, type StripeClient } from '../src/commerce/stripe-client';
import type { AuthSessionResponse } from '../src/auth/types';

describe('Stripe REST client', () => {
  it('encodes nested form data and sends auth, API version, and idempotency headers', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ id: 'in_preview_123' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const stripe = createStripeClient({ secretKey: 'sk_test_only', apiVersion: '2026-09-30.endive', fetch });

    const result = await stripe.post<{ id: string }>('/invoices/create_preview', {
      customer: 'cus_123',
      currency: 'cny',
      automatic_tax: { enabled: false },
      invoice_items: [
        { description: 'KE slots', discountable: true, price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 } },
      ],
      discounts: [{ promotion_code: 'promo_123' }],
    }, { idempotencyKey: 'commerce:preview:quote-123' });

    expect(result.id).toBe('in_preview_123');
    expect(requestUrl).toBe('https://api.stripe.com/v1/invoices/create_preview');
    expect(requestInit?.method).toBe('POST');
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer sk_test_only');
    expect(headers.get('Stripe-Version')).toBe('2026-09-30.endive');
    expect(headers.get('Idempotency-Key')).toBe('commerce:preview:quote-123');
    expect(headers.get('Content-Type')).toContain('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get('automatic_tax[enabled]')).toBe('false');
    expect(body.get('invoice_items[0][price_data][product]')).toBe('prod_slots');
    expect(body.get('invoice_items[0][price_data][unit_amount]')).toBe('5000');
    expect(body.get('discounts[0][promotion_code]')).toBe('promo_123');
  });

  it('encodes GET query parameters without sending an idempotency key or a request body', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const stripe = createStripeClient({ secretKey: 'sk_test_only', apiVersion: '2026-09-30.endive', fetch });

    await stripe.get('/promotion_codes', { active: true, code: 'Spring Sale', expand: ['data.coupon'] });

    const url = new URL(requestUrl);
    expect(url.searchParams.get('active')).toBe('true');
    expect(url.searchParams.get('code')).toBe('Spring Sale');
    expect(url.searchParams.get('expand[]')).toBe('data.coupon');
    expect(requestInit?.method).toBe('GET');
    expect(requestInit?.body).toBeUndefined();
    expect(new Headers(requestInit?.headers).get('Idempotency-Key')).toBeNull();
  });

  it('calls the platform fetch with its global receiver', async () => {
    let calledWithGlobalReceiver = false;
    const fetch = async function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      calledWithGlobalReceiver = this === globalThis;
      return new Response(JSON.stringify({ id: 'acct_test123' }), { status: 200 });
    } as unknown as typeof globalThis.fetch;
    const stripe = createStripeClient({ secretKey: 'sk_test_only', apiVersion: '2026-09-30.endive', fetch });

    await stripe.get('/account');

    expect(calledWithGlobalReceiver).toBe(true);
  });

  it('maps Stripe HTTP errors to a fixed public error without leaking provider details', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'private account diagnostics', code: 'secret_code' } }), { status: 400 })) as unknown as typeof globalThis.fetch;
    const stripe = createStripeClient({ secretKey: 'sk_test_only', apiVersion: '2026-09-30.endive', fetch });

    let caught: unknown;
    try {
      await stripe.get('/promotion_codes', { code: 'HOLIDAY' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StripeRequestError);
    expect(caught).toMatchObject({ message: '支付服务暂时不可用，请稍后重试', status: 400, providerCode: 'secret_code' });
    expect(String(caught)).not.toContain('private account diagnostics');
  });

  it('maps aborts and malformed JSON to the same fixed public error', async () => {
    const abortedFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('timeout details', 'AbortError');
    }) as unknown as typeof globalThis.fetch;
    const aborted = createStripeClient({ secretKey: 'sk_test_only', apiVersion: '2026-09-30.endive', fetch: abortedFetch });
    await expect(aborted.get('/customers')).rejects.toThrow('支付服务暂时不可用，请稍后重试');

    const invalidJsonFetch = vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof globalThis.fetch;
    const invalidJson = createStripeClient({ secretKey: 'sk_test_only', apiVersion: '2026-09-30.endive', fetch: invalidJsonFetch });
    await expect(invalidJson.get('/customers')).rejects.toThrow('支付服务暂时不可用，请稍后重试');
  });
});

describe('commerce Stripe customer mapping', () => {
  it('creates a separate Stripe customer once and reuses the persisted mapping', async () => {
    let mapping: Record<string, unknown> | null = null;
    const tx = {
      lockUser: vi.fn(async (userId: string) => userId === '42'),
      first: vi.fn(async (sql: string) => sql.includes('commerce_customers') ? mapping : null),
      all: vi.fn(async () => []),
      run: vi.fn(async (_sql: string, values: readonly unknown[] = []) => {
        mapping ??= {
          user_id: values[0],
          stripe_account_id: values[1],
          stripe_livemode: values[2],
          stripe_customer_id: values[3],
        };
        return { affectedRows: 1 };
      }),
    } as unknown as CommerceTransaction;
    const repository: CommerceRepository = { transaction: async (work) => work(tx) };
    const post = vi.fn(async (_path: string, _params: Record<string, unknown>, _options?: { idempotencyKey?: string }) => ({ id: 'cus_commerce42' }));
    const stripe = { post } as unknown as StripeClient;
    const identity = {
      id: '42', email: 'buyer@example.com', display_name: 'Buyer', status: 'ACTIVE', permission_level: 1,
      email_verified_at: 1, created_at: 1, has_avatar: false, avatar_version: 0, avatar_url: '',
    } satisfies AuthSessionResponse['user'];
    const options = {
      repository,
      stripe,
      stripeAccountId: 'acct_test123',
      livemode: false,
      now: () => 1000,
    };

    const first = await ensureCommerceCustomer('42', identity, options);
    const second = await ensureCommerceCustomer('42', identity, options);

    expect(first.stripeCustomerId).toBe('cus_commerce42');
    expect(second).toEqual(first);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/customers', expect.objectContaining({
      email: 'buyer@example.com',
      name: 'Buyer',
      metadata: { ltsd_user_id: '42' },
    }), { idempotencyKey: 'ke-commerce:customer:v1:test:acct_test123:42' });
  });
});
