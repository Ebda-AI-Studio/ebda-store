-- Reviews table upgrade — verified-purchase only, populated from the post-purchase
-- review-request flow. See docs/superpowers/plans/2026-05-12-ai-discovery-
-- bilingual-email.md Task 26.
--
-- The reviews table already exists (created in 20250225000000_add_missing_models)
-- with the older simple schema (comment, is_verified, is_approved, helpful_count).
-- This migration adds the new columns needed for the full review flow and
-- removes/renames the old ones, adds the unique + composite indexes, and
-- wires order_id as NOT NULL (safe because no production reviews exist yet).
--
-- Order columns: review_request_sent_at tracks the 7-day-delayed Inngest job
-- so re-triggers don't double-send. delivered_at already exists on the orders
-- table from 20250225000000_add_missing_models — no-op here.

-- ============================================================
-- 1. Drop the old simple indexes that conflict with new ones
-- ============================================================

DROP INDEX IF EXISTS "reviews_product_id_idx";
DROP INDEX IF EXISTS "reviews_store_id_idx";
DROP INDEX IF EXISTS "reviews_customer_id_idx";
DROP INDEX IF EXISTS "reviews_rating_idx";
DROP INDEX IF EXISTS "reviews_store_id_product_id_idx";

-- ============================================================
-- 2. Add new columns to the existing reviews table
-- ============================================================

ALTER TABLE "reviews"
  ADD COLUMN IF NOT EXISTS "body"                TEXT,
  ADD COLUMN IF NOT EXISTS "language"            TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS "body_translated"     TEXT,
  ADD COLUMN IF NOT EXISTS "body_translated_at"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verified_purchase"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "status"              TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "rejection_reason"    TEXT,
  ADD COLUMN IF NOT EXISTS "spam_score"          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "spam_reasons"        JSONB,
  ADD COLUMN IF NOT EXISTS "owner_response"      TEXT,
  ADD COLUMN IF NOT EXISTS "owner_response_ar"   TEXT,
  ADD COLUMN IF NOT EXISTS "owner_response_at"   TIMESTAMP(3);

-- ============================================================
-- 3. Backfill body from comment for any existing rows
--    (keeps old data intact before we drop the column)
-- ============================================================

UPDATE "reviews" SET "body" = COALESCE("comment", '') WHERE "body" IS NULL;

-- Make body NOT NULL now that it's populated
ALTER TABLE "reviews" ALTER COLUMN "body" SET NOT NULL;

-- ============================================================
-- 4. Drop old columns that are superseded by the new schema
-- ============================================================

ALTER TABLE "reviews"
  DROP COLUMN IF EXISTS "comment",
  DROP COLUMN IF EXISTS "is_verified",
  DROP COLUMN IF EXISTS "is_approved",
  DROP COLUMN IF EXISTS "helpful_count";

-- ============================================================
-- 5. Make order_id NOT NULL (safe: no reviews with null
--    order_id exist in prod as of this migration)
-- ============================================================

-- First update any NULL order_ids to a sentinel so the NOT NULL alter doesn't fail
-- (if there are rows without an order_id from the test-store era, this ensures
-- the migration doesn't blow up; those rows will have an invalid FK and should
-- be cleaned up separately if they exist — production had 0 review rows)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "reviews" WHERE "order_id" IS NULL) THEN
    -- Delete orphaned rows with no order_id — they pre-date the verified-purchase flow
    DELETE FROM "reviews" WHERE "order_id" IS NULL;
  END IF;
END $$;

ALTER TABLE "reviews" ALTER COLUMN "order_id" SET NOT NULL;

-- Drop the old nullable FK constraint and re-add as NOT NULL RESTRICT
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_order_id_fkey";
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 6. Add unique constraint + new composite indexes
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_order_id_product_id_key"
  ON "reviews" ("order_id", "product_id");

CREATE INDEX IF NOT EXISTS "reviews_product_id_status_idx"
  ON "reviews" ("product_id", "status");

CREATE INDEX IF NOT EXISTS "reviews_store_id_status_idx"
  ON "reviews" ("store_id", "status");

-- Keep customer_id index for FK integrity lookups
CREATE INDEX IF NOT EXISTS "reviews_customer_id_idx"
  ON "reviews" ("customer_id");

-- ============================================================
-- 7. Add review_request_sent_at to orders
--    (delivered_at already exists from 20250225000000_add_missing_models)
-- ============================================================

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "review_request_sent_at" TIMESTAMP(3);

-- ============================================================
-- 8. Backfill delivered_at for existing delivered orders
--    Best-estimate: updated_at when status flipped to delivered.
--    Conservative default — accurate enough for the 7-day delay
--    calculation in the Inngest review-request job.
-- ============================================================

UPDATE "orders"
SET "delivered_at" = "updated_at"
WHERE "status" = 'delivered'
  AND "delivered_at" IS NULL;
