-- Append-only audit trail for Order.status changes.
--
-- Orders mutate `status` in place (order.service.ts updateStatus) with no
-- immutable record of who moved the order and when. This adds a forward-only
-- trail — rows are written once and never updated. No backfill: history starts
-- accruing from the first status change after this migration applies.
--
-- Mirrors the payment_events / affiliate_events pattern: TEXT ids (Prisma
-- @default(uuid())), denormalized store_id so store-scoped RLS + admin timeline
-- queries don't have to join back through orders.

CREATE TABLE "order_events" (
    "id"          TEXT         NOT NULL,
    "store_id"    TEXT         NOT NULL,
    "order_id"    TEXT         NOT NULL,
    "from_status" TEXT,
    "to_status"   TEXT         NOT NULL,
    "actor_id"    TEXT,
    "metadata"    JSONB        NOT NULL DEFAULT '{}',
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- FK: order (cascade-delete the trail when the order is removed)
ALTER TABLE "order_events"
    ADD CONSTRAINT "order_events_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: store (cascade-delete the trail when the store is removed)
ALTER TABLE "order_events"
    ADD CONSTRAINT "order_events_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: acting admin/user (set null when the user is deleted)
ALTER TABLE "order_events"
    ADD CONSTRAINT "order_events_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Timeline per order (show one order's history) + per store (admin overview).
CREATE INDEX "order_events_order_id_idx" ON "order_events"("order_id");
CREATE INDEX "order_events_store_id_idx" ON "order_events"("store_id");

-- ── Row Level Security (hybrid tenant predicate, mirrors 20260609000000) ──
-- Same idiom as affiliate_events / payment_events: allow when no tenant
-- context is set (webhook / super-admin), when app.bypass_rls='true' (Inngest /
-- cron / super-admin via withRlsBypass), OR when the store matches the GUC.
-- current_store_id() = NULLIF(current_setting('app.current_store_id',true),'').
DROP POLICY IF EXISTS rls_order_events_tenant ON order_events;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_order_events_tenant ON order_events
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;
