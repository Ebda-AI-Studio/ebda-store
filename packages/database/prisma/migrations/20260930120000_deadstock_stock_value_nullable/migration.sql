-- Migration: deadstock_stock_value_nullable
--
-- The weekly dead-stock scan skipped every product with no cost price, so it
-- was structurally blind on stores that never entered costs (2026-09-30
-- analytics audit, finding 6: pecannbee 0/210 products costed, palora 0/22),
-- while the page said "No dead stock detected". The scan now includes those
-- products and records their stock value as UNKNOWN — NULL — instead of a
-- false 0.
--
-- NON-DESTRUCTIVE: drops a NOT NULL constraint only. Every existing row keeps
-- its value; nothing is backfilled. RLS unchanged (column-level change).

ALTER TABLE "deadstock_flags" ALTER COLUMN "stock_value_fils" DROP NOT NULL;
