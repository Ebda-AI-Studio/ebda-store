-- Migration: ai_usage_cost_and_provenance
--
-- Closes two audit findings from docs/audits/2026-08-08-reel-lens-audit.md:
--
--   23.4 (ai-transparency)  — there is no generation log. `ai_usage` recorded
--        WHAT was spent but never WHICH MODEL produced the output or WHAT the
--        output was attached to. That half cannot be backfilled: once a
--        generation has happened without provenance, the record is gone.
--
--   25.3 (unit-economics)   — spend was measured in TOKENS, never money. With
--        no currency column nothing can divide cost by the revenue it served,
--        so per-tenant margin did not exist as a number.
--
-- All four columns are NULLABLE and carry no default and no backfill. Existing
-- rows stay NULL, which correctly means "recorded before provenance/costing
-- existed" rather than "cost zero" — a distinction that matters, because a
-- genuinely free cached hit also costs zero.
--
-- Additive only: safe to apply while the old code is still running (it simply
-- never writes them). No lock of consequence — ai_usage is append-only and the
-- columns are nullable, so this is a catalog change, not a table rewrite.

ALTER TABLE "ai_usage" ADD COLUMN "model" TEXT;
ALTER TABLE "ai_usage" ADD COLUMN "cost_micros" INTEGER;
ALTER TABLE "ai_usage" ADD COLUMN "subject_type" TEXT;
ALTER TABLE "ai_usage" ADD COLUMN "subject_id" TEXT;

-- Spend-by-model reporting ("which model is eating the budget") and the
-- per-store cost rollup the admin AI-usage page renders. store_id + created_at
-- is already indexed; this covers the model dimension.
CREATE INDEX IF NOT EXISTS "ai_usage_model_created_at_idx"
  ON "ai_usage"("model", "created_at");
