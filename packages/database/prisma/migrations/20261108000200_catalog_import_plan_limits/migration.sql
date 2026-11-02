-- Catalogue import (Ruling CATIMP-2): the monthly page allowance joins plans.limits.
--
--   free 0 (not included) · basic 100 · growth 400 · pro 400 · business 1500 · comped, founding_free: null (unlimited)
--
-- Idempotent: only rows that do not carry the key yet are touched, so a re-run, or a super-admin who
-- already set a number, is left alone. `plans` is a small catalog table (single-digit rows): no lock
-- concern. Rollback: rollback.sql removes the key (the schema default is 0 = off, never unlimited).
UPDATE "plans" SET "limits" = "limits" || '{"catalogImportPagesPerMonth":0}'::jsonb
  WHERE "code" = 'free' AND NOT ("limits" ? 'catalogImportPagesPerMonth');
UPDATE "plans" SET "limits" = "limits" || '{"catalogImportPagesPerMonth":100}'::jsonb
  WHERE "code" = 'basic' AND NOT ("limits" ? 'catalogImportPagesPerMonth');
UPDATE "plans" SET "limits" = "limits" || '{"catalogImportPagesPerMonth":400}'::jsonb
  WHERE "code" IN ('growth', 'pro') AND NOT ("limits" ? 'catalogImportPagesPerMonth');
UPDATE "plans" SET "limits" = "limits" || '{"catalogImportPagesPerMonth":1500}'::jsonb
  WHERE "code" = 'business' AND NOT ("limits" ? 'catalogImportPagesPerMonth');
UPDATE "plans" SET "limits" = "limits" || '{"catalogImportPagesPerMonth":null}'::jsonb
  WHERE "code" IN ('comped', 'founding_free') AND NOT ("limits" ? 'catalogImportPagesPerMonth');
UPDATE "plans" SET "limits" = "limits" || '{"catalogImportPagesPerMonth":0}'::jsonb
  WHERE NOT ("limits" ? 'catalogImportPagesPerMonth');
