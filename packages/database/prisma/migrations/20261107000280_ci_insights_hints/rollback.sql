-- rollback.sql for 20261107000280_ci_insights_hints.
-- Roll the CODE back first (the CI aggregation job, the Insights page and the merchant hints use these tables).
-- Loses only CI insights and hint logs; no other table references them.
DROP TABLE IF EXISTS "ci_hint_logs";
DROP TABLE IF EXISTS "ci_insights";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261107000280_ci_insights_hints';
