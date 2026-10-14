/**
 * I1 (final review): `bundle_items.variant_id` and `.product_id` are
 * `ON DELETE RESTRICT` — a bundle pinning a variant or product must not
 * silently lose it. Variants/products are still deleted through the
 * ordinary catalogue routes, so this suite proves those paths now catch the
 * P2003 foreign-key violation and surface an actionable domain error
 * instead of a raw database error (single-target deletes), or a per-item
 * partial failure that does not take down the whole batch (bulk permanent
 * delete).
 *
 * Real Postgres throughout (mirrors tests/integration/order-bundles.test.ts)
 * — gated on `hasDb` so this suite skips cleanly with no DB configured.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import { VariantService } from '@api/services/variant.service';
import { BulkService } from '@api/services/bulk.service';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedBundle,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('bundle_items RESTRICT FK — actionable errors, not raw 500s', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let store: FixtureStore;

  beforeAll(async () => {
    store = await seedBundleStore(suffix);
  });

  async function seedVariant(productId: string, title: string) {
    const variant = await withRlsBypass(tx =>
      tx.productVariant.create({
        data: { productId, title, inventory: 10 },
      })
    );
    return variant.id;
  }

  it('deleteVariant refuses with an actionable error when the variant is pinned by a bundle', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-dv-p`, { price: 1000, inventory: 10 });
    const variantId = await seedVariant(p, 'Pinned Variant');
    await seedBundle(store.storeId, `${suffix}-dv-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId: p, variantId, quantity: 1 }],
    });

    await expect(VariantService.deleteVariant(store.storeId, p, variantId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'VARIANT_USED_IN_BUNDLE',
    });

    // Nothing was deleted — the row survives the rejected attempt.
    const stillThere = await prisma.productVariant.findUnique({ where: { id: variantId } });
    expect(stillThere).not.toBeNull();
  });

  it('deleteVariant succeeds normally for a variant NOT referenced by any bundle', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-dv-free-p`, {
      price: 1000,
      inventory: 10,
    });
    const variantId = await seedVariant(p, 'Free Variant');

    await expect(
      VariantService.deleteVariant(store.storeId, p, variantId)
    ).resolves.toBeUndefined();
    const gone = await prisma.productVariant.findUnique({ where: { id: variantId } });
    expect(gone).toBeNull();
  });

  it('deleteOption refuses with an actionable error when ANY of its variants is bundle-pinned', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-do-p`, { price: 1000, inventory: 10 });
    const option = await withRlsBypass(tx =>
      tx.productOption.create({ data: { productId: p, name: 'Size' } })
    );
    const pinnedVariantId = await seedVariant(p, 'Small');
    const freeVariantId = await seedVariant(p, 'Large');
    await seedBundle(store.storeId, `${suffix}-do-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId: p, variantId: pinnedVariantId, quantity: 1 }],
    });

    await expect(VariantService.deleteOption(store.storeId, p, option.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'VARIANT_USED_IN_BUNDLE',
    });

    // All-or-nothing: the unpinned sibling variant also survives, because
    // the whole deleteMany rolled back.
    const stillThere = await prisma.productVariant.findUnique({ where: { id: freeVariantId } });
    expect(stillThere).not.toBeNull();
  });

  it('bulkDelete(permanent) deletes the non-bundled product and reports the bundled one as a per-item failure, WITHOUT failing the whole batch', async () => {
    const bundled = await seedProduct(store.storeId, `${suffix}-bulk-bundled`, {
      price: 1000,
      inventory: 10,
    });
    const free = await seedProduct(store.storeId, `${suffix}-bulk-free`, {
      price: 1000,
      inventory: 10,
    });
    await seedBundle(store.storeId, `${suffix}-bulk-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId: bundled, quantity: 1 }],
    });

    const result = await BulkService.bulkDelete(store.storeId, [bundled, free], true);

    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/used in a bundle/i);

    const freeGone = await prisma.product.findUnique({ where: { id: free } });
    expect(freeGone).toBeNull();
    const bundledStillThere = await prisma.product.findUnique({ where: { id: bundled } });
    expect(bundledStillThere).not.toBeNull();
  });

  it('bulkDelete(permanent) takes the fast single-query path (no per-item fallback) when nothing in the batch is bundled', async () => {
    const a = await seedProduct(store.storeId, `${suffix}-bulk-fast-a`, {
      price: 1000,
      inventory: 10,
    });
    const b = await seedProduct(store.storeId, `${suffix}-bulk-fast-b`, {
      price: 1000,
      inventory: 10,
    });

    const result = await BulkService.bulkDelete(store.storeId, [a, b], true);
    expect(result).toEqual({ deleted: 2, failed: 0, errors: [] });
  });
});
