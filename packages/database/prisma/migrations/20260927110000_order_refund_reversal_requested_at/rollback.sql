-- Rollback for 20260927110000_order_refund_reversal_requested_at (hand-written;
-- Prisma does not generate down migrations). Non-destructive to business data:
-- the column only drives refund-reversal-stuck-sweep. Roll the code back first
-- (the old sweep never reads it), then:
DROP INDEX IF EXISTS "orders_refund_reversal_requested_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "refund_reversal_requested_at";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260927110000_order_refund_reversal_requested_at';
