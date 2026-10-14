-- Migration: order_items.variant_name_ar (Phase B0 final wave, Ruling B0-41)
--
-- The Arabic twin of order_items.variant_name, snapshotted from product_variants.title_ar at
-- checkout. variant_name stays the canonical (English) title: fiscal documents and CSV exports
-- read it unchanged. Additive and nullable: no backfill, existing rows read null and fall back.
-- order_items has no store_id (child of orders, covered through the parent's RLS): no policy.
SET lock_timeout = '5s';

ALTER TABLE "order_items" ADD COLUMN "variant_name_ar" TEXT;
