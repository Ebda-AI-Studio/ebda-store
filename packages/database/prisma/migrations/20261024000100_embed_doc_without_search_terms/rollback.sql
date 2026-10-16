-- rollback.sql for 20261024000100_embed_doc_without_search_terms.
-- Roll the CODE back first: the indexer (product-index.service.ts DOC) calls the 4-argument
-- function this drops. Restores the 5-argument doc (WITH the AI search words), byte-identical to
-- migration 20261022000100; every product with search words then reads stale again and the
-- indexer re-embeds it (vectors are re-derivable; nothing is lost).

CREATE OR REPLACE FUNCTION public.ebda_product_embed_doc(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(rtrim(
    coalesce(nullif(regexp_replace(p_name_ar, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(regexp_replace(p_name, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(regexp_replace(p_terms, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(p_desc_ar,
      '</?[A-Za-z][^<>]*>|<![^<>]*>', ' ', 'g'), '\s+', ' ', 'g')), 1500)), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(p_desc,
      '</?[A-Za-z][^<>]*>|<![^<>]*>', ' ', 'g'), '\s+', ' ', 'g')), 1500)), '') || E'\n', ''),
    E'\n'
  ), '')
$$;

DROP FUNCTION IF EXISTS public.ebda_product_embed_doc(text, text, text, text);

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024000100_embed_doc_without_search_terms';
