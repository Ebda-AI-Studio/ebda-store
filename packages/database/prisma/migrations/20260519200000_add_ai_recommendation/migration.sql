-- Migration: add ai_recommendation table + recommendations enum value
--
-- Adds the AiRecommendation model used by the bulk-ai-recommendations
-- Inngest sweep (4th catalogue-wide AI feature). Rows are fully replaced
-- on each re-sweep so stale picks never accumulate.
--
-- Also extends the bulk_ai_job_kind enum with 'recommendations' so
-- BulkAiJob rows can track sweep progress.

-- Extend the enum first (must happen before the table that references it)
ALTER TYPE "bulk_ai_job_kind" ADD VALUE IF NOT EXISTS 'recommendations';

-- Create the ai_recommendation table
CREATE TABLE "ai_recommendation" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "store_id"          TEXT         NOT NULL,
  "source_product_id" TEXT         NOT NULL,
  "target_product_id" TEXT         NOT NULL,
  -- 0.0–1.0 confidence score from Gemini; used for ORDER BY score DESC
  "score"             DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  -- One-sentence rationale from Gemini; useful for admin debugging
  "reason"            TEXT,
  "generated_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT "ai_recommendation_pkey" PRIMARY KEY ("id"),

  -- Cascade so orphaned rows can never survive a product or store delete
  CONSTRAINT "ai_recommendation_store_id_fkey"
    FOREIGN KEY ("store_id")
    REFERENCES "stores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "ai_recommendation_source_product_id_fkey"
    FOREIGN KEY ("source_product_id")
    REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "ai_recommendation_target_product_id_fkey"
    FOREIGN KEY ("target_product_id")
    REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- One AI rec pair per store — prevents duplicate rows if sweep is
  -- re-run without the preceding deleteMany (belt-and-suspenders).
  CONSTRAINT "ai_recommendation_store_id_source_product_id_target_product_id_key"
    UNIQUE ("store_id", "source_product_id", "target_product_id")
);

-- Index for the primary hot path: "give me AI recs for product X in store Y"
CREATE INDEX "ai_recommendation_store_id_source_product_id_idx"
  ON "ai_recommendation"("store_id", "source_product_id");

-- Index for admin "when was this store last swept?" queries
CREATE INDEX "ai_recommendation_store_id_generated_at_idx"
  ON "ai_recommendation"("store_id", "generated_at");
