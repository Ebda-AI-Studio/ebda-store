-- Rollback for 20261001101000_order_status_fanout_requested_status.
-- Drops only fanout bookkeeping; no order data lives in these columns.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "status_fanout_completed_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "status_fanout_requested_status";
