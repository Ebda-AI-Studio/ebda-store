-- AI usage tracking for the Force Store AI assistant. Every call to
-- AIService writes a row so we can enforce per-store daily token
-- budgets and audit usage. Cached hits are recorded with
-- `cached_hit=true` for observability but are not counted against the
-- token budget (no model call happened).

CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_hit" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_store_id_created_at_idx"
  ON "ai_usage" ("store_id", "created_at" DESC);

CREATE INDEX "ai_usage_feature_idx"
  ON "ai_usage" ("feature");

ALTER TABLE "ai_usage"
  ADD CONSTRAINT "ai_usage_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
