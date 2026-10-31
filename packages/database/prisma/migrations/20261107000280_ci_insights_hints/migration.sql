-- CI-2 / CI-3 (Customer Intelligence, Ruling CI-9..CI-12).
--
--   ci_insights   NEW, platform table (no store_id). Findings derived from cross-store cohort cells that
--                 already passed the k-thresholds; holds no store, order or buyer identifier. Viewer:
--                 admin /platform/ci-insights (accept / dismiss).
--   ci_hint_logs  NEW, store-scoped (RLS). One row per (order, feature) a merchant was shown a hint for,
--                 with the sample size behind it and later the outcome; feeds the weekly calibration.
--                 No buyer key, no phone, no free text.
--
-- Retention: ci_hint_logs 400 days (data-retention job). Store delete and order delete CASCADE (FKs below);
-- no NO ACTION child is added. Customer erasure: the rows go with the order.
-- Lock note: new empty tables, additive only; brief SHARE ROW EXCLUSIVE on "stores" and "orders" for the FKs.
-- Rollback: rollback.sql (DROP TABLE; loses only insights and hint logs).

-- CreateTable
CREATE TABLE "ci_insights" (
    "id" TEXT NOT NULL,
    "dedupe_key" VARCHAR(160) NOT NULL,
    "metric" VARCHAR(40) NOT NULL,
    "cohort" VARCHAR(120) NOT NULL,
    "finding" VARCHAR(400) NOT NULL,
    "finding_ar" VARCHAR(400) NOT NULL,
    "evidence" JSONB NOT NULL,
    "model" VARCHAR(40) NOT NULL DEFAULT 'rules-v1',
    "status" VARCHAR(12) NOT NULL DEFAULT 'new',
    "as_of" DATE NOT NULL,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_insights_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ci_insights_status_check" CHECK ("status" IN ('new', 'accepted', 'dismissed'))
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ci_insights_dedupe_key_key" ON "ci_insights"("dedupe_key");
CREATE INDEX IF NOT EXISTS "ci_insights_status_created_at_idx" ON "ci_insights"("status", "created_at" DESC);

GRANT SELECT, INSERT, UPDATE ON ci_insights TO ebda_app;

-- CreateTable
CREATE TABLE "ci_hint_logs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "feature" VARCHAR(24) NOT NULL,
    "band" VARCHAR(16) NOT NULL,
    "source" VARCHAR(8) NOT NULL,
    "n" INTEGER NOT NULL DEFAULT 0,
    "predicted_rate" DOUBLE PRECISION,
    "outcome" VARCHAR(12),
    "outcome_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_hint_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ci_hint_logs_band_check" CHECK ("band" IN ('typical', 'elevated', 'insufficient')),
    CONSTRAINT "ci_hint_logs_source_check" CHECK ("source" IN ('store', 'cohort', 'none')),
    CONSTRAINT "ci_hint_logs_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('delivered', 'returned'))
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ci_hint_logs_order_id_feature_key" ON "ci_hint_logs"("order_id", "feature");
CREATE INDEX IF NOT EXISTS "ci_hint_logs_store_id_created_at_idx" ON "ci_hint_logs"("store_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ci_hint_logs_feature_outcome_created_at_idx" ON "ci_hint_logs"("feature", "outcome", "created_at");

-- AddForeignKey
ALTER TABLE "ci_hint_logs" ADD CONSTRAINT "ci_hint_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ci_hint_logs" ADD CONSTRAINT "ci_hint_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE ci_hint_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_hint_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON ci_hint_logs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON ci_hint_logs TO ebda_app;
