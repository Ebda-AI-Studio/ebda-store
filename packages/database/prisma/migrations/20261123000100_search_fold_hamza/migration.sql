-- Arabic search fold, hamza carriers unified + NFKC first (Ruling F7-HAMZA-1, amends SEARCH-2 / FDN-TEXT-1).
--
-- WHAT: public.ebda_ar_norm(text) now does, in this order: normalize(t, NFKC); delete tashkeel U+064B-U+065F, dagger alef U+0670,
--   tatweel U+0640 and the hamza seats U+0621 (ء) and U+0626 (ئ); translate() alef forms to ا, ى/ی to ي, ؤ to و, ة to ه, Persian kaf to ك,
--   ASCII A-Z to a-z and Arabic-Indic/Persian digits to 0-9; collapse a run of و to one و; collapse [ \t\n\r U+00A0]+ to one U+0020 and trim U+0020.
--   Twin of foldArabic (packages/shared/src/foundation/text.ts, vendored from ebda-foundation): the translate() strings below ARE
--   AR_FOLD_FROM / AR_FOLD_TO byte for byte (tests/integration/search-normalize-parity.test.ts reads THIS file).
-- WHY: Egyptian shoppers type مسئول and مسؤول interchangeably (both now fold to مسول; سؤال = سوال = سئوال; سائل = ساءل), and pasted text
--   (lam-alef ligature U+FEFB, Arabic presentation forms from PDFs, fullwidth digits) must still meet the typed letters.
--   normalize(text, NFKC) is IMMUTABLE (pg_proc.provolatile = 'i', verified on PostgreSQL 17.11) and needs a UTF8 database (Neon is).
-- IMMUTABLE contract: changing a function body REQUIRES a reindex of every index built on it, in the same change. They are listed below;
--   the DO block rebuilds each one that exists. Plain REINDEX takes a lock that blocks writes to the table while it runs: fine pre-launch and on
--   small tables. Post-launch run this file's steps by hand on DIRECT_URL in psql autocommit, off-peak, with REINDEX INDEX CONCURRENTLY
--   (docs/DB-INDEX-MIGRATIONS.md, "Hamza fold re-index"): step 1 the CREATE OR REPLACE below, step 2 the five REINDEX ... CONCURRENTLY, step 3
--   the NOT indisvalid check. Until step 2 finishes, a search can miss rows whose index entries still hold the old fold.
-- ALSO after deploy: the Store Durable Object search index stores folded text too: run reindexStore per store (verifyProductIndex reports the stale rows).
-- Rollback: rollback.sql (old body + reindex). Migration number assigned by the author; the controller may renumber.

CREATE OR REPLACE FUNCTION public.ebda_ar_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(
        regexp_replace(normalize(t, NFKC), E'[\u064B-\u065F\u0670\u0640\u0621\u0626]', '', 'g'),
        'أإآٱىیؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
        'ااااييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789'
      ),
      E'\u0648{2,}', E'\u0648', 'g'
    ),
    E'[ \t\n\r\u00A0]+', ' ', 'g'
  ), ' ')
$$;

DO $reindex$
DECLARE
  idx text;
BEGIN
  FOREACH idx IN ARRAY ARRAY[
    'products_search_doc_trgm_idx',
    'products_name_doc_trgm_idx',
    'products_sku_norm_trgm_idx',
    'users_name_norm_trgm_idx',
    'orders_guest_name_norm_trgm_idx'
  ] LOOP
    IF to_regclass('public.' || idx) IS NOT NULL THEN
      EXECUTE format('REINDEX INDEX public.%I', idx);
    END IF;
  END LOOP;
END
$reindex$;
