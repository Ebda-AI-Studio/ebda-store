-- BILLING-INTERVAL-PENDING-1: interval picked at checkout on an ACTIVE subscription, applied only when its payment is recorded.
-- Additive, nullable. NULL = no switch pending.
ALTER TABLE "store_subscriptions" ADD COLUMN "pending_billing_interval" TEXT;
