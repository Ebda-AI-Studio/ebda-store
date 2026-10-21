-- Rollback for 20261003110100_drop_redundant_prefix_indexes.
-- Recreates the eight dropped indexes exactly as production had them
-- (pg_get_indexdef, 2026-10-03). Run on the non-pooled DIRECT_URL in psql
-- autocommit (no BEGIN): CONCURRENTLY cannot run inside a transaction, and it
-- builds without blocking writes. Then revert the PR so schema.prisma declares
-- the @@index lines again; otherwise the next `prisma migrate dev` proposes
-- dropping them. Confirm no INVALID index is left behind:
--   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--   WHERE NOT i.indisvalid;   -- must return 0 rows
CREATE INDEX CONCURRENTLY IF NOT EXISTS "carts_store_id_idx" ON "carts" USING btree ("store_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_recommendation_store_id_source_product_id_idx" ON "ai_recommendation" USING btree ("store_id", "source_product_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_store_id_idx" ON "audit_logs" USING btree ("store_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_store_id_idx" ON "orders" USING btree ("store_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_store_id_idx" ON "products" USING btree ("store_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_events_event_type_idx" ON "payment_events" USING btree ("event_type");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "inventory_history_store_id_idx" ON "inventory_history" USING btree ("store_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cart_bundles_cart_id_idx" ON "cart_bundles" USING btree ("cart_id");

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261003110100_drop_redundant_prefix_indexes';
