-- Rollback for 20261001101000_order_status_fanout_requested_status.
-- Drops only fanout bookkeeping; no order data lives in these columns.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "status_fanout_completed_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "status_fanout_requested_status";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261001101000_order_status_fanout_requested_status';
