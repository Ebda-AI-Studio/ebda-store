-- Migration: store_wa_customer_ordering_enabled (2026-05-23)
--
-- Adds waCustomerOrderingEnabled to Store.
-- When true, WBS state machine is enabled for this store — customers who DM
-- the store's WhatsApp number can order directly. FWB pushes this flag to WBS
-- via PUT /api/v1/external/wa-ordering on the WBS backend.
-- Default FALSE — merchant must opt in explicitly.

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "wa_customer_ordering_enabled" BOOLEAN NOT NULL DEFAULT false;
