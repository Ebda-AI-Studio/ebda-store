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
 * Deliberately free of any `@ebda/database` import so that every module on
 * the request path (cart, orders, routes) can use it without pulling Prisma
 * into their unit-test mocks. The SQL twin — for queries that must filter,
 * sort or aggregate on stock — lives in `effective-inventory-sql.ts`.
 */

export interface StockShape {
  inventory: number;
  trackInventory?: boolean;
  allowBackorder?: boolean;
  /**
   * EVERY variant of the product, disabled ones included, each with its
   * `isActive` flag — do not pre-filter with `where: { isActive: true }`. A
   * product with only disabled variants is still a variant product; filtered
   * to zero rows it would read as variant-less and fall back to the unused
   * parent column. An omitted `isActive` counts as active.
   */
  variants?: Array<{ inventory: number; allowBackorder?: boolean; isActive?: boolean }> | null;
}

/**
 * The stock rule for variants (owner decision, 2026-09-25, #1103): a DISABLED
 * variant (`isActive = false`) is not stock — not on the storefront, not in the
 * admin, not to the WhatsApp bot, not in low-stock alerts, not in finance.
 * Checkout could never sell one, so counting it only produced a product that
 * read "in stock" on inventory nobody could buy.
 */
export function activeVariants<V extends { isActive?: boolean }>(
  variants: readonly V[] | null | undefined
): V[] {
  return (variants ?? []).filter(v => v.isActive !== false);
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
  variants: { select: { inventory: true, allowBackorder: true, isActive: true } },
} as const;

/**
 * Stock for a product: the sum of its ACTIVE variants when it has variants
 * (0 when every variant is disabled), else its own column.
 */
export function effectiveInventory(product: StockShape): number {
  const variants = product.variants ?? [];
  if (variants.length === 0) return product.inventory;
  return activeVariants(variants).reduce((sum, v) => sum + (v.inventory ?? 0), 0);
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

  const allowsBackorder =
    product.allowBackorder === true ||
    activeVariants(product.variants).some(v => v.allowBackorder === true);
  return backorderFeatureEnabled && allowsBackorder;
}
