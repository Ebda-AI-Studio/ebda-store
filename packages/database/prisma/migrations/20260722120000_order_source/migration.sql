-- Add order provenance marker (audit only). Nullable + default 'web' so existing rows and
-- every current write path are unaffected; the MCP place_order tool sets 'agent'.
--
-- NOTE: `model Order` maps to physical table "orders" (@@map("orders")), not "Order" —
-- matching the convention of every sibling Order migration (see
-- 20260720000000_order_refund_reversed_at).
ALTER TABLE "orders" ADD COLUMN "source" TEXT DEFAULT 'web';
