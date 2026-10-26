-- Checkout idempotency (audit M-012 / P07): one order per (store, checkout request key).
-- Additive: a nullable column and a unique index; NULLs never collide, so every existing order is untouched.
-- The value is sha256(sessionId | Idempotency-Key header) computed by OrderService.create, never the raw header.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_idempotency_key" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_request_hash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "orders_store_id_checkout_idempotency_key_key"
  ON "orders" ("store_id", "checkout_idempotency_key");
