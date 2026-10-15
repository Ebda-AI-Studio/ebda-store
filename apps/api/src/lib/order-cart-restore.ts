/**
 * Turns an order's `OrderItem` rows back into the cart rows a customer
 * should find waiting for them after a failed payment — the shape
 * `OrderService.rollbackForPaymentFailure` writes.
 *
 * P1-1 (final review): the restore used to aggregate EVERY line into loose
 * `CartItem` rows, including the component lines a bundle expanded into. A
 * customer whose payment failed on a "Ramadan Box" (componentSum 14500,
 * bundle price 12000) came back to a cart of three loose products priced at
 * shelf price by `cartLineUnitPrice` — 14.500, not 12.000, with no
 * explanation — and re-checking out cost them 2.500 more than they meant to
 * spend while the merchant's bundle never sold. `CartBundle` exists exactly
 * for this and the checkout path already writes to it, so the restore
 * recreates the box instead of dissolving it.
 *
 * Pure and dependency-free so the mapping is unit-testable without a
 * database (the surrounding rollback is a Prisma transaction).
 *
 * Rules:
 *  - A line with a `bundleId` belongs to a box. Its `bundleGroupId` is
 *    minted per BOX at checkout, so the number of DISTINCT group ids for a
 *    bundle is exactly how many boxes were ordered — that is the restored
 *    `CartBundle.quantity`. A line with a `bundleId` but no `bundleGroupId`
 *    cannot be attributed to a box and is restored as a loose line rather
 *    than silently dropped.
 *  - `OrderItem.bundleId` deliberately carries NO foreign key to `Bundle`
 *    (snapshot semantics, like `productName`/`costPrice`), so the bundle it
 *    names is not guaranteed to still exist. `liveBundleIds` is the set that
 *    does; anything outside it falls back to loose lines. Without that,
 *    `cartBundle.create` would raise a FK violation and take down the whole
 *    compensating transaction — leaving inventory unrestored, the coupon
 *    unreleased and the order stuck `pending`, which is strictly worse than
 *    the mispricing this function exists to fix. Omit the argument to trust
 *    every id (used by the pure tests).
 *  - Genuinely loose lines aggregate by `(productId, variantId, personalisation)`,
 *    because `cart_items` carries a partial unique index on (product, variant,
 *    COALESCE(note,'')) — "Sara" and "Omar" on one abaya come back as two lines
 *    with their notes, never merged into one unnamed line — and a bundle
 *    order can legitimately produce two `OrderItem` rows for one product
 *    (two boxes sharing a component, or a box plus a loose line of the same
 *    product).
 *  - For an order with no bundle lines this is the identity transform the
 *    pre-bundle rollback already performed: `bundles` is empty and `items`
 *    is the same aggregation.
 */

export interface RestorableOrderItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  bundleId?: string | null;
  bundleGroupId?: string | null;
  /** The line's personalisation snapshot; restored as the cart line's `note`. */
  personalisation?: string | null;
}

type RestoredItem = { productId: string; variantId?: string; quantity: number; note?: string };

export interface RestoredCart {
  /** Loose `CartItem` rows, aggregated by (productId, variantId, note). */
  items: RestoredItem[];
  /** One `CartBundle` row per distinct bundle, quantity = number of boxes. */
  bundles: Array<{ bundleId: string; quantity: number }>;
}

export function restoreCartShape(
  orderItems: RestorableOrderItem[],
  liveBundleIds?: ReadonlySet<string>
): RestoredCart {
  const looseByKey = new Map<string, RestoredItem>();
  const boxesByBundle = new Map<string, Set<string>>();

  for (const item of orderItems) {
    const bundleStillExists =
      !!item.bundleId && (liveBundleIds === undefined || liveBundleIds.has(item.bundleId));
    if (item.bundleId && item.bundleGroupId && bundleStillExists) {
      const groups = boxesByBundle.get(item.bundleId) ?? new Set<string>();
      groups.add(item.bundleGroupId);
      boxesByBundle.set(item.bundleId, groups);
      continue;
    }

    const note = item.personalisation || null;
    const key = JSON.stringify([item.productId, item.variantId ?? null, note]);
    const existing = looseByKey.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      looseByKey.set(key, {
        productId: item.productId,
        variantId: item.variantId ?? undefined,
        quantity: item.quantity,
        ...(note ? { note } : {}),
      });
    }
  }

  return {
    items: [...looseByKey.values()],
    bundles: [...boxesByBundle.entries()].map(([bundleId, groups]) => ({
      bundleId,
      quantity: groups.size,
    })),
  };
}
