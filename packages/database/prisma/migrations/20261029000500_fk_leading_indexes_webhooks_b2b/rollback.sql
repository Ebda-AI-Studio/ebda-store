-- rollback.sql for 20261029000500_fk_leading_indexes_webhooks_b2b: drops the four indexes.
-- Safe at any time (index-only); the FKs keep working, parent deletes just scan again.
-- After running it, forget the migration so a later `prisma migrate deploy` recreates the indexes:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261029000500_fk_leading_indexes_webhooks_b2b';
DROP INDEX IF EXISTS "webhook_deliveries_endpoint_id_store_id_idx";
DROP INDEX IF EXISTS "product_price_tiers_product_id_variant_id_idx";
DROP INDEX IF EXISTS "product_price_tiers_store_id_group_id_idx";
DROP INDEX IF EXISTS "wholesale_applications_store_id_group_id_idx";
