-- CreateTable
CREATE TABLE "shipping_area_rates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "governorate" TEXT NOT NULL,
    "governorate_ar" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "area_ar" TEXT NOT NULL,
    "delivery_fee" INTEGER NOT NULL DEFAULT 0,
    "free_shipping_threshold" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_area_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_area_rates_store_id_governorate_area_key" ON "shipping_area_rates"("store_id", "governorate", "area");

-- CreateIndex
CREATE INDEX "shipping_area_rates_store_id_is_active_idx" ON "shipping_area_rates"("store_id", "is_active");

-- AddForeignKey
ALTER TABLE "shipping_area_rates" ADD CONSTRAINT "shipping_area_rates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security: mirror shipping_zones (single FOR ALL policy + FORCE; current_store_id() bypasses for migration/super_admin)
ALTER TABLE "shipping_area_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipping_area_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_shipping_area_rates_tenant ON "shipping_area_rates"
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());
