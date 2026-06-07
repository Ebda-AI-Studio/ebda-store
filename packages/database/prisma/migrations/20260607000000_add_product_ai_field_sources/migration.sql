-- Per-field AI provenance for the AI-first autofill engine.
-- Additive + NOT NULL DEFAULT '{}' → forward-compatible: existing rows get
-- an empty map (every field treated as "empty"/unknown), old code that does
-- not select the column is unaffected.
ALTER TABLE "products" ADD COLUMN "ai_field_sources" JSONB NOT NULL DEFAULT '{}';
