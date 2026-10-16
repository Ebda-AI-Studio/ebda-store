-- Rollback for 20261003110000_enable_pg_stat_statements.
-- Drops the view and functions only; the accumulated statistics are lost, no
-- application data is touched. Run on the non-pooled DIRECT_URL.
DROP EXTENSION IF EXISTS pg_stat_statements;

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261003110000_enable_pg_stat_statements';
