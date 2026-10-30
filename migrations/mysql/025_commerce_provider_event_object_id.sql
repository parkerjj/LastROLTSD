-- Stripe object IDs can exceed the previous 64-character inbox column limit.
ALTER TABLE commerce_provider_events
  MODIFY COLUMN object_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL;
