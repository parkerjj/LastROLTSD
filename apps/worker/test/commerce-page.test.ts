import { describe, expect, it } from 'vitest';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import { buildCommerceBootstrap, renderCommerceHtml } from '../src/commerce/page';

const NOW = 1_800_000_000_000;
const SESSION_COOKIE = `__Host-ltsd-session=${'A'.repeat(43)}`;

function secret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(overrides: Record<string, unknown> = {}): never {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', AUTH_ENABLED: 'false',
    ASSETS: { fetch: async () => new Response('<!doctype html><html><head><!--commerce-bootstrap--></head><body><main id="app"></main></body></html>') },
    ...overrides,
  } as never;
}

class CommercePageDatabase implements MysqlDatabase {
  readonly calls: string[] = [];

  constructor(private readonly sources: {
    slotBaselineSourceRef?: string | null;
    slotEntitlementSourceRef?: string | null;
    standaloneSource?: string;
    standaloneSourceRef?: string | null;
  } = {}) {}

  private get slotBaselineSourceRef(): string | null {
    return this.sources.slotBaselineSourceRef === undefined ? 'email-verified:slots' : this.sources.slotBaselineSourceRef;
  }

  private get slotEntitlementSourceRef(): string | null {
    return this.sources.slotEntitlementSourceRef === undefined ? this.slotBaselineSourceRef : this.sources.slotEntitlementSourceRef;
  }

  async all<T extends MysqlRow>(sql: string): Promise<T[]> {
    this.calls.push(sql);
    if (sql.includes('NOT EXISTS (SELECT 1 FROM commerce_units')) return [];
    if (sql.includes('FROM commerce_units u')) return [{
      unit_id: '31', user_id: '42', resource: 'slots', unit_kind: 'legacy', ke_entitlement_id: '71',
      baseline_source: 'signup', baseline_source_ref: this.slotBaselineSourceRef, baseline_quantity: 1,
      baseline_starts_at: String(NOW - 1_000), baseline_expires_at: String(NOW + 99_000), legacy_origin_id: '71',
      legacy_ordinal: 1, admin_revoked_at: null, refund_zeroed_at: null, current_quantity: 1,
      current_starts_at: String(NOW - 1_000), current_expires_at: String(NOW + 99_000),
    }] as unknown as T[];
    if (sql.includes('AS signed_total')) return [{ signed_total: '1' }] as unknown as T[];
    if (sql.includes('GROUP BY resource')) return [
      { resource: 'slots', total: 1 }, { resource: 'module:core', total: 1 }, { resource: 'module:standalone', total: 1 },
    ] as unknown as T[];
    if (sql.includes('SELECT id, resource, quantity, starts_at, expires_at, source, source_ref')) return [
      { id: '71', resource: 'slots', quantity: 1, starts_at: NOW - 1_000, expires_at: NOW + 99_000, source: 'signup', source_ref: this.slotEntitlementSourceRef },
      { id: '72', resource: 'module:core', quantity: 1, starts_at: NOW - 1_000, expires_at: NOW + 99_000, source: 'signup', source_ref: 'email-verified:module:core' },
      { id: '73', resource: 'module:standalone', quantity: 1, starts_at: NOW - 1_000, expires_at: NOW + 75_000, source: this.sources.standaloneSource ?? 'commerce', source_ref: this.sources.standaloneSourceRef ?? null },
    ] as unknown as T[];
    return [];
  }

  async first<T extends MysqlRow>(sql: string): Promise<T | null> {
    this.calls.push(sql);
    if (sql.includes('FROM auth_sessions AS s')) return {
      user_id: '42', status: 'ACTIVE', credential_version: 1, auth_version: 1, expires_at: NOW + 60_000,
    } as unknown as T;
    if (sql.includes('FROM auth_users AS u')) return {
      id: '42', email: 'player@example.test', display_name: '</script><script>alert(1)</script>', status: 'ACTIVE',
      permission_level: 1, email_verified_at: NOW - 2_000, created_at: NOW - 100_000, avatar_version: 0, has_avatar: 0,
    } as unknown as T;
    if (sql.includes('SELECT id FROM auth_users WHERE id = ? FOR UPDATE')) return { id: '42' } as unknown as T;
    return null;
  }

  async run(): Promise<MysqlWriteResult> { return { affectedRows: 1, insertId: 1 }; }
  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> { return work(this); }
  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('commerce page bootstrap', () => {
  it('serves the public product catalog to anonymous visitors without requiring a database', async () => {
    const response = await renderCommerceHtml(new Request('https://ltsd.ro/ke/buy'), bindings(), undefined);
    const html = await response.text();
    const script = /<script type="application\/json" id="commerce-bootstrap">([^<]*)<\/script>/u.exec(html);
    const bootstrap = JSON.parse(script?.[1] ?? 'null') as { catalog?: { products?: Array<{ key: string }> }; session?: unknown; account?: unknown };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(bootstrap.catalog?.products?.map(({ key }) => key)).toEqual(['slots', 'module:standalone']);
    expect(bootstrap.session).toBeNull();
    expect(bootstrap.account).toMatchObject({ units: [], entitlements: [], effective: { slots: 0, modules: [] } });
  });

  it('embeds the authenticated profile, CSRF token, gift and paid entitlements without exposing a session token', async () => {
    const db = new CommercePageDatabase();
    const env = bindings({
      AUTH_ENABLED: 'true', MYSQL_URL: 'mysql://local:test@127.0.0.1/app', AUTH_SITE_URL: 'https://ltsd.ro',
      AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2), AUTH_RATE_SECRET: secret(3),
      AUTH_MAIL_PAYLOAD_SECRET: secret(4), STRIPE_SECRET_KEY: 'sk_test_donation_only',
    });
    const request = new Request('https://ltsd.ro/ke/buy', { headers: { cookie: SESSION_COOKIE } });
    await buildCommerceBootstrap(request, env, db);

    const response = await renderCommerceHtml(request, env, db);
    const html = await response.text();
    const script = /<script type="application\/json" id="commerce-bootstrap">([^<]*)<\/script>/u.exec(html);
    const bootstrap = JSON.parse(script?.[1] ?? 'null') as {
      session?: { user?: { id?: string; display_name?: string }; csrf_token?: string };
      account?: { units?: Array<{ unitId: string; isGift: boolean }>; entitlements?: Array<{ resource: string; expiresAt: string }> };
    };

    expect(response.status).toBe(200);
    expect(bootstrap.session).toMatchObject({ user: { id: '42' }, csrf_token: expect.stringMatching(/^v1\.s\./u) });
    expect(bootstrap.account?.units).toEqual([expect.objectContaining({ unitId: '31', isGift: true })]);
    expect(bootstrap.account?.entitlements?.map(({ resource }) => resource)).toEqual(['slots', 'module:core', 'module:standalone']);
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003e');
    expect(html).not.toContain('A'.repeat(43));
    expect(html).not.toContain('sk_test_donation_only');
    expect(db.calls.some((sql) => sql.includes('FROM auth_sessions AS s'))).toBe(true);
    expect(db.calls.some((sql) => sql.includes('FROM commerce_units u'))).toBe(true);
  });

  it('does not classify signup slot rows without the permanent-gift marker as gifts', async () => {
    const bootstrap = await buildCommerceBootstrap(
      new Request('https://ltsd.ro/ke/buy', { headers: { cookie: SESSION_COOKIE } }),
      bindings({
        AUTH_ENABLED: 'true', MYSQL_URL: 'mysql://local:test@127.0.0.1/app', AUTH_SITE_URL: 'https://ltsd.ro',
        AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2), AUTH_RATE_SECRET: secret(3),
        AUTH_MAIL_PAYLOAD_SECRET: secret(4),
      }),
      new CommercePageDatabase({ slotBaselineSourceRef: null, slotEntitlementSourceRef: null }),
    );

    expect(bootstrap.account.units).toEqual([expect.objectContaining({ unitId: '31', source: 'signup', sourceRef: null, isGift: false })]);
    expect(bootstrap.account.entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '71', resource: 'slots', source: 'signup', sourceRef: null, isGift: false }),
    ]));
  });

  it('uses the linked entitlement marker instead of the baseline marker when classifying a slot unit', async () => {
    const bootstrap = await buildCommerceBootstrap(
      new Request('https://ltsd.ro/ke/buy', { headers: { cookie: SESSION_COOKIE } }),
      bindings({
        AUTH_ENABLED: 'true', MYSQL_URL: 'mysql://local:test@127.0.0.1/app', AUTH_SITE_URL: 'https://ltsd.ro',
        AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2), AUTH_RATE_SECRET: secret(3),
        AUTH_MAIL_PAYLOAD_SECRET: secret(4),
      }),
      new CommercePageDatabase({ slotBaselineSourceRef: 'email-verified:slots', slotEntitlementSourceRef: null }),
    );

    expect(bootstrap.account.units).toEqual([expect.objectContaining({ unitId: '31', sourceRef: null, isGift: false })]);
  });

  it('recognizes the permanent standalone gift marker in the account bootstrap', async () => {
    const bootstrap = await buildCommerceBootstrap(
      new Request('https://ltsd.ro/ke/buy', { headers: { cookie: SESSION_COOKIE } }),
      bindings({
        AUTH_ENABLED: 'true', MYSQL_URL: 'mysql://local:test@127.0.0.1/app', AUTH_SITE_URL: 'https://ltsd.ro',
        AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2), AUTH_RATE_SECRET: secret(3),
        AUTH_MAIL_PAYLOAD_SECRET: secret(4),
      }),
      new CommercePageDatabase({ standaloneSource: 'signup', standaloneSourceRef: 'email-verified:module:standalone' }),
    );

    expect(bootstrap.account.entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '73', resource: 'module:standalone', isGift: true }),
    ]));
  });

  it('returns a fixed no-store error when required assets or an authenticated database are unavailable', async () => {
    const missingAssets = await renderCommerceHtml(new Request('https://ltsd.ro/ke/buy'), bindings({ ASSETS: undefined }), undefined);
    const missingDatabase = await renderCommerceHtml(
      new Request('https://ltsd.ro/ke/buy', { headers: { cookie: SESSION_COOKIE } }),
      bindings({ AUTH_ENABLED: 'true', MYSQL_URL: 'mysql://local:test@127.0.0.1/app' }), undefined,
    );

    expect(missingAssets.status).toBe(503);
    expect(missingDatabase.status).toBe(503);
    expect(missingAssets.headers.get('cache-control')).toBe('private, no-store');
    expect(await missingDatabase.text()).not.toContain('mysql://');
  });
});
