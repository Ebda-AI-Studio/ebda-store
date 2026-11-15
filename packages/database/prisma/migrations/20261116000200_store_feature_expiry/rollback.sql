-- Rollback for 20261116000200_store_feature_expiry. DATA LOSS: every override's expiry and reason is dropped; an override
-- that was meant to expire then lasts forever, so re-check the sold/granted ones by hand afterwards.
ALTER TABLE "store_features" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "store_features" DROP COLUMN IF EXISTS "reason";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261116000200_store_feature_expiry';
