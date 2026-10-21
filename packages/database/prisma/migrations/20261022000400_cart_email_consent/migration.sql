-- Purpose-specific email consent + guest cart email (cart-email-campaigns, review item 1).
--
--   newsletter_subscribers  + consent_scope ('newsletter' default | 'cart_reminders') and
--                             consent_at. Existing rows are all newsletter consent (the default).
--                             A 'cart_reminders' subscriber is excluded from campaign audiences.
--   carts                   + guest_email, guest_email_consent_at: set only when the shopper ticks
--                             the checkout box. Lets the recovery email reach guests.
--
-- Additive nullable/defaulted columns; no backfill, no data change, nothing is sent. RLS unchanged
-- (both tables already carry store_id and the strict policy). Constant defaults are metadata-only
-- on PG11+.
-- Rollback: rollback.sql.

ALTER TABLE "newsletter_subscribers" ADD COLUMN IF NOT EXISTS "consent_scope" TEXT NOT NULL DEFAULT 'newsletter';
ALTER TABLE "newsletter_subscribers" ADD COLUMN IF NOT EXISTS "consent_at" TIMESTAMP(3);

ALTER TABLE "carts" ADD COLUMN IF NOT EXISTS "guest_email" TEXT;
ALTER TABLE "carts" ADD COLUMN IF NOT EXISTS "guest_email_consent_at" TIMESTAMP(3);
