import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { digestToken } from '../src/auth/crypto';
import { issueCsrf } from '../src/auth/csrf';
import type { AuthRepository } from '../src/auth/repository';
import type { AuthIdentity, AuthSessionResponse, AuthRuntime, EnabledAuthConfig } from '../src/auth/types';
import { registerCommerceQuoteRoute } from '../src/commerce/router';
import type { QuoteAccountState, QuoteDependencies, QuoteRepository } from '../src/commerce/quotes';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://ltsd.example';
const SESSION_TOKEN = 'A'.repeat(43);

function profile(status: AuthSessionResponse['user']['status'] = 'ACTIVE', permissionLevel = 1): AuthSessionResponse['user'] {
  return {
    id: '42', email: 'player@example.test', display_name: 'Player', status,
    permission_level: permissionLevel, email_verified_at: status === 'ACTIVE' ? NOW - 1 : null,
    created_at: NOW - 1000, has_avatar: false, avatar_version: 0, avatar_url: '',
  };
}

async function setup(options: {
  status?: AuthSessionResponse['user']['status'];
  permissionLevel?: number;
  account?: QuoteAccountState;
  readAccount?: () => Promise<QuoteAccountState>;
  rateAllowed?: boolean;
  previewPromotion?: QuoteDependencies['previewPromotion'];
  salesEnabled?: boolean;
} = {}) {
  const sessionDigest = await digestToken(SESSION_TOKEN);
  const userProfile = profile(options.status, options.permissionLevel);
  const identity: AuthIdentity & { expiresAt: number } = {
    userId: '42', status: userProfile.status, credentialVersion: 1, authVersion: 1,
    sessionDigest, expiresAt: NOW + 60_000,
  };
  const authConfig = {
    enabled: true, mysqlUrl: 'mysql://test', authSiteUrl: ORIGIN, csrfSecret: new Uint8Array(32).fill(2), rateSecret: new Uint8Array(32).fill(3),
    passwordKeys: new Map(), mailPayloadKeys: new Map(), currentPasswordKeyVersion: '1',
    currentMailPayloadKeyVersion: '1', mailDailyLimit: 100, mailMonthlyLimit: 1000, mailCloudflareMonthlyLimit: 1000,
  } as EnabledAuthConfig;
  const authRepository = {
    readIdentity: vi.fn(async () => identity),
    readProfile: vi.fn(async () => userProfile),
    readMailAvailability: vi.fn(async () => ({ code: 'AVAILABLE' as const, retry_at: null })),
    consumeAuthRateLimits: vi.fn(async () => ({ allowed: options.rateAllowed ?? true, retryAfter: 60 })),
  } as unknown as AuthRepository;
  const account: QuoteAccountState = options.account ?? {
    slotUnits: [], entitlements: [], effective: { slots: 0, modules: new Set<string>() },
  };
  const quoteRepository: QuoteRepository = {
    readAccount: options.readAccount ?? vi.fn(async () => account),
    insertQuote: vi.fn(async () => '501'),
  };
  const quoteDependencies: QuoteDependencies = {
    repository: quoteRepository,
    pricingVersion: 'ke-commerce-test-v1',
    now: () => NOW,
    productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
    ...(options.previewPromotion ? { previewPromotion: options.previewPromotion } : {}),
  };
  const runtime: AuthRuntime = { now: () => NOW, fetch: globalThis.fetch };
  const csrf = await issueCsrf(new Request(`${ORIGIN}/`), authConfig, 'session', identity, () => NOW);
  const app = new Hono();
  registerCommerceQuoteRoute(app, {
    setup: () => ({ authConfig, authRepository, quoteDependencies, runtime, ...(options.salesEnabled === undefined ? {} : { salesEnabled: options.salesEnabled }) }),
  });
  return { app, csrfToken: csrf.token, quoteRepository, authRepository };
}

function requestHeaders(csrfToken?: string, origin = ORIGIN): Headers {
  const headers = new Headers({
    'content-type': 'application/json', origin,
    cookie: `__Host-ltsd-session=${SESSION_TOKEN}`,
  });
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  return headers;
}

async function postQuote(app: Hono, body: unknown, csrfToken?: string, origin = ORIGIN): Promise<Response> {
  return app.request(`${ORIGIN}/api/v1/commerce/quotes`, {
    method: 'POST', headers: requestHeaders(csrfToken, origin), body: JSON.stringify(body),
  });
}

describe('commerce quote route', () => {
  it('maps setup failures to a fixed unavailable response', async () => {
    const app = new Hono();
    registerCommerceQuoteRoute(app, { setup: () => { throw new Error('private database setup failure'); } });
    const response = await app.request(`${ORIGIN}/api/v1/commerce/quotes`, { method: 'POST' });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('private database');
  });

  it('rejects new quotes while sales are disabled before authenticating or reading commerce state', async () => {
    const fixture = await setup({ salesEnabled: false });
    const response = await postQuote(fixture.app, {
      selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }],
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fixture.authRepository.readIdentity).not.toHaveBeenCalled();
    expect(fixture.quoteRepository.readAccount).not.toHaveBeenCalled();
    expect(fixture.quoteRepository.insertQuote).not.toHaveBeenCalled();
  });

  it('requires an active formal account', async () => {
    for (const options of [{ status: 'PENDING_EMAIL' as const }, { status: 'ACTIVE' as const, permissionLevel: 0 }]) {
      const fixture = await setup(options);
      const response = await postQuote(fixture.app, { selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }] }, fixture.csrfToken);
      expect(response.status).toBe(403);
    }

    const disabled = await setup({ status: 'DISABLED' });
    const disabledResponse = await postQuote(disabled.app, { selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }] }, disabled.csrfToken);
    expect([401, 403]).toContain(disabledResponse.status);
  });

  it('rejects missing session CSRF tokens and cross-origin requests', async () => {
    const fixture = await setup();
    const body = { selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }] };

    expect((await postQuote(fixture.app, body)).status).toBe(403);
    expect((await postQuote(fixture.app, body, fixture.csrfToken, 'https://attacker.example')).status).toBe(403);
  });

  it('returns a two-minute quote without exposing Stripe identifiers', async () => {
    const previewPromotion = vi.fn(async () => ({
      promotionCodeId: 'promo_private', couponId: 'coupon_private', subtotalCents: 5000,
      totalCents: 4000, discountCents: 1000, currency: 'cny' as const,
    }));
    const fixture = await setup({ previewPromotion });
    const response = await postQuote(fixture.app, {
      selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }], promotion_code: 'SPRING',
    }, fixture.csrfToken);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body).toMatchObject({ quoteId: '501', expiresAt: String(NOW + 120_000), selectedTotalCents: '4000' });
    expect(JSON.stringify(body)).not.toContain('promo_private');
    expect(JSON.stringify(body)).not.toContain('coupon_private');
    expect(previewPromotion).toHaveBeenCalledTimes(1);
  });

  it('does not reveal whether a requested unit belongs to another account', async () => {
    const fixture = await setup();
    const response = await postQuote(fixture.app, {
      selection: [{ type: 'slot_renew', unit_ids: ['999'], term_days: 30 }],
    }, fixture.csrfToken);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain('999');
    expect(body).not.toContain('player@example.test');
  });

  it('maps database errors to a fixed response without leaking driver details', async () => {
    const fixture = await setup({ readAccount: async () => { throw new Error('SQL host=db.internal password=private'); } });
    const response = await postQuote(fixture.app, {
      selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }],
    }, fixture.csrfToken);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('db.internal');
    expect(body).not.toContain('private');
  });

  it('rate limits quote creation per session', async () => {
    const fixture = await setup({ rateAllowed: false });
    const response = await postQuote(fixture.app, {
      selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }],
    }, fixture.csrfToken);

    expect(response.status).toBe(429);
    expect(fixture.authRepository.consumeAuthRateLimits).toHaveBeenCalledTimes(1);
    expect(fixture.quoteRepository.insertQuote).not.toHaveBeenCalled();
  });
});
