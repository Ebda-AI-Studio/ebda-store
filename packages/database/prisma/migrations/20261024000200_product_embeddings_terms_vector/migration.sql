-- A second vector per product for the AI search words alone (search program P1, Task 13 eval;
-- Ruling SEARCH-T13-7).
--
--   product_embeddings.terms_embedding  NEW halfvec(1024), NULL: bge-m3 vector of the product's
--       search words (products.search_terms, trimmed) alone. NULL when the product has no words
--       (and then no provider call is made). The vector leg scores a product by the NEARER of its
--       two vectors (doc = names + descriptions, SEARCH-T13-5; words).
--   product_embeddings.terms_hash       NEW text, NULL: md5 of the words text the vector was built
--       from, so a words-only edit re-embeds only this vector (its own staleness, pure SQL).
--   product_embeddings_terms_pair_chk   both NULL or both set.
--
-- Same row, so nothing changes for RLS (R-EBDA-001 policy on store_id) or the tenant guard (same
-- model, same storeId). No ANN index: KNN stays exact per store behind the store_id btree
-- (Ruling SEARCH-8), now over both columns.
-- Lock note: two nullable columns without a default are a catalog-only change; the CHECK scans the
-- table once (production holds 0 rows, 2026-10-16). Brief ACCESS EXCLUSIVE on product_embeddings.
-- Rollback: rollback.sql (drops the two columns and the check; roll the code back first).

ALTER TABLE "product_embeddings"
  ADD COLUMN IF NOT EXISTS "terms_embedding" halfvec(1024),
  ADD COLUMN IF NOT EXISTS "terms_hash" TEXT;

ALTER TABLE "product_embeddings"
  ADD CONSTRAINT "product_embeddings_terms_pair_chk"
  CHECK (("terms_embedding" IS NULL) = ("terms_hash" IS NULL));
