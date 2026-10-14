import { Prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';

/**
 * `bundle_items.variant_id` and `bundle_items.product_id` are `ON DELETE
 * RESTRICT` (final-review I1): a bundle pinning a variant or product must
 * not silently lose it when the catalogue is edited. Postgres raises a
 * P2003 foreign-key violation on any delete that would orphan a
 * `bundle_items` row; left uncaught, the caller gets the global error
 * handler's generic "A referenced record does not exist" with no idea a
 * bundle is the reason, or — worse — a bulk `deleteMany` fails its whole
 * batch with no per-item detail at all.
 *
 * Constraint names come from the migration
 * (`20260906120000_product_bundles/migration.sql`): `bundle_items_variant_id_fkey`
 * and `bundle_items_product_id_fkey`. Matched against the whole serialised
 * `meta` object rather than one specific key, because Prisma's Postgres
 * connector places the constraint name under `field_name` and that shape is
 * not part of Prisma's public API contract.
 */
export type BundleFkViolation = 'variant' | 'product' | null;

/** Returns which bundle FK the error violated, or null for anything else. */
export function bundleFkViolationKind(err: unknown): BundleFkViolation {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2003') {
    return null;
  }
  const meta = JSON.stringify(err.meta ?? {});
  if (meta.includes('bundle_items_variant_id_fkey')) return 'variant';
  if (meta.includes('bundle_items_product_id_fkey')) return 'product';
  return null;
}

/**
 * Call from a `catch` block around a single-target delete. Throws an
 * actionable `AppError` when the violation is one of the two bundle FKs
 * (naming which one, so the merchant knows whether to fix a variant or a
 * product), and returns normally (does nothing) for every other error so
 * the caller can rethrow it unchanged.
 */
export function throwIfBundleFkViolation(err: unknown): void {
  const kind = bundleFkViolationKind(err);
  if (kind === 'variant') {
    throw new AppError(
      409,
      'VARIANT_USED_IN_BUNDLE',
      'This variant is used in a bundle and cannot be deleted. Remove it from the bundle first.'
    );
  }
  if (kind === 'product') {
    throw new AppError(
      409,
      'PRODUCT_USED_IN_BUNDLE',
      'This product is used in a bundle and cannot be permanently deleted. Remove it from the bundle first.'
    );
  }
}

/**
 * The message a merchant sees when a CSV re-import would delete variants a
 * bundle pins.
 *
 * P1-4 (final review): the bundle-FK defect class was swept into the three
 * variant delete sites and the permanent bulk product delete, but NOT into
 * `createVariantsForProductTx` — the CSV product import's replace-semantics
 * `productVariant.deleteMany`. A re-import of a product whose variant is
 * pinned by a `bundle_items` row raised P2003 inside the batch transaction,
 * so the batch rolled back and EVERY unrelated product in the same CSV was
 * lost with it, under the global handler's generic "A referenced record does
 * not exist" — no mention of a bundle. Naming both the product and the
 * bundle is the actionable half; `planBundlePinnedVariantSkips` below is the
 * "don't take the rest of the batch down with it" half.
 */
export function variantsPinnedByBundleMessage(parentSku: string, bundleNames: string[]): string {
  const named = bundleNames.length > 0 ? bundleNames.join(', ') : 'a bundle';
  return (
    `Variants of product ${parentSku} are used in bundle(s): ${named}. ` +
    `Remove the product from those bundles before re-importing its variants. ` +
    `The rest of the file was imported.`
  );
}

/**
 * Decides which parent SKUs' variant rows must be skipped because a bundle
 * pins one of that product's existing variants, and what to tell the
 * merchant. Pure so the decision is unit-testable without a database; the
 * caller does the (single, batched) `bundleItem.findMany` that produces
 * `pinned` and then drops the named SKUs from its import plan.
 */
export function planBundlePinnedVariantSkips(
  /** Parent SKU -> existing product id, for every parent that has variant rows in the file. */
  parentIdBySku: Map<string, string>,
  /** Bundle items pinning a VARIANT of any of those products. */
  pinned: Array<{ productId: string; bundle: { name: string } }>
): Array<{ parentSku: string; bundleNames: string[]; message: string }> {
  const bundleNamesByProductId = new Map<string, Set<string>>();
  for (const row of pinned) {
    const names = bundleNamesByProductId.get(row.productId) ?? new Set<string>();
    names.add(row.bundle.name);
    bundleNamesByProductId.set(row.productId, names);
  }

  const skips: Array<{ parentSku: string; bundleNames: string[]; message: string }> = [];
  for (const [parentSku, productId] of parentIdBySku) {
    const names = bundleNamesByProductId.get(productId);
    if (!names) continue;
    const bundleNames = [...names].sort();
    skips.push({
      parentSku,
      bundleNames,
      message: variantsPinnedByBundleMessage(parentSku, bundleNames),
    });
  }
  return skips;
}
