-- Size charts (Phase B0 Task 9).
--
--   size_charts                NEW, store-scoped. One merchant-authored table: bilingual name,
--                              unit (cm|in), columns JSONB [{label,labelAr}] (2..10), rows JSONB
--                              string[][] (1..30, one cell per column), bilingual note. Shape is
--                              validated by @ebda/shared sizeChartSchema at the API edge.
--   products.size_chart_id     nullable FK -> size_charts, ON DELETE SET NULL.
--   categories.size_chart_id   nullable FK -> size_charts, ON DELETE SET NULL.
--
-- PDP resolution: the product's chart, else its category's, else none.
-- Additive only. size_charts carries store_id, so the single strict R-EBDA-001 policy applies.
-- FKs: store delete CASCADEs the charts (and products/categories cascade from the store too);
-- chart delete SET NULLs every product/category reference — no NO ACTION child is added.
-- Rollback: ALTER TABLE products/categories DROP COLUMN size_chart_id; DROP TABLE size_charts.

-- CreateTable
CREATE TABLE "size_charts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "name_ar" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT 'cm',
    "columns" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "note_ar" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "size_charts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "products" ADD COLUMN "size_chart_id" TEXT;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN "size_chart_id" TEXT;

-- CreateIndex
CREATE INDEX "size_charts_store_id_idx" ON "size_charts"("store_id");

-- CreateIndex
CREATE INDEX "products_size_chart_id_idx" ON "products"("size_chart_id");

-- CreateIndex
CREATE INDEX "categories_size_chart_id_idx" ON "categories"("size_chart_id");

-- AddForeignKey
ALTER TABLE "size_charts" ADD CONSTRAINT "size_charts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_size_chart_id_fkey" FOREIGN KEY ("size_chart_id") REFERENCES "size_charts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_size_chart_id_fkey" FOREIGN KEY ("size_chart_id") REFERENCES "size_charts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "size_charts" ADD CONSTRAINT "size_charts_unit_check" CHECK ("unit" IN ('cm', 'in'));

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE size_charts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON size_charts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
-- Default privileges (20261004000000_ebda_strict_rls) already grant this; explicit so the table
-- is reachable even when the migrating role is not the one that set those defaults.
GRANT SELECT, INSERT, UPDATE, DELETE ON size_charts TO ebda_app;
