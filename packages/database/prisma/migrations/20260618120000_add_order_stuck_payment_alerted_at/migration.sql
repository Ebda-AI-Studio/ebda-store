-- Add stuck-payment merchant-alert dedupe column to orders table.
--
-- The stuck-payment sweep (Inngest cron, every 15 min) finds online-payment
-- orders left status=pending / payment_status=unpaid past STUCK_PAYMENT_MINUTES
-- and pushes the merchant ONE "payment pending — follow up" alert so they can
-- contact the customer. This column records when that alert was sent so the
-- sweep query excludes already-alerted orders and never double-alerts.
--
-- Additive / safe: nullable, no default. Every existing order row is treated as
-- not-yet-alerted (NULL), which is the correct interpretation — the sweep only
-- targets recent pending/unpaid online orders, so historical rows are ignored
-- by the createdAt window regardless.

ALTER TABLE "orders" ADD COLUMN "stuck_payment_alerted_at" TIMESTAMP(3);
