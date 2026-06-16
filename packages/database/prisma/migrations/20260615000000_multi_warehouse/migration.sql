-- Multi-Warehouse Inventory — Enterprise tier
-- 2026-06-15: feat/multi-warehouse
--
-- Adds: warehouses + warehouse_stock tables with RLS, indexes,
-- and a backfill that creates one default warehouse per existing store
-- and seeds warehouse_stock from current Product/ProductVariant inventory
-- so nothing breaks for existing single-warehouse stores.
--
-- SAFETY:
--   - 100% additive — no existing columns dropped or renamed
--   - Existing Product.inventory / ProductVariant.inventory remain unchanged
--     (treated as the aggregate; kept in sync by the service layer)
--   - The feature is gated behind inventory.multi_warehouse (Enterprise)
--     so it is invisible to non-Enterprise stores even after migration
--
-- RLS policy idiom (hybrid — superset of both FWB policy generations):
--   current_store_id() IS NULL                              — no tenant ctx
--   OR current_setting('app.bypass_rls', true) = 'true'     — explicit bypass
--   OR store_id = current_store_id()                        — tenant match

-- ── Ensure helper exists (first defined in 20260404000000; redefined for squash safety) ──
CREATE OR REPLACE FUNCTION current_store_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_store_id', true), '');
EXCEPTION
  WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ═══════════════════════════════════════════════════════════════════════
-- TABLE: warehouses
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "warehouses" (
  "id"         TEXT        NOT NULL,
  "store_id"   TEXT        NOT NULL,
  "name"       TEXT        NOT NULL,
  "name_ar"    TEXT,
  "code"       TEXT        NOT NULL,
  "is_default" BOOLEAN     NOT NULL DEFAULT false,
  "priority"   INTEGER     NOT NULL DEFAULT 0,
  "lat"        DOUBLE PRECISION,
  "lng"        DOUBLE PRECISION,
  "address"    TEXT,
  "is_active"  BOOLEAN     NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouses_store_id_code_key" UNIQUE ("store_id", "code"),
  CONSTRAINT "warehouses_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS "warehouses_store_id_idx"          ON "warehouses" ("store_id");
CREATE INDEX IF NOT EXISTS "warehouses_store_id_default_idx"  ON "warehouses" ("store_id", "is_default");
CREATE INDEX IF NOT EXISTS "warehouses_store_id_priority_idx" ON "warehouses" ("store_id", "priority" DESC);

-- RLS
DROP POLICY IF EXISTS rls_warehouses_tenant ON warehouses;
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_warehouses_tenant ON warehouses
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
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════
-- TABLE: warehouse_stock
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "warehouse_stock" (
  "id"           TEXT        NOT NULL,
  "warehouse_id" TEXT        NOT NULL,
  "product_id"   TEXT        NOT NULL,
  "variant_id"   TEXT,                  -- null = base-product stock
  "quantity"     INTEGER     NOT NULL DEFAULT 0,
  "store_id"     TEXT        NOT NULL,  -- denormalised for RLS efficiency
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "warehouse_stock_pkey" PRIMARY KEY ("id"),
  -- Unique per (warehouse, product, variant) — NULL variant counts as distinct
  -- so we use a partial index for the (warehouse, product, NULL) case.
  CONSTRAINT "warehouse_stock_warehouse_id_product_id_variant_id_key"
    UNIQUE ("warehouse_id", "product_id", "variant_id"),
  CONSTRAINT "warehouse_stock_warehouse_id_fkey"
    FOREIGN KEY ("warehouse_id") REFERENCES "warehouses" ("id") ON DELETE CASCADE,
  CONSTRAINT "warehouse_stock_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE,
  CONSTRAINT "warehouse_stock_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants" ("id") ON DELETE CASCADE,
  CONSTRAINT "warehouse_stock_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE
);

-- Partial unique index for the base-product (NULL variant) case.
-- The composite UNIQUE constraint above does NOT enforce uniqueness when
-- variant_id IS NULL (Postgres treats NULLs as distinct), so base-product
-- rows would duplicate on a migration re-run. This partial index closes that
-- gap and is the arbiter for Step 2's ON CONFLICT below.
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_stock_warehouse_id_product_id_base_key"
  ON "warehouse_stock" ("warehouse_id", "product_id") WHERE "variant_id" IS NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS "warehouse_stock_warehouse_id_idx" ON "warehouse_stock" ("warehouse_id");
CREATE INDEX IF NOT EXISTS "warehouse_stock_product_id_idx"   ON "warehouse_stock" ("product_id");
CREATE INDEX IF NOT EXISTS "warehouse_stock_variant_id_idx"   ON "warehouse_stock" ("variant_id");
CREATE INDEX IF NOT EXISTS "warehouse_stock_store_id_idx"     ON "warehouse_stock" ("store_id");

-- RLS (store_id is denormalised — direct column comparison, no join)
DROP POLICY IF EXISTS rls_warehouse_stock_tenant ON warehouse_stock;
ALTER TABLE warehouse_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_warehouse_stock_tenant ON warehouse_stock
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
ALTER TABLE warehouse_stock FORCE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════
-- BACKFILL
-- ═══════════════════════════════════════════════════════════════════════
-- Step 1: Create one "Main Warehouse" per existing store
--         (idempotent via ON CONFLICT DO NOTHING)
-- Step 2: Seed warehouse_stock from current product inventory
-- Step 3: Seed warehouse_stock from current variant inventory
-- All wrapped in a DO block so failures roll back together.

DO $$
DECLARE
  r RECORD;
  w_id TEXT;
BEGIN
  -- ── Step 1: one default warehouse per store ──
  FOR r IN SELECT id AS store_id FROM stores LOOP
    -- gen_random_uuid() available on Postgres 13+, Neon 17 has it
    w_id := gen_random_uuid()::text;

    INSERT INTO warehouses (id, store_id, name, name_ar, code, is_default, priority, is_active, created_at, updated_at)
    VALUES (
      w_id,
      r.store_id,
      'Main Warehouse',
      'المستودع الرئيسي',
      'MAIN',
      true,
      100,
      true,
      now(),
      now()
    )
    ON CONFLICT (store_id, code) DO NOTHING;

    -- Re-fetch the actual warehouse id (may have existed before if we're running twice)
    SELECT id INTO w_id FROM warehouses WHERE store_id = r.store_id AND code = 'MAIN' LIMIT 1;

    -- ── Step 2: seed product inventory (base products, no variants) ──
    INSERT INTO warehouse_stock (id, warehouse_id, product_id, variant_id, quantity, store_id, created_at, updated_at)
    SELECT
      gen_random_uuid()::text,
      w_id,
      p.id,
      NULL,
      p.inventory,
      r.store_id,
      now(),
      now()
    FROM products p
    WHERE p.store_id = r.store_id
      AND p.deleted_at IS NULL
    -- arbiter = partial unique index (base-product rows have variant_id NULL)
    ON CONFLICT (warehouse_id, product_id) WHERE variant_id IS NULL DO NOTHING;

    -- ── Step 3: seed variant inventory ──
    INSERT INTO warehouse_stock (id, warehouse_id, product_id, variant_id, quantity, store_id, created_at, updated_at)
    SELECT
      gen_random_uuid()::text,
      w_id,
      pv.product_id,
      pv.id,
      pv.inventory,
      r.store_id,
      now(),
      now()
    FROM product_variants pv
    INNER JOIN products pr ON pr.id = pv.product_id
    WHERE pr.store_id = r.store_id
    ON CONFLICT (warehouse_id, product_id, variant_id) DO NOTHING;

  END LOOP;
END $$;
