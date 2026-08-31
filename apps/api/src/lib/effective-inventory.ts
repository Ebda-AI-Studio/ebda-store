/**
 * The single definition of "how much stock does this product have".
 *
 * `products.inventory` means on-hand stock ONLY for a product with no
 * variants. For a variant product the stock lives on the variants and the
 * parent column is unused (held at 0 by the invariant this module exists to
 * protect) — see `enrichStockFlags` in product.service.ts, which has always
 * documented that contract for the public serializer.
 *
 * Before this module, six call sites each dereferenced `product.inventory`
 * directly and were therefore blind to variants. Because checkout also
 * decremented the parent on every variant sale, that column had drifted
 * negative on 24 live products, and each of those readers turned the drift
 * into a permanent, un-clearable "out of stock" (see
 * docs/superpowers/plans/2026-08-30-variant-stock-drift.md). Read stock
 * through here; do not dereference `.inventory` in a new call site.
 *
 * Deliberately free of any `@force/database` import so that every module on
 * the request path (cart, orders, routes) can use it without pulling Prisma
 * into their unit-test mocks. The SQL twin — for queries that must filter,
 * sort or aggregate on stock — lives in `effective-inventory-sql.ts`.
 */

export interface StockShape {
  inventory: number;
  trackInventory?: boolean;
  allowBackorder?: boolean;
  variants?: Array<{ inventory: number; allowBackorder?: boolean }> | null;
}

/**
 * Prisma `select` fragment supplying everything `effectiveInventory` and
 * `isOrderable` need. Spread it into a product select so a caller cannot
 * accidentally omit `variants` — an omitted `variants` is indistinguishable
 * from "has no variants" at runtime, which is precisely how a variant-blind
 * read looks correct in review and wrong in production.
 */
export const EFFECTIVE_STOCK_SELECT = {
  inventory: true,
  trackInventory: true,
  allowBackorder: true,
  variants: { select: { inventory: true, allowBackorder: true } },
} as const;

/** Stock for a product: the variant sum when it has variants, else its own column. */
export function effectiveInventory(product: StockShape): number {
  const variants = product.variants ?? [];
  if (variants.length === 0) return product.inventory;
  return variants.reduce((sum, v) => sum + (v.inventory ?? 0), 0);
}

/**
 * Whether `qty` of this product can be ordered. Mirrors the dual-gate the
 * order/cart paths already use: an out-of-stock line is accepted ONLY when
 * the store-level `inventory.backorder` feature AND a per-product/per-variant
 * `allowBackorder` flag are both set.
 */
export function isOrderable(
  product: StockShape,
  qty: number,
  backorderFeatureEnabled: boolean
): boolean {
  if (product.trackInventory === false) return true;
  if (effectiveInventory(product) >= qty) return true;

  const variants = product.variants ?? [];
  const allowsBackorder =
    product.allowBackorder === true || variants.some(v => v.allowBackorder === true);
  return backorderFeatureEnabled && allowsBackorder;
}
