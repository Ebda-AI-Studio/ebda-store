-- rollback.sql for 20261117000200_instapay_auto_confirm. Roll the CODE back first (the auto-confirm path reads this table). Drops every auto-confirm decision row;
-- the billing events and claims they point at are untouched.
DROP TABLE IF EXISTS "instapay_auto_confirmations";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261117000200_instapay_auto_confirm';
