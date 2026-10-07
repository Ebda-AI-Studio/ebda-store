-- Product 3D models (docs/plans/2026-10-07-product-3d-viewer.md).
--
--   product_models          NEW, store-scoped. One row per product (UNIQUE product_id): the GLB in R2,
--                           optional USDZ + poster, alt text, AR toggle, extracted material list/stats.
--   product_model_bindings  NEW, store-scoped. Option value -> 3D finish (material colour/metal or a
--                           glTF KHR_materials_variants name).
--
-- Additive only. Both tables carry store_id, so the single strict R-EBDA-001 policy applies directly.
-- FKs: product delete / option-value delete / store delete CASCADE (no NO ACTION children added).
-- Rollback: DROP TABLE product_model_bindings, product_models — docs/ROLLBACK.md. R2 objects under
-- stores/<storeId>/models/ are then orphans the weekly sweep reclaims.

-- CreateTable
CREATE TABLE "product_models" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "model_url" TEXT NOT NULL,
    "model_bytes" INTEGER NOT NULL,
    "usdz_url" TEXT,
    "usdz_bytes" INTEGER,
    "poster_url" TEXT,
    "alt_text" VARCHAR(250),
    "alt_text_ar" VARCHAR(250),
    "ar_enabled" BOOLEAN NOT NULL DEFAULT true,
    "materials" JSONB NOT NULL DEFAULT '[]',
    "gltf_variants" JSONB NOT NULL DEFAULT '[]',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_model_bindings" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "option_value_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "color" TEXT,
    "metalness" DOUBLE PRECISION,
    "roughness" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_model_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_models_product_id_key" ON "product_models"("product_id");

-- CreateIndex
CREATE INDEX "product_models_store_id_idx" ON "product_models"("store_id");

-- CreateIndex
CREATE INDEX "product_model_bindings_store_id_idx" ON "product_model_bindings"("store_id");

-- CreateIndex
CREATE INDEX "product_model_bindings_option_value_id_idx" ON "product_model_bindings"("option_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_model_bindings_model_id_option_value_id_kind_target_key" ON "product_model_bindings"("model_id", "option_value_id", "kind", "target");

-- AddForeignKey
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_option_value_id_fkey" FOREIGN KEY ("option_value_id") REFERENCES "product_option_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "product_models" ADD CONSTRAINT "product_models_bytes_check" CHECK ("model_bytes" > 0 AND "model_bytes" <= 15728640 AND ("usdz_bytes" IS NULL OR ("usdz_bytes" > 0 AND "usdz_bytes" <= 15728640)));
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_kind_check" CHECK ("kind" IN ('material', 'gltf_variant'));
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_unit_check" CHECK (("metalness" IS NULL OR ("metalness" >= 0 AND "metalness" <= 1)) AND ("roughness" IS NULL OR ("roughness" >= 0 AND "roughness" <= 1)));
ALTER TABLE "product_model_bindings" ADD CONSTRAINT "product_model_bindings_target_check" CHECK (char_length("target") BETWEEN 1 AND 100);

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE product_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_models FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_models AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

ALTER TABLE product_model_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_model_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_model_bindings AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
