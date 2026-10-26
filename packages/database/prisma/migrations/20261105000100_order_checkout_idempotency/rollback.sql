DROP INDEX IF EXISTS "orders_store_id_checkout_idempotency_key_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "checkout_idempotency_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "checkout_request_hash";
