-- Abandoned-cart recovery EMAIL channel (cart-email-campaigns, 2026-10-21).
--
--   abandoned_cart_configs  + email_enabled (default false: a merchant opts in) and
--                             email_delay_minutes (default 120; the API validates 60..1440).
--   abandoned_carts         + email_status / email_detail / email_sent_at: the per-cart state of
--                             the single reminder email. NULL = not claimed; the sweep claims
--                             NULL -> 'queued' with one UPDATE, which is what makes the email
--                             once-per-cart. Independent of the push/SMS `status` column.
--
-- Additive, nullable or defaulted columns on two existing tables: no backfill, no data change,
-- nothing is sent by this migration (email_enabled is false everywhere), RLS policies unchanged
-- (both tables already carry store_id and the strict policy). ADD COLUMN with a constant default
-- is metadata-only on PG11+.
-- Rollback: rollback.sql.

ALTER TABLE "abandoned_cart_configs" ADD COLUMN IF NOT EXISTS "email_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "abandoned_cart_configs" ADD COLUMN IF NOT EXISTS "email_delay_minutes" INTEGER NOT NULL DEFAULT 120;

ALTER TABLE "abandoned_carts" ADD COLUMN IF NOT EXISTS "email_status" TEXT;
ALTER TABLE "abandoned_carts" ADD COLUMN IF NOT EXISTS "email_detail" TEXT;
ALTER TABLE "abandoned_carts" ADD COLUMN IF NOT EXISTS "email_sent_at" TIMESTAMP(3);

-- The per-store 24h cart-email cap and the shared send budget count by (store_id, email_sent_at).
CREATE INDEX IF NOT EXISTS "abandoned_carts_store_id_email_sent_at_idx" ON "abandoned_carts"("store_id", "email_sent_at");
