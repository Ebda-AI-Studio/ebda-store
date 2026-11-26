import { Prisma, prisma, type DbClient } from '@ebda/database';

/**
 * SQL twin of `effectiveInventory` (lib/effective-inventory.ts), for queries
 * that must FILTER, SORT or AGGREGATE on stock rather than compute it in JS.
 *
 * Split from the TS helper on purpose: that module is imported by cart,
 * orders and several routes, and pulling `@ebda/database` into it forces
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
 * On-hand stock VALUE (piastres) of one product row aliased `p` — the valuation
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
 * Stock VALUE (piastres) held on DISABLED variants of one product row aliased `p`
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

/**
 * The store's on-hand stock value in piastres — ONE query for the finance
 * dashboard and the analytics inventory snapshot, which used to carry two
 * copies of it. Non-deleted products, valued by `STOCK_VALUE_SQL`: a disabled
 * variant that still holds units counts for nothing (owner decision
 * 2026-10-01, #2078), and disabling one posts no journal entry — so this
 * figure and the balance sheet's Inventory (1200) differ by the cost of the
 * units on disabled variants, by design. See docs/architecture/inventory-model.md.
 */
export async function storeStockValueFils(
  storeId: string,
  client: DbClient = prisma
): Promise<number> {
  const rows = await client.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(${STOCK_VALUE_SQL}), 0) AS total
    FROM public.products p
    WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Cost coverage of the on-hand stock figure, for a product row aliased `p`: `stocked` counts the products that hold
 * on-hand units, `uncosted` the stocked products with at least one unit that has NO cost (variant cost, else the
 * parent's). A stock VALUE built on such a unit skips it, so it is partial (or unknown when every stocked product is
 * uncosted) — never a true 0. Twin of `STOCK_COST_COVERAGE_SQLITE` (packages/repo/src/do/finance-ops.ts).
 */
export const STOCK_COST_COVERAGE_SQL = Prisma.sql`
  COALESCE(SUM(CASE
    WHEN EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id)
    THEN (EXISTS (SELECT 1 FROM public.product_variants pv
                   WHERE pv.product_id = p.id AND pv.is_active AND pv.inventory > 0))::int
    ELSE (p.inventory > 0)::int END), 0) AS stocked,
  COALESCE(SUM(CASE
    WHEN EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id)
    THEN (EXISTS (SELECT 1 FROM public.product_variants pv
                   WHERE pv.product_id = p.id AND pv.is_active AND pv.inventory > 0
                     AND COALESCE(pv.cost_price, p.cost_price) IS NULL))::int
    ELSE (p.inventory > 0 AND p.cost_price IS NULL)::int END), 0) AS uncosted`;

/** Products with stock on hand, and how many of them have no cost (see `STOCK_COST_COVERAGE_SQL`). */
export async function storeStockCostCoverage(
  storeId: string,
  client: DbClient = prisma
): Promise<{ stockedProducts: number; uncostedProducts: number }> {
  const rows = await client.$queryRaw<{ stocked: bigint; uncosted: bigint }[]>`
    SELECT ${STOCK_COST_COVERAGE_SQL}
    FROM public.products p
    WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL
  `;
  return {
    stockedProducts: Number(rows[0]?.stocked ?? 0),
    uncostedProducts: Number(rows[0]?.uncosted ?? 0),
  };
}
