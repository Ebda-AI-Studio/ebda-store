-- Migration: cart_item_null_variant_unique
--
-- Postgres does NOT enforce UNIQUE constraints when any indexed column is NULL
-- (per SQL standard NULLs-are-not-equal semantics). The existing combined index
--   cart_items_cart_id_product_id_variant_id_key (cart_id, product_id, variant_id)
-- therefore allows multiple rows with (same cart, same product, variant_id=NULL),
-- which is the root cause of the "adding the same no-variant product twice creates
-- two rows" bug.
--
-- Fix: replace the single combined index with two PARTIAL unique indexes:
--   1. WHERE variant_id IS NULL  → (cart_id, product_id) must be unique
--   2. WHERE variant_id IS NOT NULL → (cart_id, product_id, variant_id) must be unique
--
-- Before creating the new indexes, collapse any existing duplicate
-- (cart_id, product_id, NULL) rows into one row (summing quantities) so the
-- new partial index can be created without a unique-violation error.

-- Step 1: Deduplicate existing rows where variant_id IS NULL.
-- Keep the row with the lowest id (arbitrary stable choice) and sum quantities
-- from any duplicates, then delete the surplus rows.
WITH dupes AS (
  SELECT
    MIN(id) AS keep_id,
    SUM(quantity) AS total_qty,
    cart_id,
    product_id
  FROM cart_items
  WHERE variant_id IS NULL
  GROUP BY cart_id, product_id
  HAVING COUNT(*) > 1
),
updated AS (
  UPDATE cart_items
  SET quantity = dupes.total_qty
  FROM dupes
  WHERE cart_items.id = dupes.keep_id
  RETURNING cart_items.cart_id, cart_items.product_id
)
DELETE FROM cart_items
WHERE variant_id IS NULL
  AND id NOT IN (SELECT keep_id FROM dupes)
  AND (cart_id, product_id) IN (SELECT cart_id, product_id FROM updated);

-- Step 2: Drop the existing combined unique index (covers all three columns
-- including NULLs, which Postgres does NOT enforce as unique).
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_variant_id_key";

-- Also drop the older two-column index from the initial schema if it still exists.
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_key";

-- Step 3: Create two partial unique indexes that together provide the correct
-- uniqueness semantics across both the variant and no-variant cases.

-- No-variant lines: only one row per (cart, product) when there is no variant.
CREATE UNIQUE INDEX "cart_items_cart_id_product_id_no_variant"
  ON "cart_items" ("cart_id", "product_id")
  WHERE "variant_id" IS NULL;

-- Variant lines: only one row per (cart, product, variant) when a variant is chosen.
CREATE UNIQUE INDEX "cart_items_cart_id_product_id_variant_id_with_variant"
  ON "cart_items" ("cart_id", "product_id", "variant_id")
  WHERE "variant_id" IS NOT NULL;
