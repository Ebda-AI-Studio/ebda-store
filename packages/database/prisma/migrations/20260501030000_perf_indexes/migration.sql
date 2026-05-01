-- Performance indexes — see docs/perf/index-audit-2026-05.md for rationale.
--
-- 1. Storefront product list — covering composite for the
--    (store_id, deleted_at, created_at DESC) query pattern. Today's
--    planner picks `products_store_id_idx` and filters / sorts in
--    memory; this composite turns it into an ordered index scan.
CREATE INDEX IF NOT EXISTS "products_store_id_deleted_at_created_at_idx"
  ON "products" ("store_id", "deleted_at", "created_at" DESC);

-- 2. Admin orders list — currently falls back to seq scan because no
--    (store_id, created_at) index exists. Fine at 21 rows; bad at
--    1000+. Adding before we hit the cliff.
CREATE INDEX IF NOT EXISTS "orders_store_id_created_at_idx"
  ON "orders" ("store_id", "created_at" DESC);

-- 3. Store-scoped audit log reads — admin "audit logs for this store"
--    page. Composite of (store_id, created_at DESC) so we don't need
--    a separate Filter step on top of the created_at index.
CREATE INDEX IF NOT EXISTS "audit_logs_store_id_created_at_idx"
  ON "audit_logs" ("store_id", "created_at" DESC);

