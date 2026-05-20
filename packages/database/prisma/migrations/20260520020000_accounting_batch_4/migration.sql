-- Accounting Batch 4: insights tier (cohort + funnel + RFM snapshots)

CREATE TYPE "RfmSegment" AS ENUM ('vip','loyal','potential','new_customer','at_risk','hibernating','lost');

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "ai_narration_enabled"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "insights_rollup_cron"   TEXT NOT NULL DEFAULT 'daily';

CREATE TABLE "customer_cohort_snapshots" (
  "id"               TEXT NOT NULL,
  "store_id"         TEXT NOT NULL,
  "cohort_month"     TEXT NOT NULL,
  "period_offset"    INTEGER NOT NULL,
  "customers_total"  INTEGER NOT NULL,
  "customers_active" INTEGER NOT NULL,
  "orders_in_period" INTEGER NOT NULL,
  "revenue_in_period" INTEGER NOT NULL,
  "computed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_cohort_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_cohort_snapshots_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customer_cohort_snapshots_uniq" ON "customer_cohort_snapshots"("store_id","cohort_month","period_offset");
CREATE INDEX        "customer_cohort_snapshots_month_idx" ON "customer_cohort_snapshots"("store_id","cohort_month");

CREATE TABLE "funnel_snapshots" (
  "id"                TEXT NOT NULL,
  "store_id"          TEXT NOT NULL,
  "period_date"       TIMESTAMP(3) NOT NULL,
  "product_views"     INTEGER NOT NULL,
  "carts_created"     INTEGER NOT NULL,
  "cart_items_added"  INTEGER NOT NULL,
  "checkouts_started" INTEGER NOT NULL,
  "orders_completed"  INTEGER NOT NULL,
  "orders_abandoned"  INTEGER NOT NULL,
  "revenue_fils"      INTEGER NOT NULL,
  "computed_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "funnel_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "funnel_snapshots_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "funnel_snapshots_uniq" ON "funnel_snapshots"("store_id","period_date");
CREATE INDEX        "funnel_snapshots_date_idx" ON "funnel_snapshots"("store_id","period_date" DESC);

CREATE TABLE "customer_rfm_snapshots" (
  "id"               TEXT NOT NULL,
  "store_id"         TEXT NOT NULL,
  "customer_id"      TEXT NOT NULL,
  "is_guest"         BOOLEAN NOT NULL DEFAULT false,
  "recency_days"     INTEGER NOT NULL,
  "frequency_orders" INTEGER NOT NULL,
  "monetary_fils"    INTEGER NOT NULL,
  "rfm_score"        INTEGER NOT NULL,
  "segment"          "RfmSegment" NOT NULL,
  "previous_segment" "RfmSegment",
  "computed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_rfm_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_rfm_snapshots_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customer_rfm_snapshots_uniq"     ON "customer_rfm_snapshots"("store_id","customer_id");
CREATE INDEX        "customer_rfm_snapshots_seg_idx"  ON "customer_rfm_snapshots"("store_id","segment");
CREATE INDEX        "customer_rfm_snapshots_top_idx"  ON "customer_rfm_snapshots"("store_id","rfm_score" DESC);

ALTER TABLE "customer_cohort_snapshots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_cohort_snapshots_tenant ON "customer_cohort_snapshots"
  USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "funnel_snapshots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY funnel_snapshots_tenant ON "funnel_snapshots"
  USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "customer_rfm_snapshots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_rfm_snapshots_tenant ON "customer_rfm_snapshots"
  USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');
