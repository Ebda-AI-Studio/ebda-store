-- Gold-rate pricing (Phase B5 Task 9; Rulings B5-12, B5-13, B5-16, B5-19, B5-20).
--
-- Number: 20261102000200. The plan reserved 20261101000100, but main took that number for the FK index
-- migration (#122, `20261101000100_fk_leading_indexes_webhooks_b2b`) before this branch landed, so this
-- one is renumbered to sort AFTER main's newest (Ruling B5-26). Nothing in the SQL depends on the stamp.
--
--   gold_rates              NEW, store-scoped, APPEND-ONLY history of every rate written (manual or
--                           automatic feed), with its status (applied | pending | rejected) and the
--                           jump that triggered a confirmation. ebda_app has SELECT, INSERT and a
--                           column UPDATE of (status, decided_by, applied_at) only: no DELETE and no
--                           UPDATE of the rate itself.
--   gold_rates_current      NEW, store-scoped. The one applied rate per (store, karat). Rate writes take
--                           FOR UPDATE on it; checkout takes FOR SHARE (Ruling B5-17).
--   gold_rate_settings      NEW, store-scoped. One row per store: enabled, automatic rate, premium,
--                           max age (<= 26 h), jump gate, rounding step, show breakdown.
--   products / product_variants   gain the integer pricing spec (mode, karat, weight in mg, making
--                           charge, margin in bps, the rate row the price was computed from). A
--                           variant's NULL means "inherit the product".
--   ebda_gold_feed_stores() / ebda_gold_rate_watch()   NEW cron-facing SECURITY DEFINER functions (see
--                           the end of this file): the stores that opted into the automatic rate, and the
--                           (store, karat) pairs whose rate needs a stale warning or block alert. They let the
--                           two crons exit un-stepped on an empty tick (INNGEST-BUDGET-1).
--   cart_items              quoted_unit_price / quoted_at: what the shopper saw when the line was added.
--   order_items             gold_snapshot JSONB: how the line's price was made (refund + invoice display).
--
-- The materialised `price` stays the one price every reader uses (Ruling B5-13). For a gold row only the
-- repricer writes it, and the BEFORE trigger below enforces that for every writer there is or will be:
-- a price / compare_at_price change (or an INSERT, or a switch INTO gold) on a gold row is refused with
-- GOLD_PRICE_MANAGED unless the transaction set `app.gold_reprice = 'on'` via set_config(..., true)
-- (transaction-local, so it cannot leak across a pooled connection).
--
-- Additive: new tables, nullable or defaulted columns, a trigger. No existing row is rewritten (every
-- product reads pricing_mode 'fixed'). FKs: store delete CASCADEs all three tables; gold_rates_current
-- cascades from gold_rates too, so no NO ACTION child is added.
-- Rollback: DROP TRIGGER ebda_gold_price_guard on both tables, DROP FUNCTION, DROP the added columns,
-- DROP TABLE gold_rate_settings, gold_rates_current, gold_rates. Gold rows keep their last materialised
-- price as a fixed price. Run scripts/gold-rate/freeze-all.mjs first so no row is left in a mode old code
-- cannot read; re-verify RLS (FORCE + the policy) after any restore.

-- CreateTable
CREATE TABLE "gold_rates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "karat" SMALLINT NOT NULL,
    "rate_per_gram" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "jump_bps" INTEGER,
    "feed_reference" JSONB,
    "created_by" TEXT,
    "decided_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "gold_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gold_rates_karat_check" CHECK ("karat" IN (24, 21, 18)),
    CONSTRAINT "gold_rates_rate_check" CHECK ("rate_per_gram" BETWEEN 10000 AND 10000000),
    CONSTRAINT "gold_rates_source_check" CHECK ("source" IN ('manual', 'feed')),
    CONSTRAINT "gold_rates_status_check" CHECK ("status" IN ('applied', 'pending', 'rejected'))
);

-- CreateTable
CREATE TABLE "gold_rates_current" (
    "store_id" TEXT NOT NULL,
    "karat" SMALLINT NOT NULL,
    "rate_id" TEXT NOT NULL,
    "rate_per_gram" INTEGER NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gold_rates_current_pkey" PRIMARY KEY ("store_id", "karat"),
    CONSTRAINT "gold_rates_current_karat_check" CHECK ("karat" IN (24, 21, 18)),
    CONSTRAINT "gold_rates_current_rate_check" CHECK ("rate_per_gram" BETWEEN 10000 AND 10000000)
);

-- CreateTable
CREATE TABLE "gold_rate_settings" (
    "store_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "feed_enabled" BOOLEAN NOT NULL DEFAULT false,
    "feed_premium_bps" INTEGER NOT NULL DEFAULT 0,
    "max_age_minutes" INTEGER NOT NULL DEFAULT 1560,
    "jump_confirm_bps" INTEGER NOT NULL DEFAULT 500,
    "rounding_step" INTEGER NOT NULL DEFAULT 100,
    "show_breakdown" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gold_rate_settings_pkey" PRIMARY KEY ("store_id"),
    CONSTRAINT "gold_rate_settings_premium_check" CHECK ("feed_premium_bps" BETWEEN -1000 AND 1000),
    CONSTRAINT "gold_rate_settings_max_age_check" CHECK ("max_age_minutes" BETWEEN 60 AND 1560),
    CONSTRAINT "gold_rate_settings_jump_check" CHECK ("jump_confirm_bps" BETWEEN 100 AND 5000),
    CONSTRAINT "gold_rate_settings_step_check" CHECK ("rounding_step" IN (1, 100, 500, 1000))
);

-- AlterTable products
ALTER TABLE "products"
    ADD COLUMN "pricing_mode" TEXT NOT NULL DEFAULT 'fixed',
    ADD COLUMN "gold_karat" SMALLINT,
    ADD COLUMN "gold_weight_mg" INTEGER,
    ADD COLUMN "making_charge_type" TEXT,
    ADD COLUMN "making_charge_value" INTEGER,
    ADD COLUMN "gold_margin_bps" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "gold_rate_id" TEXT,
    ADD CONSTRAINT "products_pricing_mode_check" CHECK ("pricing_mode" IN ('fixed', 'gold_rate')),
    ADD CONSTRAINT "products_gold_karat_check" CHECK ("gold_karat" IS NULL OR "gold_karat" IN (24, 21, 18)),
    ADD CONSTRAINT "products_gold_weight_check" CHECK ("gold_weight_mg" IS NULL OR "gold_weight_mg" BETWEEN 1 AND 1000000),
    ADD CONSTRAINT "products_making_type_check" CHECK ("making_charge_type" IS NULL OR "making_charge_type" IN ('fixed', 'per_gram')),
    ADD CONSTRAINT "products_making_value_check" CHECK ("making_charge_value" IS NULL OR "making_charge_value" >= 0),
    ADD CONSTRAINT "products_gold_margin_check" CHECK ("gold_margin_bps" BETWEEN -5000 AND 10000),
    ADD CONSTRAINT "products_gold_spec_complete_check" CHECK (
      "pricing_mode" = 'fixed'
      OR ("gold_karat" IS NOT NULL AND "gold_weight_mg" IS NOT NULL
          AND "making_charge_type" IS NOT NULL AND "making_charge_value" IS NOT NULL)
    ),
    -- Ruling B5-19: a gold row carries no compare-at price (sales run through coupons and promotions).
    ADD CONSTRAINT "products_gold_no_compare_check" CHECK ("pricing_mode" = 'fixed' OR "compare_at_price" IS NULL);

-- AlterTable product_variants (every spec column NULL = inherit the product)
ALTER TABLE "product_variants"
    ADD COLUMN "pricing_mode" TEXT,
    ADD COLUMN "gold_karat" SMALLINT,
    ADD COLUMN "gold_weight_mg" INTEGER,
    ADD COLUMN "making_charge_type" TEXT,
    ADD COLUMN "making_charge_value" INTEGER,
    ADD COLUMN "gold_margin_bps" INTEGER,
    ADD COLUMN "gold_rate_id" TEXT,
    ADD CONSTRAINT "product_variants_pricing_mode_check" CHECK ("pricing_mode" IS NULL OR "pricing_mode" IN ('fixed', 'gold_rate')),
    ADD CONSTRAINT "product_variants_gold_karat_check" CHECK ("gold_karat" IS NULL OR "gold_karat" IN (24, 21, 18)),
    ADD CONSTRAINT "product_variants_gold_weight_check" CHECK ("gold_weight_mg" IS NULL OR "gold_weight_mg" BETWEEN 1 AND 1000000),
    ADD CONSTRAINT "product_variants_making_type_check" CHECK ("making_charge_type" IS NULL OR "making_charge_type" IN ('fixed', 'per_gram')),
    ADD CONSTRAINT "product_variants_making_value_check" CHECK ("making_charge_value" IS NULL OR "making_charge_value" >= 0),
    ADD CONSTRAINT "product_variants_gold_margin_check" CHECK ("gold_margin_bps" IS NULL OR "gold_margin_bps" BETWEEN -5000 AND 10000),
    ADD CONSTRAINT "product_variants_gold_no_compare_check" CHECK ("pricing_mode" IS DISTINCT FROM 'gold_rate' OR "compare_at_price" IS NULL);

-- AlterTable cart_items (the line-identity partial unique indexes are untouched)
ALTER TABLE "cart_items"
    ADD COLUMN "quoted_unit_price" INTEGER,
    ADD COLUMN "quoted_at" TIMESTAMPTZ(3);

-- AlterTable order_items
ALTER TABLE "order_items"
    ADD COLUMN "gold_snapshot" JSONB,
    ADD CONSTRAINT "order_items_gold_snapshot_check" CHECK ("gold_snapshot" IS NULL OR jsonb_typeof("gold_snapshot") = 'object');

-- CreateIndex
CREATE INDEX IF NOT EXISTS "gold_rates_store_id_karat_created_at_idx" ON "gold_rates"("store_id", "karat", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "gold_rates_current_rate_id_idx" ON "gold_rates_current"("rate_id");
-- The repricer's scan: only the store's live gold rows, by karat.
CREATE INDEX IF NOT EXISTS "products_gold_reprice_idx" ON "products"("store_id", "gold_karat") WHERE "pricing_mode" = 'gold_rate' AND "deleted_at" IS NULL;

-- AddForeignKey
ALTER TABLE "gold_rates" ADD CONSTRAINT "gold_rates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gold_rates_current" ADD CONSTRAINT "gold_rates_current_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gold_rates_current" ADD CONSTRAINT "gold_rates_current_rate_id_fkey" FOREIGN KEY ("rate_id") REFERENCES "gold_rates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gold_rate_settings" ADD CONSTRAINT "gold_rate_settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the single policy every store_id table carries.
ALTER TABLE gold_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON gold_rates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

ALTER TABLE gold_rates_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_rates_current FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON gold_rates_current AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

ALTER TABLE gold_rate_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_rate_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON gold_rate_settings AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

-- Grants. The default privileges of 20261004000000 hand ebda_app everything on a new table, so the
-- append-only history is narrowed explicitly: rows are read and added, only the decision columns of
-- a pending row change, and nothing is ever deleted or re-rated.
REVOKE ALL ON gold_rates FROM ebda_app;
GRANT SELECT, INSERT ON gold_rates TO ebda_app;
GRANT UPDATE (status, decided_by, applied_at) ON gold_rates TO ebda_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gold_rates_current TO ebda_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gold_rate_settings TO ebda_app;

-- The price guard (Ruling B5-13). SECURITY INVOKER on purpose, and deliberately NOT named ebda_*: the
-- ebda_* functions are SECURITY DEFINER by rule (rls-ebda-app hygiene test), but a definer running as
-- the table owner is subject to FORCE ROW LEVEL SECURITY with no policy of its own and would read NO
-- product row, i.e. see every variant as 'fixed' and let the write through. A variant looks up its
-- product's mode under the caller's own RLS view; a variant the caller cannot see cannot be written anyway.
CREATE OR REPLACE FUNCTION gold_price_guard_products() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pricing_mode = 'gold_rate'
     AND coalesce(current_setting('app.gold_reprice', true), '') <> 'on'
     AND (TG_OP = 'INSERT'
          OR OLD.pricing_mode IS DISTINCT FROM NEW.pricing_mode
          OR OLD.price IS DISTINCT FROM NEW.price
          OR OLD.compare_at_price IS DISTINCT FROM NEW.compare_at_price) THEN
    RAISE EXCEPTION 'GOLD_PRICE_MANAGED: the price of a gold-rate product is written only by the repricer'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gold_price_guard_variants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  effective text;
BEGIN
  effective := NEW.pricing_mode;
  IF effective IS NULL THEN
    SELECT p.pricing_mode INTO effective FROM products p WHERE p.id = NEW.product_id;
  END IF;
  IF effective = 'gold_rate'
     AND coalesce(current_setting('app.gold_reprice', true), '') <> 'on'
     AND (TG_OP = 'INSERT'
          OR OLD.pricing_mode IS DISTINCT FROM NEW.pricing_mode
          OR OLD.price IS DISTINCT FROM NEW.price
          OR OLD.compare_at_price IS DISTINCT FROM NEW.compare_at_price) THEN
    RAISE EXCEPTION 'GOLD_PRICE_MANAGED: the price of a gold-rate variant is written only by the repricer'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ebda_gold_price_guard BEFORE INSERT OR UPDATE OF price, compare_at_price, pricing_mode ON products
  FOR EACH ROW EXECUTE FUNCTION gold_price_guard_products();
CREATE TRIGGER ebda_gold_price_guard BEFORE INSERT OR UPDATE OF price, compare_at_price, pricing_mode ON product_variants
  FOR EACH ROW EXECUTE FUNCTION gold_price_guard_variants();

-- ---------------------------------------------------------------------------
-- Cron-facing definers (Phase B5 Task 11). The two gold crons run with no tenant scope, and a tick that
-- finds nothing must cost ONE Inngest execution (INNGEST-BUDGET-1), so they read these before opening any
-- step. UNGUARDED ON PURPOSE like ebda_store_directory (crons have no principal): routing facts and
-- numbers only, never a rate history, a price or a person. SECURITY DEFINER with a pinned search_path;
-- EXECUTE for ebda_app only (the hygiene test in rls-ebda-app.test.ts enforces both).
-- ---------------------------------------------------------------------------

-- Stores that turned the AUTOMATIC rate on (and the gold feature on): the cron applies the feed to these.
CREATE OR REPLACE FUNCTION public.ebda_gold_feed_stores()
RETURNS TABLE (store_id text, feed_premium_bps integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT g.store_id, g.feed_premium_bps
  FROM public.gold_rate_settings g
  JOIN public.stores s ON s.id = g.store_id
  WHERE g.enabled AND g.feed_enabled AND s.deleted_at IS NULL AND s.status::text = 'active'
  ORDER BY g.store_id
$fn$;

-- (store, karat) pairs that sell gold-rate products and whose applied rate is inside the warning window
-- (max age - 240 min) or past the max age. Empty on almost every tick. Watches EVERY store that sells gold
-- products: nothing in the API reads gold_rate_settings.enabled, and a store that never saved settings is
-- gated at the 1560-minute default (Ruling B5-36), so it must be warned too.
CREATE OR REPLACE FUNCTION public.ebda_gold_rate_watch()
RETURNS TABLE (store_id text, karat smallint, rate_id text, applied_at timestamptz, max_age_minutes integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT c.store_id, c.karat, c.rate_id, c.applied_at, COALESCE(g.max_age_minutes, 1560)::integer AS max_age_minutes
  FROM public.gold_rates_current c
  LEFT JOIN public.gold_rate_settings g ON g.store_id = c.store_id
  JOIN public.stores s ON s.id = c.store_id AND s.deleted_at IS NULL AND s.status::text = 'active'
  WHERE c.applied_at <= now() - make_interval(mins => GREATEST(COALESCE(g.max_age_minutes, 1560) - 240, 0))
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.store_id = c.store_id AND p.pricing_mode = 'gold_rate' AND p.deleted_at IS NULL AND p.status::text = 'active'
        AND (p.gold_karat = c.karat
             OR EXISTS (SELECT 1 FROM public.product_variants v
                        WHERE v.product_id = p.id AND v.pricing_mode IS DISTINCT FROM 'fixed' AND v.gold_karat = c.karat))
    )
  ORDER BY c.store_id, c.karat
$fn$;

REVOKE ALL ON FUNCTION public.ebda_gold_feed_stores() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ebda_gold_rate_watch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_gold_feed_stores() TO ebda_app;
GRANT EXECUTE ON FUNCTION public.ebda_gold_rate_watch() TO ebda_app;
