import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../migrations/mysql/023_ke_commerce.sql', import.meta.url), 'utf8');

const commerceTables = [
  'commerce_customers',
  'commerce_quotes',
  'commerce_orders',
  'commerce_order_items',
  'commerce_units',
  'commerce_unit_events',
  'commerce_refunds',
  'commerce_provider_events',
  'commerce_jobs',
] as const;

function tableDefinition(name: (typeof commerceTables)[number]): string {
  const match = new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\) ENGINE=InnoDB`, 'u').exec(migration);
  if (!match?.[1]) throw new Error(`missing table ${name}`);
  return match[1];
}

describe('MySQL migration 023 commerce schema', () => {
  it('creates all nine commerce tables using InnoDB and no SQLite syntax', () => {
    for (const name of commerceTables) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE ${name} \\(`, 'u'));
      expect(tableDefinition(name)).toContain('PRIMARY KEY');
    }
    expect(migration.match(/CREATE TABLE commerce_/gu)).toHaveLength(commerceTables.length);
    expect(migration).toMatch(/ENGINE=InnoDB/gu);
    expect(migration).not.toMatch(/WITHOUT ROWID|PRAGMA|AUTOINCREMENT|json_each|\?\d+/iu);
  });

  it('scopes customer and account-owned financial records without cascading deletion', () => {
    for (const name of ['commerce_customers', 'commerce_quotes', 'commerce_orders', 'commerce_units'] as const) {
      expect(tableDefinition(name)).toMatch(/FOREIGN KEY \(user_id\) REFERENCES auth_users \(id\) ON DELETE RESTRICT/u);
    }
    expect(tableDefinition('commerce_customers')).toMatch(/UNIQUE KEY [^(]+\(user_id, stripe_account_id, stripe_livemode\)/u);
    expect(tableDefinition('commerce_customers')).toMatch(/UNIQUE KEY [^(]+\(stripe_account_id, stripe_livemode, stripe_customer_id\)/u);
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
  });

  it('stores immutable quote/order snapshots and bounded purchase items', () => {
    const quotes = tableDefinition('commerce_quotes');
    const orders = tableDefinition('commerce_orders');
    const items = tableDefinition('commerce_order_items');

    for (const column of ['pricing_version', 'request_hash', 'input_snapshot JSON', 'preview_snapshot JSON',
      'raw_total_cents', 'tier_total_cents', 'promo_total_cents', 'selected_total_cents', 'expires_at']) {
      expect(quotes).toContain(column);
    }
    for (const column of ['items_snapshot JSON', 'pricing_version', 'raw_total_cents', 'tier_total_cents',
      'promo_total_cents', 'paid_total_cents', 'discount_strategy', 'promotion_snapshot JSON', 'preview_snapshot JSON',
      'confirmation_idempotency_key', 'request_hash', 'checkout_state', 'payment_state', 'fulfillment_state', 'refund_state']) {
      expect(orders).toContain(column);
    }
    expect(orders).toMatch(/UNIQUE KEY [^(]+\(user_id, confirmation_idempotency_key\)/u);
    expect(orders).toMatch(/UNIQUE KEY [^(]+\(quote_id\)/u);
    expect(orders).toMatch(/FOREIGN KEY \(quote_id, user_id\) REFERENCES commerce_quotes \(id, user_id\) ON DELETE RESTRICT/u);
    for (const column of ['resource', 'operation', 'duration_ms', 'raw_cents', 'tier_cents', 'paid_cents',
      'expected_starts_at', 'expected_expires_at', 'delivery_state']) {
      expect(items).toContain(column);
    }
    expect(items).toMatch(/UNIQUE KEY [^(]+\(order_id, ordinal\)/u);
    expect(items).toMatch(/FOREIGN KEY \(order_id\) REFERENCES commerce_orders \(id\) ON DELETE RESTRICT/u);
  });

  it('preserves unit baselines and ordered, idempotent contribution history', () => {
    const units = tableDefinition('commerce_units');
    const events = tableDefinition('commerce_unit_events');

    for (const column of ['ke_entitlement_id', 'baseline_quantity', 'baseline_starts_at', 'baseline_expires_at',
      'legacy_origin_id', 'legacy_ordinal', 'admin_revoked_at', 'refund_zeroed_at']) {
      expect(units).toContain(column);
    }
    expect(units).toMatch(/UNIQUE KEY [^(]+\(ke_entitlement_id\)/u);
    expect(units).toMatch(/UNIQUE KEY [^(]+\(legacy_origin_id, legacy_ordinal\)/u);
    for (const column of ['unit_seq', 'event_type', 'order_item_id', 'refund_revision', 'before_expires_at',
      'after_expires_at', 'occurred_at', 'delivered_at', 'duration_ms', 'dedupe_key']) {
      expect(events).toContain(column);
    }
    expect(events).toMatch(/UNIQUE KEY [^(]+\(unit_id, unit_seq\)/u);
    expect(events).toMatch(/UNIQUE KEY [^(]+\(dedupe_key\)/u);
    expect(events).toContain('ADMIN_REVOKE');
    expect(events).toContain('ADMIN_RESTORE');
    expect(events).toMatch(/FOREIGN KEY \(unit_id\) REFERENCES commerce_units \(id\) ON DELETE RESTRICT/u);
  });

  it('deduplicates provider events and refunds by Stripe account, mode, and object ID', () => {
    const refunds = tableDefinition('commerce_refunds');
    const events = tableDefinition('commerce_provider_events');

    expect(refunds).toMatch(/UNIQUE KEY [^(]+\(stripe_account_id, stripe_livemode, stripe_refund_id\)/u);
    expect(refunds).toContain('amount_cents');
    expect(refunds).toContain('status');
    expect(refunds).toMatch(/FOREIGN KEY \(order_id\) REFERENCES commerce_orders \(id\) ON DELETE RESTRICT/u);
    expect(events).toMatch(/UNIQUE KEY [^(]+\(stripe_account_id, stripe_livemode, stripe_event_id\)/u);
    expect(events).toContain('payload_sha256');
    expect(events).toContain('received_at');
  });

  it('supports durable job leases, fencing, due scans, and retry state', () => {
    const jobs = tableDefinition('commerce_jobs');
    for (const column of ['job_key', 'dirty_generation', 'processed_generation', 'next_run_at', 'lease_owner',
      'lease_until', 'fencing_token', 'attempts', 'last_error_code']) {
      expect(jobs).toContain(column);
    }
    expect(jobs).toMatch(/UNIQUE KEY [^(]+\(job_key\)/u);
    expect(jobs).toMatch(/INDEX [^(]+\(state, next_run_at, lease_until, id\)/u);
    expect(jobs).toMatch(/FOREIGN KEY \(order_id\) REFERENCES commerce_orders \(id\) ON DELETE RESTRICT/u);
  });
});
