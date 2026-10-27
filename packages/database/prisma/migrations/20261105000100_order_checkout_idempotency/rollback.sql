DROP INDEX IF EXISTS "orders_store_id_checkout_idempotency_key_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "checkout_idempotency_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "checkout_request_hash";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105000100_order_checkout_idempotency';
