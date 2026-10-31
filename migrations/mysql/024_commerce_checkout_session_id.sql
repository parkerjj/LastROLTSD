-- Stripe Checkout Session IDs can exceed the previous 64-character column limit.
ALTER TABLE commerce_orders
  MODIFY COLUMN stripe_checkout_session_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL;
