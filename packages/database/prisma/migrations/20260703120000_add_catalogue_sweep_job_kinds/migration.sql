-- Catalogue field sweeps (2026-07-03): add BulkAiJobKind values for the
-- product-FAQ fix + the four new bulk sweeps (category / image alt / excerpt /
-- tags). Additive-only; the values are not USED in this migration, so there is
-- no "ALTER TYPE ... ADD VALUE cannot run inside a transaction that then uses
-- it" trap. Neon is PG17 (ADD VALUE inside a tx is allowed).
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'product_faqs';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'category_assign';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'image_alt';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'excerpt';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'product_tags';
