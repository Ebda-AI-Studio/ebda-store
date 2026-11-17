-- rollback.sql for 20261116000100_trust_requests_granted_limit. Roll the CODE back first (owners fall back to the constant).
ALTER TABLE "trust_requests" DROP CONSTRAINT IF EXISTS "trust_requests_granted_limit_check";
ALTER TABLE "trust_requests" DROP COLUMN IF EXISTS "granted_limit";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261116000100_trust_requests_granted_limit';
