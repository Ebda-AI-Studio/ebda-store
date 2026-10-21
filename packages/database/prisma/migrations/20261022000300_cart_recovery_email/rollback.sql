-- rollback.sql for 20261022000300_cart_recovery_email.
-- Roll the CODE back first (the abandoned-cart service and the cart-recovery-email job read these).
-- Loses only the email channel's per-cart state and the merchant's email toggle/delay.
ALTER TABLE "abandoned_carts" DROP COLUMN IF EXISTS "email_sent_at";
ALTER TABLE "abandoned_carts" DROP COLUMN IF EXISTS "email_detail";
ALTER TABLE "abandoned_carts" DROP COLUMN IF EXISTS "email_status";
ALTER TABLE "abandoned_cart_configs" DROP COLUMN IF EXISTS "email_delay_minutes";
ALTER TABLE "abandoned_cart_configs" DROP COLUMN IF EXISTS "email_enabled";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022000300_cart_recovery_email';
