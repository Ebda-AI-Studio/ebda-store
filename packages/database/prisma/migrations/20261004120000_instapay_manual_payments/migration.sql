-- InstaPay manual payments (SP6a).
--
-- InstaPay has no merchant API: the customer transfers to the merchant's handle
-- and the merchant confirms the money arrived. Until then the order sits in
-- `awaiting_payment_confirmation`: stock is held, nothing ships, no revenue is
-- booked. The hold expires (default 48h, per-store) and is released by a cron.
--
--   orders.status                            + awaiting_payment_confirmation
--   payment_configs.provider                 + instapay
--   orders.payment_confirmation_expires_at   the hold deadline (NULL otherwise)
--   payment_configs.settings                 non-secret per-provider settings
--                                            (InstaPay handle/phone/expiry, COD %)
--
-- No new table, so no new RLS policy: `orders` and `payment_configs` are already
-- ENABLEd + FORCEd with the strict store_id policy (20261004000000_ebda_strict_rls).
-- The two enum values are only ADDED here and never used in this file (a new enum
-- value cannot be referenced in the transaction that adds it).

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'awaiting_payment_confirmation';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'instapay';

ALTER TABLE "orders" ADD COLUMN "payment_confirmation_expires_at" TIMESTAMP(3);
ALTER TABLE "payment_configs" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX "orders_payment_confirmation_expires_at_idx" ON "orders" ("payment_confirmation_expires_at");
