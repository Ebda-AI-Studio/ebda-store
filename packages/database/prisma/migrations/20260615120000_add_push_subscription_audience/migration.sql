-- Tag each web-push subscription with the AUDIENCE (app) it belongs to so a
-- single store can have distinct push fan-outs per surface:
--   - 'storefront'  → shopper devices (the existing storefront subscribe flow)
--   - 'orders_app'  → staff/admin devices running the Orders PWA
--
-- Why a column and not a separate table: the delivery mechanics (VAPID keys,
-- endpoint/p256dh/auth, 410-cleanup, NotificationLog) are identical for both
-- audiences — only the targeting differs. A tag keeps one delivery path and
-- one cleanup path while letting the Orders-PWA push step target only staff
-- devices (and never double-send to shoppers).
--
-- Additive + defaulted: existing rows were all storefront subscriptions, so the
-- DEFAULT 'storefront' backfills them correctly with no data migration.
--
-- RLS: `push_subscriptions` is already FORCE-RLS (tenant-scoped via
-- app.current_store_id — see 20260609000000_complete_force_rls_coverage).
-- Row security covers every column, so adding a column needs no new policy.
ALTER TABLE "push_subscriptions"
  ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'storefront';

-- Targeting reads filter by (store_id, audience); index that access path so the
-- Orders-PWA fan-out stays fast as subscription volume grows.
CREATE INDEX "push_subscriptions_store_id_audience_idx"
  ON "push_subscriptions" ("store_id", "audience");
