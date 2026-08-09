-- Migration: store_usage_snapshots
--
-- One row per store per calendar month recording what that merchant actually
-- used. Every usage number in this system was previously a POINT IN TIME — you
-- could ask "how many products does this store have" but never "how fast is it
-- growing" — so plan-tier ceilings had to be guessed instead of derived.
--
-- Idempotent on (store_id, period_start): the monthly cron UPSERTs, so a re-run
-- or a manual backfill overwrites cleanly rather than duplicating. Snapshots
-- cover a CLOSED month, so the values never move once written.
--
-- Purely additive: a new table, no changes to existing ones, nothing to
-- backfill, no lock of consequence.

CREATE TABLE "store_usage_snapshots" (
  "id"                 TEXT NOT NULL,
  "store_id"           TEXT NOT NULL,
  "period_start"       DATE NOT NULL,
  "captured_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "products"           INTEGER NOT NULL DEFAULT 0,
  "products_active"    INTEGER NOT NULL DEFAULT 0,
  "variants"           INTEGER NOT NULL DEFAULT 0,
  "images"             INTEGER NOT NULL DEFAULT 0,
  "categories"         INTEGER NOT NULL DEFAULT 0,

  "orders"             INTEGER NOT NULL DEFAULT 0,
  "revenue_fils"       INTEGER NOT NULL DEFAULT 0,
  "customers"          INTEGER NOT NULL DEFAULT 0,

  -- Traffic is split deliberately. A cart is created per storefront session, so
  -- empty carts approximate unique visitors on a browsing store — but the ratio
  -- differs wildly by flow. Measured 2026-08: pecannbee 2687 empty / 135 with
  -- items (classic browsing) vs wady-aljuz 93 / 1111 (carts arrive pre-filled).
  -- A single "carts" column would have meant two different things per store.
  "sessions_proxy"     INTEGER NOT NULL DEFAULT 0,
  "carts_with_items"   INTEGER NOT NULL DEFAULT 0,
  "product_views"      INTEGER NOT NULL DEFAULT 0,

  "ai_calls"           INTEGER NOT NULL DEFAULT 0,
  "ai_billable_calls"  INTEGER NOT NULL DEFAULT 0,
  "ai_tokens_in"       INTEGER NOT NULL DEFAULT 0,
  "ai_tokens_out"      INTEGER NOT NULL DEFAULT 0,
  -- NULL-costed usage contributes 0 here, so ai_unpriced_calls must be read
  -- alongside it or an unpriced month looks free. See lib/ai-pricing.ts.
  "ai_cost_micros"     INTEGER NOT NULL DEFAULT 0,
  "ai_unpriced_calls"  INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "store_usage_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_usage_snapshots_store_id_period_start_key"
  ON "store_usage_snapshots"("store_id", "period_start");

CREATE INDEX "store_usage_snapshots_period_start_idx"
  ON "store_usage_snapshots"("period_start" DESC);

ALTER TABLE "store_usage_snapshots"
  ADD CONSTRAINT "store_usage_snapshots_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
