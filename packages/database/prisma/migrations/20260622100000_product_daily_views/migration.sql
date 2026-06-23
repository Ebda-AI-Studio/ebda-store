-- Migration: product_daily_views
--
-- Per-day per-product view counter for the checkout funnel analytics.
-- This table replaces the hardcoded `const productViews = 0` in analytics-rollup.service.ts.
--
-- Design choices:
--   • One aggregate row per (store, product, UTC date) — NOT a row per view.
--     A busy product PDP could get thousands of hits; per-row would be unbounded.
--   • `count` is incremented via upsert (INSERT ... ON CONFLICT DO UPDATE SET count = count + N).
--   • The date column stores a DATE (DateOnly) as a timestamptz at UTC midnight so
--     Prisma's DateTime maps cleanly. The application always writes kwDayStart() values.
--   • Indexed on (store_id, date) for the rollup query that sums across all products
--     in a store for a given day range.
--
-- RLS: apply the same store_id GUC pattern as every other analytics table.

CREATE TABLE "product_daily_views" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "store_id"   TEXT        NOT NULL,
  "product_id" TEXT        NOT NULL,
  "date"       DATE        NOT NULL,
  "count"      INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT "product_daily_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_daily_views_fkey_store"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE,
  CONSTRAINT "product_daily_views_fkey_product"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
  CONSTRAINT "product_daily_views_store_product_date_key"
    UNIQUE ("store_id", "product_id", "date")
);

-- Rollup query pattern: SUM(count) WHERE store_id = $1 AND date >= $2 AND date <= $3
CREATE INDEX "product_daily_views_store_date_idx"
  ON "product_daily_views" ("store_id", "date" DESC);

-- Product-level lookup (not used by rollup but useful for future per-product analytics)
CREATE INDEX "product_daily_views_product_idx"
  ON "product_daily_views" ("product_id", "date" DESC);

-- RLS: ingest endpoint writes as the app role with bypass for the upsert.
-- The store_id foreign key + the ingest service's explicit store ownership
-- check (verify product belongs to store) are the authorization gates.
ALTER TABLE "product_daily_views" ENABLE ROW LEVEL SECURITY;

-- SELECT policy: app role can read rows for stores it has been granted access to
-- via the per-request GUC (current_setting('app.current_store_id', true)).
CREATE POLICY "product_daily_views_store_select"
  ON "product_daily_views"
  FOR SELECT
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'on'
  );

-- INSERT policy: allow insert when bypassing RLS (service role / ingest endpoint).
CREATE POLICY "product_daily_views_store_insert"
  ON "product_daily_views"
  FOR INSERT
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
  );

-- UPDATE policy: allow update when bypassing RLS (upsert increment).
CREATE POLICY "product_daily_views_store_update"
  ON "product_daily_views"
  FOR UPDATE
  USING (
    current_setting('app.bypass_rls', true) = 'on'
  );
