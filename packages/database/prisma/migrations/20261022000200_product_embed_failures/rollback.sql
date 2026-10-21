-- rollback.sql for 20261022000200_product_embed_failures.
-- Roll the CODE back first (the indexer reads and writes this table).
-- Loses only the quarantine: quarantined products are retried by the next indexer run.
DROP TABLE IF EXISTS "product_embed_failures";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022000200_product_embed_failures';
