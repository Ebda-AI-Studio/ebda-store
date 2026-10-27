-- BARCODE-1: a barcode identifies ONE sellable thing in a store.
--
--   products.barcode          unique per store among live (not soft-deleted) products
--   product_variants.barcode  unique per product
--
-- Store-wide uniqueness ACROSS products and variants cannot be a plain index (variants carry no
-- store_id), so the allocator and the write-path validator enforce it under
-- pg_advisory_xact_lock(hashtext(store_id || ':barcode')) (apps/api/src/services/barcode.service.ts).
-- These two partial unique indexes are the database-level backstop and exist in SQL only (Prisma
-- cannot express a partial unique index), like users_admin_email_key.
--
-- Existing duplicates would make CREATE UNIQUE INDEX fail, so the newer duplicate's barcode is set
-- to NULL first (the oldest row keeps it; ties broken by id). The merchant sees the row as
-- "no barcode" and can regenerate it from admin (QR codes & barcodes, Product labels). The number
-- of rows cleared is the `UPDATE n` count in the migrate log. Only barcode text is touched.
--
-- Lock note: UPDATE touches only duplicate rows; CREATE UNIQUE INDEX (not CONCURRENTLY, inside the
-- migration transaction) holds a SHARE lock on each table for the build. Both tables are small
-- (<= tens of thousands of rows per deployment at this stage).
-- Rollback: rollback.sql (drops both indexes; cleared barcodes are NOT restored).

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY store_id, barcode ORDER BY created_at, id) AS rn
  FROM products
  WHERE barcode IS NOT NULL AND deleted_at IS NULL
)
UPDATE products p SET barcode = NULL FROM ranked r WHERE p.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY product_id, barcode ORDER BY created_at, id) AS rn
  FROM product_variants
  WHERE barcode IS NOT NULL
)
UPDATE product_variants v SET barcode = NULL FROM ranked r WHERE v.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "products_store_id_barcode_uniq"
  ON "products" ("store_id", "barcode")
  WHERE "barcode" IS NOT NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_product_id_barcode_uniq"
  ON "product_variants" ("product_id", "barcode")
  WHERE "barcode" IS NOT NULL;
