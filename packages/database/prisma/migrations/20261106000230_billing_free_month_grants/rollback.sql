DROP TRIGGER IF EXISTS "billing_grants_guard_update" ON "billing_grants";
DROP TRIGGER IF EXISTS "billing_grants_guard_delete" ON "billing_grants";
DROP FUNCTION IF EXISTS billing_grants_guard();
DROP TABLE IF EXISTS "billing_grants";
DROP TABLE IF EXISTS "billing_referrals";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261106000230_billing_free_month_grants';
