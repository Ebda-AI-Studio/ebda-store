-- ORDER: roll back 20261017000200_legal_notice_send_withdraw FIRST (its function reads these
-- tables), then this file. For each, run the rollback.sql, then
-- `npx prisma migrate resolve --rolled-back <migration_name>`. Revert the code (API AND admin:
-- the admin's Policy updates page, banner and signup checkbox call routes that read these
-- tables) and redeploy BEFORE dropping, or every legal route 500s in between.
-- Rollback of 20261017000100_legal_acceptances_and_notices: drops the three tables (the
-- acceptance history is lost; take a pg_dump of them first). Then revert the PR so
-- schema.prisma no longer declares the models, and `prisma migrate resolve --rolled-back`.
DROP TABLE IF EXISTS "legal_notice_deliveries";
DROP TABLE IF EXISTS "legal_notice_sends";
DROP TABLE IF EXISTS "legal_acceptances";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261017000100_legal_acceptances_and_notices';
