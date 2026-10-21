-- rollback.sql for 20261028000100_b2b_pricing_tables.
-- Roll the CODE back first (the resolver and the wholesale routes read these tables), and roll back
-- 20261028000200 BEFORE this one only if you also want the columns gone (independent of this file).
-- Loses every price tier and every wholesale application (PII); take a pg_dump of both first if needed.
DROP TABLE IF EXISTS "wholesale_applications";
DROP TABLE IF EXISTS "product_price_tiers";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000100_b2b_pricing_tables';
