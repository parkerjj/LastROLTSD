ALTER TABLE commerce_orders
  DROP CHECK chk_commerce_orders_payment;

ALTER TABLE commerce_orders
  ADD CONSTRAINT chk_commerce_orders_payment
  CHECK (payment_state IN ('unpaid', 'processing', 'paid', 'failed'));
