-- Made-to-order lead time (business days). NULL = ready to ship; feeds the PDP "delivers by" chip.
ALTER TABLE "products" ADD COLUMN "lead_time_days" INTEGER;
ALTER TABLE "products" ADD CONSTRAINT "products_lead_time_days_range" CHECK ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 0 AND 60);
