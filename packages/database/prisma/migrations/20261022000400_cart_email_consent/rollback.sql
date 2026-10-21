-- rollback.sql for 20261022000400_cart_email_consent.
-- Roll the CODE back first (checkout opt-in, detection and the cart email read these).
-- Loses the guest cart emails and which subscribers are cart-reminder-only (they become plain
-- newsletter subscribers after the columns go, so roll back BEFORE any cart_reminders row exists, or
-- delete those rows first: DELETE FROM newsletter_subscribers WHERE consent_scope = 'cart_reminders').
ALTER TABLE "carts" DROP COLUMN IF EXISTS "guest_email_consent_at";
ALTER TABLE "carts" DROP COLUMN IF EXISTS "guest_email";
ALTER TABLE "newsletter_subscribers" DROP COLUMN IF EXISTS "consent_at";
ALTER TABLE "newsletter_subscribers" DROP COLUMN IF EXISTS "consent_scope";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022000400_cart_email_consent';
