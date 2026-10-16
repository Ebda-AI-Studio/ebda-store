-- Semantic search vectors (search program P1, Task 9; Rulings SEARCH-7, SEARCH-8, SEARCH-9).
--
--   vector                       NEW extension (pgvector). Production has 0.8.0 available (read-only
--                                check 2026-10-15; STOP-2 cleared pre-launch); `halfvec` needs >= 0.7.
--                                Creatable by the migration role (verified on production 2026-10-16,
--                                coordinator): the DIRECT_URL role is `neondb_owner`, which owns
--                                search_query_daily (created by the previous migration) and is a member
--                                of neon_superuser; `CREATE EXTENSION IF NOT EXISTS vector` succeeded as
--                                that role inside a transaction that was rolled back (vector is not yet
--                                installed). pgvector's control file is not `trusted`, so a plain
--                                non-superuser owner would be refused; CI migrates as a superuser and
--                                cannot catch that, hence the production check. CI, compose and
--                                the buy-flow harness run pgvector/pgvector:0.8.0-pg17 (production is 17.11).
--   ebda_product_embed_doc(...)  NEW IMMUTABLE sql helper: the text a product is embedded from. Raw
--                                (un-normalised) names + search terms + descriptions with HTML tags
--                                stripped and each description capped at 1500 chars; empty / NULL parts
--                                are skipped. md5(of it) is product_embeddings.content_hash, so a stale
--                                row is found in pure SQL (Task 11). Invoker rights, no SET search_path
--                                (Ruling SEARCH-15 allowlist in rls-ebda-app.test.ts).
--   product_embeddings           NEW, store-scoped. One row per product: a bge-m3 (1024 dims) halfvec.
--                                Child of products (ON DELETE CASCADE) and of stores (CASCADE); nothing
--                                references it, so no NO ACTION child is added and the product hard-delete
--                                and StoreService.delete paths need no change. Carries store_id, so the
--                                strict R-EBDA-001 policy applies and the vector KNN filters by store with
--                                a btree before ranking: exact KNN, no HNSW/ivfflat until a store passes
--                                ~20k products (Ruling SEARCH-8; filtered ANN has a recall trap).
--
-- Viewer: the searches insights page header, "indexed N of M products" (Task 12).
-- Lock note: new extension, new function, new empty table only. The two FKs take a brief SHARE ROW
-- EXCLUSIVE on "products" and "stores" while they are added; no existing table is rewritten.
-- Rollback: rollback.sql (drops the table and the function; the extension is left installed).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION public.ebda_product_embed_doc(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- Only IMMUTABLE operators (||, coalesce, nullif, btrim, rtrim, left, regexp_replace): concat_ws
  -- and array_to_string are STABLE, which would make the IMMUTABLE label a lie and stop inlining.
  SELECT rtrim(
    coalesce(nullif(btrim(p_name_ar), '') || E'\n', '') ||
    coalesce(nullif(btrim(p_name), '') || E'\n', '') ||
    coalesce(nullif(btrim(p_terms), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(regexp_replace(p_desc_ar, '<[^>]*>', '', 'g'), 1500)), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(regexp_replace(p_desc, '<[^>]*>', '', 'g'), 1500)), '') || E'\n', ''),
    E'\n'
  )
$$;

-- CreateTable
CREATE TABLE "product_embeddings" (
    "product_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" halfvec(1024) NOT NULL,
    "embedded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_embeddings_pkey" PRIMARY KEY ("product_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_embeddings_store_id_idx" ON "product_embeddings"("store_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_embeddings_store_id_embedded_at_idx" ON "product_embeddings"("store_id", "embedded_at");

-- AddForeignKey
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE product_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_embeddings AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON product_embeddings TO ebda_app;
