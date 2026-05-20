-- Accounting Batch 3: smart layer (reorder suggestions + deadstock flags + profit anomalies)

CREATE TYPE "ReorderSuggestionStatus" AS ENUM ('open','accepted','dismissed','expired');
CREATE TYPE "DeadStockFlagStatus"     AS ENUM ('open','accepted_clearance','dismissed','expired');
CREATE TYPE "AnomalyScope"            AS ENUM ('store','category','product');
CREATE TYPE "AnomalyMetric"           AS ENUM ('margin_drop','cost_spike','revenue_drop','refund_spike');
CREATE TYPE "AnomalySeverity"         AS ENUM ('warning','p0');

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "ocr_model_version" TEXT,
  ADD COLUMN IF NOT EXISTS "ocr_processed_at"  TIMESTAMP(3);

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "ai_features_enabled"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "ai_bulk_throttle_ms"   INTEGER NOT NULL DEFAULT 2500;

CREATE TABLE "reorder_suggestions" (
  "id"            TEXT NOT NULL,
  "store_id"      TEXT NOT NULL,
  "product_id"    TEXT NOT NULL,
  "variant_id"    TEXT,
  "suggested_qty" INTEGER NOT NULL,
  "velocity_7d"   DOUBLE PRECISION NOT NULL,
  "velocity_28d"  DOUBLE PRECISION NOT NULL,
  "on_hand"       INTEGER NOT NULL,
  "on_order"      INTEGER NOT NULL,
  "open_backlog"  INTEGER NOT NULL,
  "urgency_days"  INTEGER NOT NULL,
  "supplier_id"   TEXT,
  "reasoning_en"  TEXT NOT NULL,
  "reasoning_ar"  TEXT,
  "status"        "ReorderSuggestionStatus" NOT NULL DEFAULT 'open',
  "dismissed_by"  TEXT,
  "dismissed_at"  TIMESTAMP(3),
  "po_id"         TEXT,
  "scanned_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reorder_suggestions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reorder_suggestions_store_id_fkey"    FOREIGN KEY ("store_id")    REFERENCES "stores"("id")           ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "reorder_suggestions_product_id_fkey"  FOREIGN KEY ("product_id")  REFERENCES "products"("id")         ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "reorder_suggestions_variant_id_fkey"  FOREIGN KEY ("variant_id")  REFERENCES "product_variants"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "reorder_suggestions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")        ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "reorder_suggestions_uniq"     ON "reorder_suggestions"("store_id","product_id","variant_id","scanned_at");
CREATE INDEX        "reorder_suggestions_open_idx" ON "reorder_suggestions"("store_id","status","scanned_at" DESC);

CREATE TABLE "deadstock_flags" (
  "id"                      TEXT NOT NULL,
  "store_id"                TEXT NOT NULL,
  "product_id"              TEXT NOT NULL,
  "variant_id"              TEXT,
  "days_since_sale"         INTEGER NOT NULL,
  "stock_on_hand"           INTEGER NOT NULL,
  "stock_value_fils"        INTEGER NOT NULL,
  "suggested_discount_bps"  INTEGER NOT NULL,
  "clearance_copy_en"       TEXT NOT NULL,
  "clearance_copy_ar"       TEXT,
  "status"                  "DeadStockFlagStatus" NOT NULL DEFAULT 'open',
  "coupon_code"             TEXT,
  "dismissed_by"            TEXT,
  "dismissed_at"            TIMESTAMP(3),
  "scanned_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deadstock_flags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deadstock_flags_store_id_fkey"   FOREIGN KEY ("store_id")   REFERENCES "stores"("id")           ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "deadstock_flags_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id")         ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "deadstock_flags_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "deadstock_flags_uniq"     ON "deadstock_flags"("store_id","product_id","variant_id","scanned_at");
CREATE INDEX        "deadstock_flags_open_idx" ON "deadstock_flags"("store_id","status");

CREATE TABLE "profit_anomalies" (
  "id"               TEXT NOT NULL,
  "store_id"         TEXT NOT NULL,
  "scope"            "AnomalyScope" NOT NULL,
  "scope_id"         TEXT,
  "metric"           "AnomalyMetric" NOT NULL,
  "current_7d"       DOUBLE PRECISION NOT NULL,
  "baseline_28d"     DOUBLE PRECISION NOT NULL,
  "delta_percent"    DOUBLE PRECISION NOT NULL,
  "severity"         "AnomalySeverity" NOT NULL,
  "explanation_en"   TEXT NOT NULL,
  "explanation_ar"   TEXT,
  "acknowledged"     BOOLEAN NOT NULL DEFAULT false,
  "acknowledged_by"  TEXT,
  "acknowledged_at"  TIMESTAMP(3),
  "detected_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profit_anomalies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "profit_anomalies_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "profit_anomalies_recent_idx" ON "profit_anomalies"("store_id","severity","detected_at" DESC);
CREATE INDEX "profit_anomalies_open_idx"   ON "profit_anomalies"("store_id","acknowledged");

ALTER TABLE "reorder_suggestions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY reorder_suggestions_tenant_isolation ON "reorder_suggestions"
  USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "deadstock_flags" ENABLE ROW LEVEL SECURITY;
CREATE POLICY deadstock_flags_tenant_isolation ON "deadstock_flags"
  USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "profit_anomalies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY profit_anomalies_tenant_isolation ON "profit_anomalies"
  USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');
