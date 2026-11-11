-- Hand-written (M-107 follow-up). A reorder rule is unique per (store, product, variant), but `variant_id` is nullable and a
-- NULL is distinct in the generated unique index, so two product-level rules (variant NULL) could both be inserted by two
-- simultaneous creates. This index treats NULL as '' so the second insert is refused (UNIQUE constraint failed ->
-- Prisma P2002 -> the service answers 409). Existing duplicates are removed first, keeping the newest per item.
-- Idempotent; the StoreDO records it in `_migrations` as cf-0005_reorder_rules_one_per_item and applies it once.
DELETE FROM "reorder_rules"
 WHERE "id" IN (
   SELECT "id" FROM (
     SELECT "id",
            ROW_NUMBER() OVER (
              PARTITION BY "store_id", "product_id", COALESCE("variant_id", '')
              ORDER BY "created_at" DESC, "id" DESC
            ) AS "rn"
       FROM "reorder_rules"
   ) WHERE "rn" > 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS "reorder_rules_one_per_item"
  ON "reorder_rules" ("store_id", "product_id", COALESCE("variant_id", ''));
