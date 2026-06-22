-- Migration: 20260622130000_payment_gateway_abandoned_at
--
-- Adds paymentGatewayAbandonedAt to Order to track shoppers who reached
-- a payment gateway (a Payment row with paymentUrl exists) but never
-- completed payment. Used by the Enterprise payment-abandonment-capture
-- feature (feature key: payment_abandonment). The column is NULL for all
-- existing orders; the Inngest cron stamps it when it detects a gateway
-- abandoner. NULL = not a gateway abandoner (or not yet evaluated).
--
-- RLS: the orders table already has FORCE RLS with a SELECT+INSERT+UPDATE
-- policy scoped to (store_id). This column is part of the existing row —
-- no additional policy needed.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "payment_gateway_abandoned_at" TIMESTAMPTZ;

-- Index supports the abandonment sweep (WHERE payment_gateway_abandoned_at IS NULL
-- AND status = 'pending' AND ...) and the admin list (WHERE
-- payment_gateway_abandoned_at IS NOT NULL ORDER BY created_at DESC).
CREATE INDEX IF NOT EXISTS "orders_payment_gateway_abandoned_at_idx"
  ON "orders" ("store_id", "payment_gateway_abandoned_at")
  WHERE "payment_gateway_abandoned_at" IS NOT NULL;
