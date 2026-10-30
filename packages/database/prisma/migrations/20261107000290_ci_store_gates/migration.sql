-- CI-13 (Customer Intelligence, Ruling CI-13): per-store auto-gating on calibration.
--
--   ci_store_gates  NEW, store-scoped (RLS). One row = THIS store's hints for `feature` are paused because
--                   its own hint log was off by more than 10 points (>= 30 resolved). Written by the weekly
--                   calibration job in the store's own scope; deleted when the store's own numbers recover
--                   or age out. Holds a band, three numbers and a timestamp: no buyer key, phone or text.
--
-- Store delete CASCADEs (FK below); no NO ACTION child is added. Customer erasure: nothing here is personal.
-- Lock note: new empty table, additive only; brief SHARE ROW EXCLUSIVE on "stores" for the FK.
-- Rollback: rollback.sql (DROP TABLE; loses only the pause state, hints resume at the next calibration).

-- CreateTable
CREATE TABLE "ci_store_gates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "feature" VARCHAR(24) NOT NULL,
    "band" VARCHAR(16) NOT NULL,
    "predicted_rate" DOUBLE PRECISION NOT NULL,
    "actual_rate" DOUBLE PRECISION NOT NULL,
    "resolved" INTEGER NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_store_gates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ci_store_gates_feature_check" CHECK ("feature" IN ('cod_risk', 'courier', 'fee')),
    CONSTRAINT "ci_store_gates_band_check" CHECK ("band" IN ('typical', 'elevated'))
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ci_store_gates_store_id_feature_key" ON "ci_store_gates"("store_id", "feature");

-- AddForeignKey
ALTER TABLE "ci_store_gates" ADD CONSTRAINT "ci_store_gates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE ci_store_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_store_gates FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON ci_store_gates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON ci_store_gates TO ebda_app;
