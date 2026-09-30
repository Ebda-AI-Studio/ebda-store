-- Migration: refund_claim_and_stock_marker_indexes
--
-- Two index-only additions for reads that scanned a whole partition.
--
-- 1. payment_events (event_type, occurred_at) — issue 2028. The stuck
--    refund-claim sweep runs every 15 minutes across every tenant and filters
--    `event_type = 'refund_initiated' AND occurred_at > <7 days ago>`. The
--    only index on event_type was the low-selectivity single-column one.
--
-- 2. inventory_history (store_id, reference) — issue 2139. The order-refunded
--    fanout probes `reference = <orderId> AND store_id = …` twice per whole-
--    order refund (the stock marker and the legacy-rollback marker), inside
--    withMoneyTx while holding the order row FOR UPDATE. With only
--    (store_id) available Postgres filtered every stock movement the tenant
--    ever made.
--
-- ADDITIVE, index-only: no column, no data change, RLS unchanged. Plain
-- CREATE INDEX (not CONCURRENTLY — Prisma runs each migration in a
-- transaction); both tables are append-only logs and the build is short.
CREATE INDEX IF NOT EXISTS "payment_events_event_type_occurred_at_idx"
  ON "payment_events" ("event_type", "occurred_at");

CREATE INDEX IF NOT EXISTS "inventory_history_store_id_reference_idx"
  ON "inventory_history" ("store_id", "reference");
