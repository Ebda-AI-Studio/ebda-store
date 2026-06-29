-- Track which products a bulk-AI job actually filled, so the merchant can
-- validate the AI output (the `filled` counter alone isn't actionable).
ALTER TABLE "bulk_ai_jobs" ADD COLUMN "filled_products" JSONB;
