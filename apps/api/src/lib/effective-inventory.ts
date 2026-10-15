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

/**
 * Availability fields computed by `enrichStockFlags`. Declared explicitly so
 * the function's return type is `P & StockFlags` rather than the input type
 * erased down to its constraint — consumers (e.g. the AI product feed's
 * `buildProductFeed`, which reads `inStock`/`acceptsBackorder`) get compile-
 * time visibility of these fields instead of relying on `listPublic`
 * accidentally returning `any` (which the pre-2026-07-13 inner-cache
 * `JSON.parse` early-return used to cause — see the H1 note in
 * `docs/audits/2026-07-13-cache-stampede.md`).
 */
export interface StockFlags {
  /** Variant-aware aggregate (sum of variant inventory for variant products). */
  inventory: number;
  inStock: boolean;
  lowStock: boolean;
  acceptsBackorder: boolean;
  /** Exact qty when (lowStock || acceptsBackorder); null otherwise. */
  availableQty: number | null;
}

export function enrichStockFlags<
  P extends {
    inventory: number;
    allowBackorder: boolean;
    lowStockThreshold: number;
    variants?: Array<{
      inventory: number;
      allowBackorder?: boolean;
      isActive?: boolean;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  },
>(product: P): P & StockFlags {
  const variants = product.variants ?? [];
  const hasVariants = variants.length > 0;
  // A disabled variant is not stock (#1103) — the same rule as
  // lib/effective-inventory.ts, which this must never disagree with.
  const sellable = activeVariants(variants);

  // Variant products: effective stock = sum of ACTIVE variant inventory (0 when
  // every variant is disabled). Single-SKU products keep their own column.
  const effectiveInventory = hasVariants
    ? sellable.reduce((sum, v) => sum + (v.inventory ?? 0), 0)
    : product.inventory;

  // Backorder is allowed when the product flag is set, or (for variant products)
  // any ACTIVE variant permits backorder.
  const productAllowsBackorder =
    product.allowBackorder || (hasVariants && sellable.some(v => v.allowBackorder === true));

  const inStock = effectiveInventory > 0;
  const lowStock = inStock && effectiveInventory <= product.lowStockThreshold;
  const acceptsBackorder = effectiveInventory <= 0 && productAllowsBackorder;
  const availableQty = lowStock || acceptsBackorder ? effectiveInventory : null;

  // `isActive` is read here and stripped: it drives the flags, it is not part
  // of the storefront variant shape.
  const enrichedVariants = variants.map(({ isActive, ...v }) => {
    const sellableVariant = isActive !== false;
    const vInStock = sellableVariant && v.inventory > 0;
    const vLowStock = vInStock && v.inventory <= product.lowStockThreshold;
    const vAcceptsBackorder =
      sellableVariant &&
      v.inventory <= 0 &&
      ((v.allowBackorder ?? false) || product.allowBackorder);
    const vAvailableQty = vLowStock || vAcceptsBackorder ? v.inventory : null;
    return {
      ...v,
      inStock: vInStock,
      lowStock: vLowStock,
      acceptsBackorder: vAcceptsBackorder,
      availableQty: vAvailableQty,
    };
  });

  // lowStockThreshold is only needed above to compute the `lowStock` flag —
  // the raw threshold number itself is never rendered by the storefront, so
  // it's dropped here rather than leaked through the `...product` spread.
  // (Return type stays `P & StockFlags`, not `Omit<P, 'lowStockThreshold'>`:
  // P carries a `[key: string]: unknown` index signature, so TS can't prove
  // Omit actually narrows it — the runtime strip below is what matters.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-discard
  const { lowStockThreshold: _lowStockThreshold, ...productWithoutThreshold } = product;

  return {
    ...productWithoutThreshold,
    // Surface the variant-aware aggregate as `inventory` so storefront cards,
    // structured data, and the PDP fallback all read the correct stock.
    inventory: effectiveInventory,
    inStock,
    lowStock,
    acceptsBackorder,
    availableQty,
    variants: enrichedVariants,
    // `unknown` first: TS can't prove Omit<P, 'lowStockThreshold'> overlaps
    // with the generic P & StockFlags target since P is arbitrary at the
    // call site — the runtime shape is correct (verified by the callers'
    // usage), this is a generic-cast limitation, not a real mismatch.
  } as unknown as P & StockFlags;
}
