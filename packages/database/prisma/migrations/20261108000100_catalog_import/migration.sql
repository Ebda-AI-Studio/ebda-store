-- Catalogue import (docs/plans/2026-10-21-search-p3-catalogue-import.md, Ruling CATIMP-1): a merchant uploads
-- photos or a PDF price list, Ebda extracts products, the merchant reviews, drafts are created, then
-- published by an explicit click.
--
--   catalog_import_jobs   one upload (a batch of files)
--   catalog_import_files  one stored original; an image is one page, a PDF is extracted whole (CATIMP-1)
--   catalog_import_items  one extracted product row awaiting review (never a product until "create drafts")
--
-- New tables only: no lock on existing data and no production prerequisite. Strict RLS on all three
-- (store_id GUC), FORCE, one ebda_tenant_isolation policy TO ebda_app, explicit grant.
-- FKs: job -> store CASCADE; file/item -> job CASCADE; item -> store CASCADE; item.product_id and
-- item.category_id SET NULL (a deleted product or category never deletes the review row).
-- Rollback: rollback.sql drops the three tables child-first.

CREATE TABLE IF NOT EXISTS "catalog_import_jobs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "created_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error_code" TEXT,
    "files_total" INTEGER NOT NULL DEFAULT 0,
    "files_done" INTEGER NOT NULL DEFAULT 0,
    "files_failed" INTEGER NOT NULL DEFAULT 0,
    "pages_total" INTEGER NOT NULL DEFAULT 0,
    "items_total" INTEGER NOT NULL DEFAULT 0,
    "drafts_created" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalog_import_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_import_jobs_status_chk" CHECK ("status" IN ('queued','processing','review','creating','done','failed','cancelled'))
);

CREATE TABLE IF NOT EXISTS "catalog_import_files" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "page_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'stored',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "quota_counted" BOOLEAN NOT NULL DEFAULT false,
    "items_found" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "model" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "catalog_import_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_import_files_status_chk" CHECK ("status" IN ('stored','processing','done','failed','skipped_quota')),
    CONSTRAINT "catalog_import_files_pages_chk" CHECK ("page_count" >= 1 AND "page_count" <= 100)
);

CREATE TABLE IF NOT EXISTS "catalog_import_items" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "name" TEXT,
    "name_ar" TEXT,
    "description" TEXT,
    "description_ar" TEXT,
    "price_minor" INTEGER,
    "compare_at_minor" INTEGER,
    "price_raw" TEXT,
    "sku" TEXT,
    "category_name" TEXT,
    "category_id" TEXT,
    "tags" TEXT[],
    "variants" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "flags" TEXT[],
    "acknowledged" TEXT[],
    "source_text" TEXT,
    "edited_fields" TEXT[],
    "product_id" TEXT,
    "create_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalog_import_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_import_items_status_chk" CHECK ("status" IN ('pending','accepted','rejected','created','failed')),
    CONSTRAINT "catalog_import_items_tags_max_chk" CHECK (coalesce(cardinality("tags"), 0) <= 5),
    CONSTRAINT "catalog_import_items_variants_max_chk" CHECK (jsonb_typeof("variants") = 'array' AND jsonb_array_length("variants") <= 30),
    CONSTRAINT "catalog_import_items_price_chk" CHECK (("price_minor" IS NULL OR "price_minor" >= 0) AND ("compare_at_minor" IS NULL OR "compare_at_minor" >= 0)),
    CONSTRAINT "catalog_import_items_len_chk" CHECK (length(coalesce("name", '')) <= 300 AND length(coalesce("name_ar", '')) <= 300 AND length(coalesce("description", '')) <= 2000 AND length(coalesce("description_ar", '')) <= 2000)
);

CREATE INDEX IF NOT EXISTS "catalog_import_jobs_store_id_created_at_idx" ON "catalog_import_jobs"("store_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "catalog_import_jobs_expires_at_idx" ON "catalog_import_jobs"("expires_at");
CREATE INDEX IF NOT EXISTS "catalog_import_files_job_id_status_idx" ON "catalog_import_files"("job_id", "status");
CREATE INDEX IF NOT EXISTS "catalog_import_files_store_id_quota_counted_started_at_idx" ON "catalog_import_files"("store_id", "quota_counted", "started_at");
CREATE INDEX IF NOT EXISTS "catalog_import_items_job_id_status_idx" ON "catalog_import_items"("job_id", "status");
CREATE INDEX IF NOT EXISTS "catalog_import_items_store_id_sku_idx" ON "catalog_import_items"("store_id", "sku");
CREATE INDEX IF NOT EXISTS "catalog_import_items_product_id_idx" ON "catalog_import_items"("product_id");
CREATE INDEX IF NOT EXISTS "catalog_import_items_category_id_idx" ON "catalog_import_items"("category_id");

ALTER TABLE "catalog_import_jobs" ADD CONSTRAINT "catalog_import_jobs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_import_files" ADD CONSTRAINT "catalog_import_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "catalog_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_import_files" ADD CONSTRAINT "catalog_import_files_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_import_items" ADD CONSTRAINT "catalog_import_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "catalog_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_import_items" ADD CONSTRAINT "catalog_import_items_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "catalog_import_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_import_items" ADD CONSTRAINT "catalog_import_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_import_items" ADD CONSTRAINT "catalog_import_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "catalog_import_items" ADD CONSTRAINT "catalog_import_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE catalog_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON catalog_import_jobs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_import_jobs TO ebda_app;

ALTER TABLE catalog_import_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_files FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON catalog_import_files AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_import_files TO ebda_app;

ALTER TABLE catalog_import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON catalog_import_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_import_items TO ebda_app;
