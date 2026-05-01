-- Per-store typography overrides.
--
-- A single JSON blob on the Store row carries the merchant's choice of
-- font family, size, weight, and color for each storefront zone
-- (header, before-header, categories, products, footer, after-footer)
-- plus a "fonts" library of either Google Fonts URLs or
-- merchant-uploaded font files (woff2 / woff / ttf / otf hosted on R2).
--
-- Stored as JSON because the shape will keep evolving (new zones,
-- per-element line-height / letter-spacing, etc.) and we don't want a
-- column-add migration every time. The application validates the
-- shape via Zod on read/write.
--
-- Idempotent: IF NOT EXISTS guards against environments where this
-- column was already provisioned by a consolidated migration.

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "typography" JSONB;
