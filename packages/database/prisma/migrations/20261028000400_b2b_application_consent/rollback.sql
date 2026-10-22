-- rollback.sql for 20261028000400_b2b_application_consent. Safe: drops only the consent timestamp.
ALTER TABLE "wholesale_applications" DROP COLUMN IF EXISTS "consent_at";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000400_b2b_application_consent';
