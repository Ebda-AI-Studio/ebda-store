-- Extend BulkAiJobKind enum with AEO sweep types.
-- Originally added 2026-05-03 with ['translate', 'seo']; Task 24
-- (commit 4acfd30) modified the prisma schema to add the three new
-- values but the migration file was never authored — prod DB hit
-- 500 errors on POST /stores/:id/ai/bulk/faq-aeo because the enum
-- rejected the inserted value.
--
-- Postgres requires ALTER TYPE ADD VALUE to run OUTSIDE a transaction.
-- Prisma's migrate runner detects this pattern and splits accordingly.
-- IF NOT EXISTS guards against re-runs (safe on environments where
-- this enum was already manually extended).

ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'faq_aeo';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'howto_aeo';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'meta_aeo';
