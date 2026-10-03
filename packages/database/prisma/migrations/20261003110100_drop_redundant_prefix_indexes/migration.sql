-- Migration: drop_redundant_prefix_indexes (index audit 2026-10, "Unused-index
-- removal candidates", approved 2026-10-03; docs/perf/index-audit-2026-10.md).
-- Index-only: no column, no data change, RLS unchanged. Drops are their own
-- migration by rule (docs/DB-INDEX-MIGRATIONS.md); nothing is added here.
--
-- Each index below is a strict left prefix, same sort order, of a longer valid
-- btree on the same table. Anything the short one serves, the long one serves
-- (an equality on the leading column, an FK parent-delete probe, a count), so
-- the drop loses no plan and removes a write on every insert/update/delete.
-- Checked read-only against production on 2026-10-03, per index: the longer
-- index exists and is valid, and no constraint or foreign key depends on the
-- short one (pg_constraint.conindid = 0 rows; after the drop every one of the
-- 205 FKs still has an index leading on its columns).
--
--   redundant                                          kept (serves the same lookups)
--   carts_store_id_idx                                 carts_store_id_session_id_key (UNIQUE)
--   ai_recommendation_store_id_source_product_id_idx   ai_recommendation_store_id_source_product_id_target_product_id_ (UNIQUE; name truncated to 63)
--   audit_logs_store_id_idx                            audit_logs_store_id_created_at_idx
--   orders_store_id_idx                                orders_store_id_created_at_idx
--   products_store_id_idx                              products_store_id_status_idx
--   payment_events_event_type_idx                      payment_events_event_type_occurred_at_idx
--   inventory_history_store_id_idx                     inventory_history_store_id_reference_idx
--   cart_bundles_cart_id_idx                           cart_bundles_cart_id_bundle_id_key (UNIQUE)
--
-- `product_variants_sku_idx` is deliberately NOT dropped (Ruling DBM-2): it has
-- no longer index behind it, and the SKU bulk-import path
-- (stock-adjustments.routes.ts, `sku IN (...)`) needs it once the table grows.
--
-- Each drop is guarded: it runs only when its covering index exists and is
-- valid in THIS database, so an environment that drifted can never end up with
-- the short index gone and nothing behind it. A skipped drop raises a WARNING
-- and leaves the redundant index in place, which is harmless.
--
-- LOCK NOTE: DROP INDEX takes ACCESS EXCLUSIVE on its table, held only for the
-- catalog change, but a migration is one transaction, so the locks taken so far
-- are held until it commits. All eight tables are small (production
-- 2026-10-01: largest is carts at 13.8k rows; every drop is milliseconds) and
-- statements on them are short. There is deliberately no lock_timeout: a
-- timed-out migration would be recorded as FAILED and block every later deploy
-- until `prisma migrate resolve`, while a drop that waits behind a stuck
-- transaction just delays the deploy visibly. For a table large enough that
-- this matters, pre-drop with DROP INDEX CONCURRENTLY on DIRECT_URL first and
-- this migration becomes a no-op (docs/DB-INDEX-MIGRATIONS.md).
--
-- Prisma drift: the matching `@@index` lines are removed from schema.prisma in
-- the same change, so `prisma migrate diff` stays clean for these. Rollback:
-- rollback.sql (recreates all eight) AND restore the @@index lines (revert the
-- PR), otherwise the next `migrate dev` proposes dropping them again.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('carts_store_id_idx',                               'carts_store_id_session_id_key'),
      ('ai_recommendation_store_id_source_product_id_idx',  'ai_recommendation_store_id_source_product_id_target_product_id_'),
      ('audit_logs_store_id_idx',                          'audit_logs_store_id_created_at_idx'),
      ('orders_store_id_idx',                              'orders_store_id_created_at_idx'),
      ('products_store_id_idx',                            'products_store_id_status_idx'),
      ('payment_events_event_type_idx',                    'payment_events_event_type_occurred_at_idx'),
      ('inventory_history_store_id_idx',                   'inventory_history_store_id_reference_idx'),
      ('cart_bundles_cart_id_idx',                         'cart_bundles_cart_id_bundle_id_key')
    ) AS t(redundant, covering)
  LOOP
    IF to_regclass(format('public.%I', r.redundant)) IS NULL THEN
      CONTINUE; -- already gone (pre-dropped CONCURRENTLY, or never created)
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass(format('public.%I', r.covering)) AND i.indisvalid
    ) THEN
      EXECUTE format('DROP INDEX public.%I', r.redundant);
    ELSE
      RAISE WARNING 'kept %: covering index % is missing or invalid', r.redundant, r.covering;
    END IF;
  END LOOP;
END
$$;
