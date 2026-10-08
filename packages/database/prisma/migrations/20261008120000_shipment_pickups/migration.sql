-- Shipment pickups (PROVIDERS-18, docs/plans/2026-10-07-egypt-payments-shipping-integrations.md).
--
--   shipment_pickups  NEW, store-scoped. A courier pickup the merchant asked a carrier for
--                     (Bosta / Aramex / Mylerz). ShipBlu requests its own at booking and writes
--                     no row here.
--
-- Additive only. store_id, so the single strict R-EBDA-001 policy applies directly.
-- FKs: store delete / shipment delete CASCADE (no NO ACTION child added).
-- Idempotency: UNIQUE (store_id, idempotency_key) = a double-submitted request is one row and
-- one carrier call; partial UNIQUE (shipment_id) WHERE active = one live pickup per shipment.
-- Rollback: DROP TABLE shipment_pickups (docs/ROLLBACK.md). A pickup already booked at the
-- carrier stays booked there; cancel it in the carrier's portal.

-- CreateTable
CREATE TABLE "shipment_pickups" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requesting',
    "pickup_date" TEXT NOT NULL,
    "window_from" TEXT,
    "window_to" TEXT,
    "window_id" TEXT,
    "window_label" TEXT,
    "carrier_pickup_id" TEXT,
    "carrier_reference" TEXT,
    "carrier_time_slot" TEXT,
    "address" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "error" TEXT,
    "requested_by_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_pickups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_pickups_store_id_idx" ON "shipment_pickups"("store_id");

-- CreateIndex
CREATE INDEX "shipment_pickups_shipment_id_idx" ON "shipment_pickups"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_pickups_store_id_idempotency_key_key" ON "shipment_pickups"("store_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "shipment_pickups" ADD CONSTRAINT "shipment_pickups_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_pickups" ADD CONSTRAINT "shipment_pickups_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live pickup per shipment (not expressible in the Prisma schema).
CREATE UNIQUE INDEX "shipment_pickups_one_active" ON "shipment_pickups"("shipment_id") WHERE "status" IN ('requesting', 'requested');

ALTER TABLE "shipment_pickups" ADD CONSTRAINT "shipment_pickups_status_check" CHECK ("status" IN ('requesting', 'requested', 'failed', 'cancelled'));
ALTER TABLE "shipment_pickups" ADD CONSTRAINT "shipment_pickups_date_check" CHECK ("pickup_date" ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE "shipment_pickups" ADD CONSTRAINT "shipment_pickups_window_check" CHECK (
  ("window_from" IS NULL OR "window_from" ~ '^\d{2}:\d{2}$') AND
  ("window_to" IS NULL OR "window_to" ~ '^\d{2}:\d{2}$') AND
  ("window_from" IS NULL OR "window_to" IS NULL OR "window_from" < "window_to")
);
ALTER TABLE "shipment_pickups" ADD CONSTRAINT "shipment_pickups_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 100);

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE shipment_pickups ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_pickups FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON shipment_pickups AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
