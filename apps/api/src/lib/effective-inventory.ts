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
 * May THIS line (a product, or one of its variants) be sold past its stock?
 * The ONE server rule, shared by cart add / sync / quantity change and the
 * checkout decrement (X-02 fix round): the store's `inventory.backorder`
 * feature AND (the variant's own flag OR the product's flag). A variant
 * inherits its parent's `allowBackorder` (the merchant's bulk toggle sets only
 * the product flag; `ProductVariant.allowBackorder` defaults to false) — the
 * same inheritance `enrichStockFlags` shows the shopper, so the storefront and
 * the server can never disagree about a pre-order.
 */
export function lineAllowsBackorder(
  product: { allowBackorder?: boolean | null },
  variant: { allowBackorder?: boolean | null } | null | undefined,
  backorderFeatureEnabled: boolean
): boolean {
  return (
    backorderFeatureEnabled && (variant?.allowBackorder === true || product.allowBackorder === true)
  );
}

/**
 * Apply the store's `inventory.backorder` feature to a public stock payload
 * AFTER the cache read (the cached payload never decides an entitlement — the
 * `product_3d` precedent in public.routes.ts). With the feature off no product
 * or variant reads as backorderable, because the cart and checkout refuse it.
 * CACHE CLASS: NEVER-stale entitlement, applied per request; FeatureService's
 * own cache is busted on every override write.
 */
export function gateBackorder<
  T extends {
    acceptsBackorder?: boolean;
    lowStock?: boolean;
    availableQty?: number | null;
    variants?: unknown;
  },
>(p: T, backorderFeatureEnabled: boolean): T {
  if (backorderFeatureEnabled || !p || typeof p !== 'object') return p;
  const off = <
    V extends { acceptsBackorder?: boolean; lowStock?: boolean; availableQty?: number | null },
  >(
    x: V
  ): V =>
    x.acceptsBackorder
      ? { ...x, acceptsBackorder: false, availableQty: x.lowStock ? x.availableQty : null }
      : x;
  const variants = Array.isArray(p.variants)
    ? (p.variants as Array<Record<string, unknown>>).map(v => off(v as never))
    : p.variants;
  return { ...off(p), variants } as T;
}

/**
 * `gateBackorder` over a whole response body (a listing page, a recommendation
 * bundle, a wishlist): every object carrying a boolean `acceptsBackorder` is
 * gated. Returns the SAME reference when the feature is on (no copy).
 */
export function gateBackorderPayload<T>(body: T, backorderFeatureEnabled: boolean): T {
  if (backorderFeatureEnabled) return body;
  // Walk ONLY arrays and plain objects. A Date, a Prisma Decimal, a Buffer or any
  // class instance is returned as the same reference: rebuilding it from its own
  // enumerable keys turned a `createdAt` Date into `{}` (and the PDP's
  // review dates and the "New" badge with it). Copy-on-write: an untouched
  // subtree keeps its identity.
  const isPlain = (v: object): boolean => {
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      let changed = false;
      const next = v.map(x => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? next : v;
    }
    if (!isPlain(v)) return v;
    const o = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(o)) {
      const y = walk(x, depth + 1);
      if (y !== x) (out ??= { ...o })[k] = y;
    }
    const base = out ?? o;
    if (base.acceptsBackorder === true) return gateBackorder(base as never, false);
    return base;
  };
  return walk(body, 0) as T;
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
    /** false = the merchant does not track stock: always in stock (as `isOrderable`). */
    trackInventory?: boolean;
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

  // Untracked stock is always in stock — the same answer `isOrderable` and the
  // cart give (X-02 fix round: the storefront read an untracked product with
  // inventory 0 as sold out while the server sold it).
  const untracked = product.trackInventory === false;
  const inStock = untracked || effectiveInventory > 0;
  const lowStock = !untracked && inStock && effectiveInventory <= product.lowStockThreshold;
  const acceptsBackorder = !inStock && productAllowsBackorder;
  const availableQty = lowStock || acceptsBackorder ? effectiveInventory : null;

  // `isActive` is read here and stripped: it drives the flags, it is not part
  // of the storefront variant shape.
  const enrichedVariants = variants.map(({ isActive, ...v }) => {
    const sellableVariant = isActive !== false;
    const vInStock = sellableVariant && (untracked || v.inventory > 0);
    const vLowStock = !untracked && vInStock && v.inventory <= product.lowStockThreshold;
    const vAcceptsBackorder =
      // The cart/checkout rule; the store feature is applied per request (gateBackorder).
      sellableVariant && !vInStock && lineAllowsBackorder(product, v, true);
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
  const {
    lowStockThreshold: _lowStockThreshold,
    // Read above, not shipped (merchant-internal, STOREFRONT_PRODUCT_SELECT excludes it).
    trackInventory: _trackInventory,
    ...productWithoutThreshold
  } = product;

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
