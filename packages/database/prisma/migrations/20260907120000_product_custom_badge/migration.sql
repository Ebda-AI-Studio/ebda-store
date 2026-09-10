-- Migration: product_custom_badge
--
-- Adds a per-product, merchant-authored badge label (bilingual EN + AR) that
-- the storefront renders on the product card and PDP in the same visual
-- language as the existing discount badge.
--
-- WHY IT DOES NOT ALREADY EXIST: `getDiscountBadgeText()`
-- (apps/web/src/lib/product-pricing.ts) COMPUTES its badge text from the
-- discount maths ("-20%", "وفّر ٥٫٠٠٠ د.ك") and returns null unless
-- compare_at_price > price. The only merchant knobs were colour + corner
-- (`ProductCardDefaults.discountBadge`). `products` carried the booleans
-- `is_new` / `is_best_seller` / `featured` and no free-text label column at
-- all, so a merchant who wanted an "عرض" / "Offer" chip on one product had
-- nowhere to type it.
--
-- ADDITIVE AND NULLABLE BY CONSTRUCTION. Both columns are NULL for every
-- existing row and there is no backfill, no default and no NOT NULL: the
-- storefront renders nothing until a merchant types a label, so this
-- migration is a strict no-op for every store's current rendering. That is
-- the "new visual features default OFF" rule (CLAUDE.md UI/UX rule 2) — here
-- it is structural rather than a flag, because "no label" IS "off".
--
-- WHY VARCHAR(32) AND NOT TEXT: a badge is a chip on a product card, a few
-- words at most ("Offer", "عرض", "Ramadan pick"). An unbounded TEXT column
-- lets a paste of a paragraph reach the card and blow the layout apart on
-- every render path at once. The cap is enforced in THREE places on purpose —
-- here at the DB, in the Zod `updateProductSchema` (which trims first, so a
-- 32-character label padded with spaces is accepted rather than rejected),
-- and in the admin input's maxLength — because a cap that lives only in the
-- form is a suggestion. 32 is generous for both scripts: Arabic badge copy is
-- typically 3–8 characters.
--
-- NOTE ON WIDENING LATER: growing a VARCHAR(n) is a metadata-only ALTER in
-- Postgres (no table rewrite), so raising the cap later is cheap. Shrinking
-- it is not. Starting narrow is the reversible direction.
--
-- RLS: none needed. These are columns on `products`, which already has its
-- store-scoped policies from 20260404000000_add_rls_policies; adding a column
-- inherits the table's existing policies unchanged.
--
-- LOCK NOTE: `ADD COLUMN` with no DEFAULT and no NOT NULL is catalog-only in
-- Postgres 11+ — it takes a brief ACCESS EXCLUSIVE lock and does not rewrite
-- the table, so it is safe to run on API boot against a large `products`.

ALTER TABLE "products"
  ADD COLUMN "badge_label"    VARCHAR(32),
  ADD COLUMN "badge_label_ar" VARCHAR(32);

COMMENT ON COLUMN "products"."badge_label" IS
  'Merchant-authored free-text card badge (EN). NULL = no badge rendered.';
COMMENT ON COLUMN "products"."badge_label_ar" IS
  'Merchant-authored free-text card badge (AR). NULL = falls back to badge_label.';
