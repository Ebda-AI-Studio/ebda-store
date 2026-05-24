-- GEO (Generative Engine Optimization) columns
-- Store: llms_txt (merchant-editable /llms.txt content) + about_json (brand facts JSON-LD)
-- Product: citation_copy + citation_copy_ar (LLM-citation-optimised description)
-- BulkAiJobKind enum: llms_txt, citation_copy, brand_facts

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "llms_txt"    TEXT,
  ADD COLUMN IF NOT EXISTS "about_json"  JSONB;

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "citation_copy"    TEXT,
  ADD COLUMN IF NOT EXISTS "citation_copy_ar" TEXT;

ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'llms_txt';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'citation_copy';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'brand_facts';
