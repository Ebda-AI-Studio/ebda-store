-- Rollback for 20261001100000_refund_claim_and_stock_marker_indexes.
-- Index-only; dropping them loses no data.
DROP INDEX IF EXISTS "payment_events_event_type_occurred_at_idx";
DROP INDEX IF EXISTS "inventory_history_store_id_reference_idx";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261001100000_refund_claim_and_stock_marker_indexes';
