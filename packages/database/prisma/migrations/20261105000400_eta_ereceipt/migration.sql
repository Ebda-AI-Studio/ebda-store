-- Egypt ETA e-receipt connector (Ruling ETA-1; docs/plans/2026-10-07-egypt-vat-and-eta.md addendum).
--
-- EXPAND ONLY (Ruling CF-MIGRATE-1): two new tables nothing existing reads. Both carry store_id and get
-- the single strict tenant policy every store_id table has (R-EBDA-001), so
-- tests/integration/rls-ebda-app.test.ts enumerates them automatically.
-- eta_receipts has no FK to orders on purpose (a fiscal record outlives order anonymisation).

-- CreateTable
CREATE TABLE "eta_connections" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'preprod',
    "credentials_enc" TEXT NOT NULL,
    "pos_serial" TEXT NOT NULL,
    "branch_code" TEXT NOT NULL,
    "activity_code" TEXT NOT NULL,
    "default_item_code" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "signing_bridge_url" TEXT,
    "last_check_status" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eta_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "eta_connections_environment_check" CHECK ("environment" IN ('preprod', 'prod'))
);

-- CreateTable
CREATE TABLE "eta_receipts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "environment" TEXT NOT NULL,
    "receipt_number" TEXT,
    "uuid" TEXT,
    "previous_uuid" TEXT,
    "document" JSONB,
    "total_piastres" INTEGER,
    "issued_at" TIMESTAMP(3),
    "deadline_at" TIMESTAMP(3),
    "submission_uuid" TEXT,
    "long_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eta_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "eta_receipts_kind_check" CHECK ("kind" IN ('sale', 'return')),
    CONSTRAINT "eta_receipts_status_check" CHECK ("status" IN ('queued', 'retrying', 'submitted', 'accepted', 'rejected', 'failed', 'late', 'manual')),
    CONSTRAINT "eta_receipts_environment_check" CHECK ("environment" IN ('preprod', 'prod'))
);

CREATE UNIQUE INDEX "eta_connections_store_id_key" ON "eta_connections"("store_id");
CREATE UNIQUE INDEX "eta_receipts_store_id_order_id_kind_seq_key" ON "eta_receipts"("store_id", "order_id", "kind", "seq");
CREATE INDEX "eta_receipts_store_id_status_next_attempt_at_idx" ON "eta_receipts"("store_id", "status", "next_attempt_at");
CREATE INDEX "eta_receipts_store_id_order_id_idx" ON "eta_receipts"("store_id", "order_id");
CREATE INDEX "eta_receipts_status_next_attempt_at_idx" ON "eta_receipts"("status", "next_attempt_at");

ALTER TABLE "eta_connections" ADD CONSTRAINT "eta_connections_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eta_receipts" ADD CONSTRAINT "eta_receipts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE eta_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE eta_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON eta_connections AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE eta_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE eta_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON eta_receipts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
