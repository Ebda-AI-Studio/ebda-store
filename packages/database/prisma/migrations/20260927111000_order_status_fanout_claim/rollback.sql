-- Rollback for 20260927111000_order_status_fanout_claim (hand-written; Prisma
-- does not generate down migrations). Non-destructive to business data: the
-- columns only drive the status-changed fanout claim and its stuck sweep. Roll
-- the code back first (the old fanout never reads them), then:
DROP INDEX IF EXISTS "orders_status_fanout_pending_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "status_fanout_claimed_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "status_fanout_requested_at";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260927111000_order_status_fanout_claim';
