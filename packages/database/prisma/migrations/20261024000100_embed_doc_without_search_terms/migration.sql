-- The vector leg no longer embeds the AI search words (search program P1, Task 13 eval;
-- Ruling SEARCH-T13-5).
--
--   ebda_product_embed_doc(name, name_ar, desc, desc_ar)  NEW 4-argument IMMUTABLE sql helper:
--       the same text as before minus the search-words part (names + descriptions, HTML tags turned
--       into spaces, whitespace collapsed, each description capped at 1500 chars, NULL when every
--       part is empty). Why: the Task 13 eval (real bge-m3) measured that appending the AI words
--       lengthens the embedded text and pushes paraphrase matches past SEARCH_VECTOR_MAX_DISTANCE
--       (hybrid msa 0.98 → 0.94, hard msa 1.00 → 0.70); the words keep working in the KEYWORD leg
--       (products.search_terms, trigram), where they lift Franco 0.10 → 0.62.
--   ebda_product_embed_doc(name, name_ar, terms, desc, desc_ar)  DROPPED, not left beside the new
--       one: a caller that still passes the words fails loudly instead of embedding them.
--
-- Effect on existing rows: product_embeddings.content_hash is md5(old doc); the new doc differs for
-- every product with search words, so those rows read STALE (Task 11's pure-SQL test) and the
-- indexer / 6-hourly backstop re-embeds them; a product without words keeps its hash. Production
-- has 0 products (2026-10-16), so this re-embeds nothing there today.
-- Same rules as SEARCH-T9-1: only IMMUTABLE operators, so the IMMUTABLE label is true and the
-- planner inlines it (tested); invoker rights, no SET search_path (SEARCH-15 allowlist).
-- Lock note: function DDL only; no table is touched.
-- Rollback: rollback.sql (recreates the 5-argument function, drops the 4-argument one; roll the
-- code back first).

CREATE OR REPLACE FUNCTION public.ebda_product_embed_doc(
  p_name text, p_name_ar text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- Every part is trimmed of ALL whitespace (\s: space, tab, CR, LF...), not just spaces (btrim).
  -- Descriptions: an HTML tag (`<` + letter, `</`, or `<!`) becomes a space so block tags do not
  -- fuse words; a bare `<` / `>` ("price < 50") is text and stays; whitespace runs collapse to one
  -- space; then the 1500-char cap. Entities (&amp;) are not decoded.
  -- Only IMMUTABLE operators (||, coalesce, nullif, btrim, rtrim, left, regexp_replace): concat_ws
  -- and array_to_string are STABLE, which would make the IMMUTABLE label a lie and stop inlining.
  -- NULL (never '') when every part is empty: Task 11 skips a NULL doc rather than embed md5('').
  SELECT nullif(rtrim(
    coalesce(nullif(regexp_replace(p_name_ar, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(regexp_replace(p_name, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(p_desc_ar,
      '</?[A-Za-z][^<>]*>|<![^<>]*>', ' ', 'g'), '\s+', ' ', 'g')), 1500)), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(p_desc,
      '</?[A-Za-z][^<>]*>|<![^<>]*>', ' ', 'g'), '\s+', ' ', 'g')), 1500)), '') || E'\n', ''),
    E'\n'
  ), '')
$$;

DROP FUNCTION IF EXISTS public.ebda_product_embed_doc(text, text, text, text, text);
