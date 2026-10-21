-- rollback.sql for 20261025000100_merchant_webhooks.
-- Roll the CODE back first (the webhook fan-out and delivery functions write these tables).
-- Loses only merchants' webhook endpoint config and the delivery log; no other table references them.
DROP TABLE IF EXISTS "webhook_deliveries";
DROP TABLE IF EXISTS "webhook_endpoints";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261025000100_merchant_webhooks';
