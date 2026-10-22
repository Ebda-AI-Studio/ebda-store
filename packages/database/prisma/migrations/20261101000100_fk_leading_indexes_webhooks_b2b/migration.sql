-- Migration: fk_leading_indexes_webhooks_b2b.
-- Four composite (ownership) foreign keys added after the last FK-index audit have no index
-- leading on their columns, which tests/integration/db-maintenance-indexes.test.ts ("every foreign
-- key still has an index leading on its columns") caught on main:
--   webhook_deliveries         (endpoint_id, store_id)   20261025000100_merchant_webhooks
--   product_price_tiers        (product_id, variant_id)  20261028000300_b2b_identity_link_ownership_fks
--   product_price_tiers        (store_id, group_id)      20261028000300_b2b_identity_link_ownership_fks
--   wholesale_applications     (store_id, group_id)      20261028000300_b2b_identity_link_ownership_fks
-- Without them a DELETE on the parent (a webhook endpoint, a variant, a customer group, all
-- ON DELETE CASCADE / SET NULL) scans the child table once per deleted parent row.
-- Index-only: no column or data change, RLS unchanged. The existing single-column indexes stay
-- (dropping them is a separate audited migration, docs/DB-INDEX-MIGRATIONS.md).
-- Lock note: plain CREATE INDEX takes SHARE on each table (writes wait). All four tables are new
-- this month and empty or near-empty (webhooks and wholesale are pre-launch), so the build is
-- instant and no CONCURRENTLY pre-build is needed. IF NOT EXISTS keeps it a no-op if pre-built.
-- Rollback: rollback.sql.

CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_id_store_id_idx"
  ON "webhook_deliveries"("endpoint_id", "store_id");
CREATE INDEX IF NOT EXISTS "product_price_tiers_product_id_variant_id_idx"
  ON "product_price_tiers"("product_id", "variant_id");
CREATE INDEX IF NOT EXISTS "product_price_tiers_store_id_group_id_idx"
  ON "product_price_tiers"("store_id", "group_id");
CREATE INDEX IF NOT EXISTS "wholesale_applications_store_id_group_id_idx"
  ON "wholesale_applications"("store_id", "group_id");
