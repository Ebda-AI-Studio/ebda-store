-- Embedding quarantine (search program P1, Task 11 review I2; Ruling SEARCH-T11-10).
--
--   product_embed_failures  NEW, store-scoped. One row per product whose CURRENT text could not be
--                           embedded (the provider rejected it while other products in the same
--                           batch succeeded, or rejected it non-retryably). Keyed on the product,
--                           holding the md5 of the doc that failed: the indexer skips a product only
--                           while md5(current doc) = content_hash, so editing the text re-admits it.
--                           A later successful embed deletes the row. Without it, one poison product
--                           repeats in the same newest-first batch forever and stalls its store.
--                           Child of products and stores (ON DELETE CASCADE); nothing references it.
--
-- Viewer: the searches insights page index line ("N failed"; storeIndexStatus.failed, Task 12).
-- Lock note: new empty table only; the two FKs take a brief SHARE ROW EXCLUSIVE on "products" and
-- "stores" while they are added.
-- Rollback: rollback.sql.

-- CreateTable
CREATE TABLE "product_embed_failures" (
    "product_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "error_kind" TEXT NOT NULL,
    "failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_embed_failures_pkey" PRIMARY KEY ("product_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_embed_failures_store_id_idx" ON "product_embed_failures"("store_id");

-- AddForeignKey
ALTER TABLE "product_embed_failures" ADD CONSTRAINT "product_embed_failures_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_embed_failures" ADD CONSTRAINT "product_embed_failures_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE product_embed_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_embed_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_embed_failures AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON product_embed_failures TO ebda_app;
