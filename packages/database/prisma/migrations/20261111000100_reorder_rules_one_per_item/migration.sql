-- ReorderRule is unique per (store, product, variant), but variant_id is nullable and a NULL is distinct in the
-- @@unique([storeId, productId, variantId]) index, so two simultaneous creates of a product-level rule could both land.
-- Dedupe (keep the newest per item), then add an index that treats NULL as ''. The StoreDO twin is cf-0005.
DELETE FROM "reorder_rules"
 WHERE "id" IN (
   SELECT "id" FROM (
     SELECT "id",
            ROW_NUMBER() OVER (
              PARTITION BY "store_id", "product_id", COALESCE("variant_id"::text, '')
              ORDER BY "created_at" DESC, "id" DESC
            ) AS "rn"
       FROM "reorder_rules"
   ) d WHERE d."rn" > 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS "reorder_rules_one_per_item"
  ON "reorder_rules" ("store_id", "product_id", (COALESCE("variant_id"::text, '')));
