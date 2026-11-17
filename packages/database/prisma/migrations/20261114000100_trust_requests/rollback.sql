-- rollback.sql for 20261114000100_trust_requests. Roll the CODE back first. Drops all staged requests.
DROP TABLE IF EXISTS "trust_requests";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261114000100_trust_requests';
