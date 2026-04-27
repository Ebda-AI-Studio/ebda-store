-- Snapshot cost-of-goods on order_items so profit analytics survive
-- product price/cost changes. Stored in fils to match the existing
-- `price` column on the same row. Nullable because old rows have no
-- cost data we can reliably backfill from.
ALTER TABLE "order_items" ADD COLUMN "cost_price" INTEGER;
