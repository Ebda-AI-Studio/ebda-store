-- QR-1: merchant QR code scan counters.
--
--   qr_scan_daily   NEW, store-scoped. One row per (store, Cairo day, kind, ref): a counter, not
--                   an event log. No user id, session id, IP or user agent is stored. `ref` is a
--                   product/category id ('' for the store and WhatsApp codes) and is only written
--                   for a code that resolved to a real entity, so rows are bounded by the catalogue.
--
-- Viewer: admin /stores/[id]/qr (scans per code, last 30 days).
-- Retention: 400 days (purge in the data-retention job). Store delete CASCADEs (FK below); no
-- NO ACTION child is added. Customer erasure: nothing to remove (no identity).
-- Lock note: new empty table, additive only; brief SHARE ROW EXCLUSIVE on "stores" for the FK.
-- Rollback: rollback.sql (DROP TABLE qr_scan_daily; loses only the scan counters).

-- CreateTable
CREATE TABLE "qr_scan_daily" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "ref" VARCHAR(64) NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "qr_scan_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "qr_scan_daily_store_id_date_kind_ref_key" ON "qr_scan_daily"("store_id", "date", "kind", "ref");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "qr_scan_daily_store_id_date_idx" ON "qr_scan_daily"("store_id", "date" DESC);

-- AddForeignKey
ALTER TABLE "qr_scan_daily" ADD CONSTRAINT "qr_scan_daily_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE qr_scan_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_scan_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON qr_scan_daily AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON qr_scan_daily TO ebda_app;
