-- Rollback of 20261017000100_legal_acceptances_and_notices: drops the three tables (the
-- acceptance history is lost; take a pg_dump of them first). Then revert the PR so
-- schema.prisma no longer declares the models, and `prisma migrate resolve --rolled-back`.
DROP TABLE IF EXISTS "legal_notice_deliveries";
DROP TABLE IF EXISTS "legal_notice_sends";
DROP TABLE IF EXISTS "legal_acceptances";
