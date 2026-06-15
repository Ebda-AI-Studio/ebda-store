-- Multi-Currency FX fields (2026-06-15)
--
-- Additive migration: adds FX rate + original foreign-currency amount to
-- journal_lines and expenses.  Existing rows get safe defaults (fx_rate=1,
-- original_amount=0) so all existing KWD-only behaviour is unchanged.
--
-- fxRate representation:
--   numeric(16,8) — exact rational arithmetic, no IEEE 754 float.
--   Meaning: 1 unit of the line's `currency` = fxRate KWD.
--   KWD lines: fxRate=1 (identity), originalAmount=debit|credit.
--   Non-KWD: fxRate=0.307 means 1 USD = 0.307 KWD.
--
-- Rounding rule: half-up at the INTEGER fils boundary.
--   kwdFils = ROUND_HALF_UP(originalAmount * fxRate)
--   In JS: Math.round(originalAmount * Number(fxRate))
--   (Math.round is half-up for positive numbers.)
--
-- original_amount holds the foreign-currency minor units
-- (e.g. cents for USD, halalas for SAR) BEFORE conversion.
-- debit / credit (unchanged) always hold KWD fils (the reporting currency).
--
-- No RLS policy changes needed: these are non-key columns on already-
-- protected tables (journal_lines RLS inherits from the parent journal_entries
-- via store_id; expenses has its own store_id policy).

ALTER TABLE "journal_lines"
  ADD COLUMN IF NOT EXISTS "fx_rate"        DECIMAL(16,8) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "original_amount" INTEGER       DEFAULT 0;

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "fx_rate"        DECIMAL(16,8) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "original_amount" INTEGER       DEFAULT 0;

-- FX Rate Registry — merchant-maintained exchange-rate log.
-- Gated behind accounting.multi_currency (Enterprise).
-- RLS: standard store-scoped policy (same hybrid predicate pattern).

CREATE TABLE IF NOT EXISTS "fx_rate_entries" (
  "id"          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "store_id"    TEXT        NOT NULL,
  "currency"    TEXT        NOT NULL,
  "rate"        DECIMAL(16,8) NOT NULL,
  "rate_date"   DATE        NOT NULL,
  "recorded_by" TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "fx_rate_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fx_rate_entries_store_fk" FOREIGN KEY ("store_id")
    REFERENCES "stores"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "fx_rate_entries_store_currency_date_idx"
  ON "fx_rate_entries" ("store_id", "currency", "rate_date" DESC);

-- RLS on fx_rate_entries (hybrid predicate matching the rest of the codebase)
ALTER TABLE "fx_rate_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fx_rate_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "fx_rate_entries_tenant_isolation" ON "fx_rate_entries"
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR "store_id" = current_store_id()
  );

CREATE POLICY "fx_rate_entries_tenant_insert" ON "fx_rate_entries"
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR "store_id" = current_store_id()
  );
