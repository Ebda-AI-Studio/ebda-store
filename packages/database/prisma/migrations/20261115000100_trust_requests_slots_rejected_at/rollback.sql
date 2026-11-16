-- rollback.sql for 20261115000100_trust_requests_slots_rejected_at. Roll the CODE back first.
DROP INDEX IF EXISTS "trust_requests_support_cap_slot";
ALTER TABLE "trust_requests" DROP CONSTRAINT IF EXISTS "trust_requests_cap_slot_check";
ALTER TABLE "trust_requests" DROP COLUMN IF EXISTS "cap_slot";
ALTER TABLE "trust_requests" DROP COLUMN IF EXISTS "cap_day";
ALTER TABLE "trust_requests" DROP COLUMN IF EXISTS "rejected_at";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261115000100_trust_requests_slots_rejected_at';
