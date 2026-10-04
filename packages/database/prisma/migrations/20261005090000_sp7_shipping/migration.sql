-- SP7: the shipping layer (Bosta, Aramex, manual carrier) and COD reconciliation.
--
--   shipments            + cod_amount (piastres the carrier must collect), carrier_transaction_id,
--                          carrier_name (manual carrier), create_attempts, last_polled_at
--   cod_remittances      NEW, store-scoped: one row per line of a carrier's COD settlement
--                          (gross collected, the carrier's fee, net remitted, all piastres)
--
-- shipments.status stays free text; `creation_failed` is a new value (booking with the carrier
-- failed, the row carries the error and is retried).

ALTER TABLE "shipments" ADD COLUMN "cod_amount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shipments" ADD COLUMN "carrier_transaction_id" TEXT;
ALTER TABLE "shipments" ADD COLUMN "carrier_name" TEXT;
ALTER TABLE "shipments" ADD COLUMN "create_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shipments" ADD COLUMN "last_polled_at" TIMESTAMP(3);

CREATE TABLE "cod_remittances" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "carrier" TEXT NOT NULL,
    "tracking_number" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "batch_id" TEXT,
    "gross_amount" INTEGER NOT NULL,
    "fee_amount" INTEGER NOT NULL DEFAULT 0,
    "net_amount" INTEGER NOT NULL,
    "remitted_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'csv',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_remittances_pkey" PRIMARY KEY ("id"),
    -- a line never remits more than it collected, and net is exactly gross minus the fee
    CONSTRAINT "cod_remittances_net_check" CHECK ("net_amount" = "gross_amount" - "fee_amount"),
    CONSTRAINT "cod_remittances_nonneg_check" CHECK ("gross_amount" >= 0 AND "fee_amount" >= 0)
);

CREATE UNIQUE INDEX "cod_remittances_store_id_carrier_line_ref_key" ON "cod_remittances"("store_id", "carrier", "line_ref");
CREATE INDEX "cod_remittances_store_id_shipment_id_idx" ON "cod_remittances"("store_id", "shipment_id");
CREATE INDEX "cod_remittances_store_id_tracking_number_idx" ON "cod_remittances"("store_id", "tracking_number");

ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-002): the same single policy every store_id table carries.
ALTER TABLE cod_remittances ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_remittances FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON cod_remittances AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
