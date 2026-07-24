-- Answer Engine Insights (AEO): Google Search Console daily metrics
--
-- GscDailyMetric is an aggregate-not-event table (mirrors product_daily_views):
-- one row per store/date, upserted idempotently by the GSC ingestion cron
-- (impressions/clicks/ctr/avg position/top queries). The dashboard reads it.

CREATE TABLE "gsc_daily_metrics" (
    "id"           TEXT         NOT NULL,
    "store_id"     TEXT         NOT NULL,
    "date"         DATE         NOT NULL,
    "impressions"  INTEGER      NOT NULL DEFAULT 0,
    "clicks"       INTEGER      NOT NULL DEFAULT 0,
    "ctr"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "top_queries"  JSONB        NOT NULL DEFAULT '[]',
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gsc_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- FK: store (cascade-delete the metric history when the store is removed)
ALTER TABLE "gsc_daily_metrics"
    ADD CONSTRAINT "gsc_daily_metrics_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "gsc_daily_metrics_store_id_date_key"
    ON "gsc_daily_metrics"("store_id", "date");

CREATE INDEX "gsc_daily_metrics_store_id_date_idx"
    ON "gsc_daily_metrics"("store_id", "date" DESC);

-- ── Row Level Security (hybrid tenant predicate, mirrors answer_engine_checks / order_events) ──
-- Allow when no tenant context is set (webhook / super-admin / scheduled job
-- via withRlsBypass), when app.bypass_rls='true' (Inngest / cron ingestion
-- write), OR when the store matches the GUC (dashboard read via
-- runInTenantContext). current_store_id() =
-- NULLIF(current_setting('app.current_store_id',true),'').
DROP POLICY IF EXISTS rls_gsc_daily_metrics_tenant ON gsc_daily_metrics;
ALTER TABLE gsc_daily_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_gsc_daily_metrics_tenant ON gsc_daily_metrics
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
ALTER TABLE gsc_daily_metrics FORCE ROW LEVEL SECURITY;
