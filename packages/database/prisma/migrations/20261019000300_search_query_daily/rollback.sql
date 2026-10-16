-- rollback.sql for 20261019000300_search_query_daily.
-- Roll the CODE back first (the search route and the purge cron write/read this table).
-- Loses only the storefront search counters; no other table references it.
DROP TABLE IF EXISTS "search_query_daily";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261019000300_search_query_daily';
