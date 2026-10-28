ALTER TABLE "store_subscriptions" DROP CONSTRAINT IF EXISTS "store_subscriptions_billing_anchor_day_check";
ALTER TABLE "store_subscriptions" DROP COLUMN IF EXISTS "billing_anchor_day";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261106000240_billing_anchor_day';
