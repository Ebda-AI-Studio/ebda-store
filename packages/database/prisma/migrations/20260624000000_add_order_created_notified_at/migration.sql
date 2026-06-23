-- Migration: 20260624000000_add_order_created_notified_at
--
-- Per-order dedupe stamp for the order/created notification fanout.
--
-- Why: the order/created event (new-order email + admin OneSignal push +
-- channel dispatch) can be enqueued for the SAME paid order by both the
-- customer-return "confirm" path (payment-confirm.service.ts) and the payment
-- webhook consumer (payment-webhook-process → handleWebhook → payment.factory),
-- and Inngest delivers at-least-once. The old fn had only a per-STORE
-- concurrency limiter, not a per-ORDER dedupe, so a paid order could produce two
-- "new order" pushes/emails. The async webhook offload (PR #381) widened that
-- race from ~0 to a 1-5s window that overlaps real customer-redirect timing.
--
-- The order-created Inngest fn now atomically claims this column
-- (UPDATE orders SET order_created_notified_at = now() WHERE id = $1 AND
-- order_created_notified_at IS NULL) and skips the whole fanout when the claim
-- matches 0 rows, so the fanout fires exactly once per order.
--
-- Additive nullable column — metadata-only, no table rewrite, no lock of note.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "order_created_notified_at" TIMESTAMP(3);
