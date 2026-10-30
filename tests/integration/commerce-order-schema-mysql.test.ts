import { describe, expect, it } from 'vitest';
import { createOrderRepository } from '../../apps/worker/src/commerce/orders';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL);

async function insertOrder(database: MysqlDatabase): Promise<string> {
  const email = 'stripe-session-column@example.test';
  const user = await database.run(
    `INSERT INTO auth_users
       (email, email_normalized, display_name, status, permission_level, email_verified_at, created_at, updated_at)
     VALUES (?, ?, 'Stripe session test', 'ACTIVE', 1, 1, 1, 1)`,
    [email, email],
  );
  const createdAt = 1_800_000_000_000;
  const requestHash = 'a'.repeat(64);
  const quote = await database.run(
    `INSERT INTO commerce_quotes
       (user_id, pricing_version, currency, request_hash, input_snapshot, preview_snapshot,
        raw_total_cents, tier_total_cents, selected_total_cents, discount_strategy, created_at, expires_at)
     VALUES (?, 'ke-commerce-test-v1', 'CNY', ?, JSON_OBJECT(), JSON_OBJECT(), 5000, 5000, 5000, 'term', ?, ?)`,
    [user.insertId, requestHash, createdAt, createdAt + 120_000],
  );
  const order = await database.run(
    `INSERT INTO commerce_orders
       (user_id, quote_id, stripe_account_id, stripe_livemode, currency, items_snapshot, pricing_version,
        raw_total_cents, tier_total_cents, paid_total_cents, discount_strategy, preview_snapshot,
        confirmation_idempotency_key, request_hash, created_at, updated_at)
     VALUES (?, ?, 'acct_test123', 0, 'CNY', JSON_ARRAY(), 'ke-commerce-test-v1',
             5000, 5000, 5000, 'term', JSON_OBJECT(), ?, ?, ?, ?)`,
    [user.insertId, quote.insertId, requestHash, requestHash, createdAt, createdAt],
  );
  return String(order.insertId);
}

describe.skipIf(!runMysqlTests)('Commerce order schema × MySQL', () => {
  it('persists 66-character Checkout Session IDs in orders and webhook events', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const orderId = await insertOrder(database);
      const createdAt = 1_800_000_000_000;
      const sessionId = `cs_test_${'a'.repeat(58)}`;

      await createOrderRepository(database).markCheckoutReady(orderId, {
        sessionId,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_example',
        expiresAt: createdAt + 30 * 60 * 1000,
        status: 'open',
        paymentStatus: 'unpaid',
      }, createdAt);

      const row = await database.first<{ stripe_checkout_session_id: string }>(
        'SELECT stripe_checkout_session_id FROM commerce_orders WHERE id = ?', [orderId],
      );
      expect(row?.stripe_checkout_session_id).toBe(sessionId);

      await database.run(
        `INSERT INTO commerce_provider_events
           (stripe_account_id, stripe_livemode, stripe_event_id, event_type, object_id, order_id,
            payload_sha256, state, received_at)
         VALUES ('acct_test123', 0, 'evt_test_long_session_1', 'checkout.session.completed', ?, ?, ?, 'queued', ?)`,
        [sessionId, orderId, 'b'.repeat(64), createdAt],
      );
      const event = await database.first<{ object_id: string }>(
        'SELECT object_id FROM commerce_provider_events WHERE stripe_event_id = ?', ['evt_test_long_session_1'],
      );
      expect(event?.object_id).toBe(sessionId);
    });
  }, 120_000);
});
