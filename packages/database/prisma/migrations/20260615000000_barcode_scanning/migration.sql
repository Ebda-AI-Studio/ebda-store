-- Migration: 20260615000000_barcode_scanning
-- Adds barcode scanning infrastructure:
--   1. Barcode indexes on products + product_variants for fast lookup.
--   2. picked_qty + picked_at on order_items for scan-to-pick state.
--   3. CountSession + CountLine models for cycle-count / audit sessions.
--   4. RLS policies for count_sessions + count_lines (same pattern as other
--      tenant tables — all Force RLS policies are already enforced via
--      20260530000000_force_rls_enforcement + 20260609000000_complete_force_rls_coverage).
--
-- Additive only: every new column has a DEFAULT so existing rows are unaffected.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Barcode indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "products_store_id_barcode_idx"
  ON public.products (store_id, barcode)
  WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS "product_variants_product_id_barcode_idx"
  ON public.product_variants (product_id, barcode)
  WHERE barcode IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. scan-to-pick columns on order_items
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS picked_qty INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS picked_at  TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CountSession status enum
-- ─────────────────────────────────────────────────────────────────────────────

-- CREATE TYPE has no IF NOT EXISTS clause in any Postgres version; guard for
-- idempotency (re-run on API boot) via a DO/EXCEPTION block instead.
DO $$ BEGIN
  CREATE TYPE "CountSessionStatus" AS ENUM ('open', 'closed', 'reconciled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. count_sessions table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.count_sessions (
  id              UUID          NOT NULL DEFAULT gen_random_uuid(),
  store_id        UUID          NOT NULL,
  status          "CountSessionStatus" NOT NULL DEFAULT 'open',
  note            TEXT,
  created_by      UUID,
  closed_at       TIMESTAMPTZ,
  reconciled_at   TIMESTAMPTZ,
  adjustment_id   UUID          UNIQUE,  -- FK to stock_adjustments.id set at reconcile time
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT count_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT count_sessions_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "count_sessions_store_id_status_idx"
  ON public.count_sessions (store_id, status);

CREATE INDEX IF NOT EXISTS "count_sessions_store_id_created_at_idx"
  ON public.count_sessions (store_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. count_lines table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.count_lines (
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  session_id   UUID        NOT NULL,
  product_id   UUID        NOT NULL,
  variant_id   UUID,
  counted_qty  INTEGER     NOT NULL,
  system_qty   INTEGER     NOT NULL,
  variance     INTEGER     NOT NULL,
  scanned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT count_lines_pkey PRIMARY KEY (id),
  CONSTRAINT count_lines_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.count_sessions (id) ON DELETE CASCADE,
  CONSTRAINT count_lines_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.products (id),
  CONSTRAINT count_lines_variant_id_fkey
    FOREIGN KEY (variant_id) REFERENCES public.product_variants (id),
  -- One count line per product/variant per session (upsert pattern).
  CONSTRAINT count_lines_session_product_variant_unique
    UNIQUE (session_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS "count_lines_session_id_idx"
  ON public.count_lines (session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS policies
-- ─────────────────────────────────────────────────────────────────────────────

-- count_sessions
ALTER TABLE public.count_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.count_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY count_sessions_store_isolation ON public.count_sessions
  USING (store_id = current_setting('app.current_client_id', true)::uuid);

-- count_lines (scoped via session → store)
ALTER TABLE public.count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.count_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY count_lines_store_isolation ON public.count_lines
  USING (
    session_id IN (
      SELECT id FROM public.count_sessions
      WHERE store_id = current_setting('app.current_client_id', true)::uuid
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. updated_at trigger for count_sessions (matches pattern on other tables)
-- ─────────────────────────────────────────────────────────────────────────────

-- Reuse the set_updated_at function already created by an earlier migration
-- (20260530000000_force_rls_enforcement or similar). If it doesn't exist yet
-- the CREATE OR REPLACE below is safe.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_count_sessions_updated_at ON public.count_sessions;
CREATE TRIGGER set_count_sessions_updated_at
  BEFORE UPDATE ON public.count_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
