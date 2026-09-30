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

/**
 * On-hand stock VALUE (fils) of one product row aliased `p` — the valuation
 * twin of `ON_HAND_SQL`, using the same variant rule.
 *
 * A variant product is valued per ACTIVE variant at that variant's own cost,
 * falling back to the parent's cost when the variant has none — the rule
 * `account.service.ts` already uses for the opening-balance inventory entry
 * (`variant.costPrice ?? product.costPrice`). The merchant enters cost per
 * variant in the variants form, and PO receive now writes the weighted
 * average to the variant; multiplying the variant SUM by the parent's cost
 * alone valued those variants at 0 (or at an unrelated average).
 */
export const STOCK_VALUE_SQL = Prisma.sql`CASE
  WHEN EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id)
  THEN COALESCE(
    (SELECT SUM(pv.inventory * COALESCE(pv.cost_price, p.cost_price, 0))
      FROM public.product_variants pv
      WHERE pv.product_id = p.id AND pv.is_active),
    0
  )
  ELSE p.inventory * COALESCE(p.cost_price, 0)
END`;

/**
 * Stock VALUE (fils) held on DISABLED variants of one product row aliased `p`
 * — the exact inverse predicate of `STOCK_VALUE_SQL`'s variant branch
 * (issue 2146). Those units are excluded from every stock figure, so the
 * finance dashboard shows them on their own line instead of letting the
 * value silently disappear when a merchant disables a variant.
 */
export const DISABLED_VARIANT_STOCK_VALUE_SQL = Prisma.sql`COALESCE(
  (SELECT SUM(pv.inventory * COALESCE(pv.cost_price, p.cost_price, 0))
    FROM public.product_variants pv
    WHERE pv.product_id = p.id AND NOT pv.is_active AND pv.inventory > 0),
  0
)`;
