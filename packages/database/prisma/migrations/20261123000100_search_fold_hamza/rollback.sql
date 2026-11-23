-- rollback.sql for 20261123000100_search_fold_hamza.
-- Run on DIRECT_URL in psql autocommit (no BEGIN), AFTER rolling the code (and the vendored foundation) back: restores the previous body of
-- public.ebda_ar_norm and rebuilds the five indexes built on it. Use REINDEX INDEX CONCURRENTLY post-launch.
-- Then, so a later `prisma migrate deploy` re-applies the migration:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261123000100_search_fold_hamza';
CREATE OR REPLACE FUNCTION public.ebda_ar_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      regexp_replace(t, E'[\u064B-\u065F\u0670\u0640]', '', 'g'),
      'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'اااايييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789'
    ),
    E'[ \t\n\r\u00A0]+', ' ', 'g'
  ), ' ')
$$;
REINDEX INDEX public.products_search_doc_trgm_idx;
REINDEX INDEX public.products_name_doc_trgm_idx;
REINDEX INDEX public.products_sku_norm_trgm_idx;
REINDEX INDEX public.users_name_norm_trgm_idx;
REINDEX INDEX public.orders_guest_name_norm_trgm_idx;
