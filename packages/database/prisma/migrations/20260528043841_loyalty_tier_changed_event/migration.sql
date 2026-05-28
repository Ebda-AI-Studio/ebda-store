-- Add tier_changed event type to LoyaltyTransactionType. Used by
-- loyalty.service.ts to write a 0-point bookkeeping row whenever a
-- customer's tier flips (bronze ↔ silver ↔ gold ↔ platinum) — closes
-- the loyalty-tier audit gap identified in
-- docs/audits/2026-05-28-mutate-in-place-audit.md.

ALTER TYPE "LoyaltyTransactionType" ADD VALUE IF NOT EXISTS 'tier_changed';
