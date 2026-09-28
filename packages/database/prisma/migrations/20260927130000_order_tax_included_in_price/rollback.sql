-- Rollback for 20260927130000_order_tax_included_in_price (hand-written;
-- Prisma does not generate down migrations).
--
-- DESTRUCTIVE only for stores that charged inclusive VAT. Dropping the column
-- makes every such order re-read as EXCLUSIVE, which puts back exactly the
-- defect this migration closed: the GL posting credits revenue + tax + shipping
-- against DR Cash = total and the entry no longer balances, and a partial
-- return refunds the customer their VAT share a second time. Confirm no such
-- order exists before running it:
--   SELECT id, order_number, subtotal, tax, total FROM orders WHERE tax_included_in_price;
--
-- Then remove the migration row so a re-deploy re-applies it cleanly:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260927130000_order_tax_included_in_price';

ALTER TABLE "orders" DROP COLUMN "tax_included_in_price";
