import { Prisma } from '@force/database';

/**
 * SQL twin of `effectiveInventory` (lib/effective-inventory.ts), for queries
 * that must FILTER, SORT or AGGREGATE on stock rather than compute it in JS.
 *
 * Split from the TS helper on purpose: that module is imported by cart,
 * orders and several routes, and pulling `@force/database` into it forces
 * every one of their unit-test mocks to stub `Prisma.sql`.
 *
 * Assumes the products table is aliased `p`. Keep this in lockstep with
 * `effectiveInventory` — they are one rule with two evaluators, and a query
 * that hand-rolls its own version is how this class of bug started. That
 * includes the variant rule: a disabled variant is not stock, and a product
 * whose variants are all disabled has 0 (#1103).
 */
export const ON_HAND_SQL = Prisma.sql`CASE
  WHEN EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id)
  THEN COALESCE(
    (SELECT SUM(pv.inventory) FROM public.product_variants pv
      WHERE pv.product_id = p.id AND pv.is_active),
    0
  )
  ELSE p.inventory
END`;
