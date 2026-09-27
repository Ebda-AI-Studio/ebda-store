-- Rollback for 20260927140000_stock_adjustment_import_key.
-- Drops only the idempotency key; no stock or ledger data lives in it.
DROP INDEX IF EXISTS "stock_adjustments_store_id_import_key_key";
ALTER TABLE "stock_adjustments" DROP COLUMN IF EXISTS "import_key";
