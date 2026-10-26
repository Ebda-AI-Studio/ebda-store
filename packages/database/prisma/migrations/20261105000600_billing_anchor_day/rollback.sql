ALTER TABLE "store_subscriptions" DROP CONSTRAINT IF EXISTS "store_subscriptions_billing_anchor_day_check";
ALTER TABLE "store_subscriptions" DROP COLUMN IF EXISTS "billing_anchor_day";
