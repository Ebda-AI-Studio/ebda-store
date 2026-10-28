-- M-125 (P10): the day of month a paid billing cycle started on, so a short month does not move the cycle for ever.
ALTER TABLE "store_subscriptions" ADD COLUMN "billing_anchor_day" INTEGER;
ALTER TABLE "store_subscriptions"
  ADD CONSTRAINT "store_subscriptions_billing_anchor_day_check"
  CHECK ("billing_anchor_day" IS NULL OR ("billing_anchor_day" BETWEEN 1 AND 31));
