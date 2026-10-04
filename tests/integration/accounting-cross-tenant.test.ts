/**
 * Cross-tenant writes through the accounting services (integration)
 *
 * Regression test for the 2026-09-02 adversarial audit P0-1 and P0-2.
 *
 * The accounting services took product / variant / supplier / account ids
 * straight from the request body and wrote rows keyed on those bare ids. Their
 * route middleware (authenticate -> authorize -> requireStoreAccess ->
 * requireFeature) only proves the caller owns the store named in the URL — it
 * says nothing about ids in the payload. So a store_admin could harvest a
 * competitor's productId/variantId from the public storefront, post them as
 * line items on their OWN store's stock adjustment or purchase order, and set
 * that tenant's inventory to any value.
 *
 * Production connects as a BYPASSRLS role, so there was no database backstop.
 *
 * Each test asserts BOTH that the call is refused AND that the victim store's
 * row is byte-identical afterwards — a refusal that still wrote would pass a
 * weaker assertion.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withRlsBypass } from '@force/database';
import { createAdjustment } from '../../apps/api/src/services/accounting/stock-adjustment.service';
import { createPurchaseOrder } from '../../apps/api/src/services/accounting/purchase-order.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('accounting services refuse cross-tenant ids', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;

  let attackerStoreId: string;
  let victimStoreId: string;
  let victimProductId: string;
  let victimVariantId: string;
  let victimSupplierId: string;
  const VICTIM_STOCK = 42;
  const VICTIM_VARIANT_STOCK = 17;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `xt-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'XT',
          lastName: 'Owner',
        },
      });

      const attacker = await tx.store.create({
        data: {
          name: 'xt-attacker',
          slug: `xt-attacker-${suffix}`,
          template: 'modern',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      attackerStoreId = attacker.id;

      const victim = await tx.store.create({
        data: {
          name: 'xt-victim',
          slug: `xt-victim-${suffix}`,
          template: 'modern',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      victimStoreId = victim.id;

      const product = await tx.product.create({
        data: {
          storeId: victimStoreId,
          name: 'Victim Product',
          slug: `xt-victim-product-${suffix}`,
          price: 5000,
          inventory: VICTIM_STOCK,
          trackInventory: true,
        },
      });
      victimProductId = product.id;

      const variant = await tx.productVariant.create({
        data: {
          productId: victimProductId,
          title: 'Victim Variant',
          sku: `XT-VAR-${suffix}`,
          price: 5000,
          inventory: VICTIM_VARIANT_STOCK,
        },
      });
      victimVariantId = variant.id;

      const supplier = await tx.supplier.create({
        data: { storeId: victimStoreId, name: 'Victim Supplier' },
      });
      victimSupplierId = supplier.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      for (const id of [attackerStoreId, victimStoreId]) {
        await tx.purchaseOrderItem
          .deleteMany({ where: { purchaseOrder: { storeId: id } } })
          .catch(() => {});
        await tx.purchaseOrder.deleteMany({ where: { storeId: id } }).catch(() => {});
        await tx.stockAdjustmentItem
          .deleteMany({ where: { adjustment: { storeId: id } } })
          .catch(() => {});
        await tx.stockAdjustment.deleteMany({ where: { storeId: id } }).catch(() => {});
        await tx.supplier.deleteMany({ where: { storeId: id } }).catch(() => {});
      }
      await tx.productVariant
        .deleteMany({ where: { sku: { startsWith: 'XT-VAR-' } } })
        .catch(() => {});
      await tx.product.deleteMany({ where: { slug: { startsWith: 'xt-' } } }).catch(() => {});
      await tx.store.deleteMany({ where: { slug: { startsWith: 'xt-' } } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { startsWith: 'xt-owner-' } } }).catch(() => {});
    });
  });

  async function victimVariantStock(): Promise<number> {
    const v = await withRlsBypass(tx =>
      tx.productVariant.findUniqueOrThrow({
        where: { id: victimVariantId },
        select: { inventory: true },
      })
    );
    return v.inventory;
  }

  async function victimProductStock(): Promise<number> {
    const p = await withRlsBypass(tx =>
      tx.product.findUniqueOrThrow({
        where: { id: victimProductId },
        select: { inventory: true },
      })
    );
    return p.inventory;
  }

  it('refuses a stock adjustment naming another store’s VARIANT (P0-1)', async () => {
    await expect(
      createAdjustment({
        storeId: attackerStoreId,
        type: 'cycle_count',
        items: [{ productId: victimProductId, variantId: victimVariantId, newQty: 0 }],
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await victimVariantStock()).toBe(VICTIM_VARIANT_STOCK);
  });

  it('refuses a stock adjustment naming another store’s PRODUCT (P0-1)', async () => {
    await expect(
      createAdjustment({
        storeId: attackerStoreId,
        type: 'cycle_count',
        items: [{ productId: victimProductId, newQty: 0 }],
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await victimProductStock()).toBe(VICTIM_STOCK);
  });

  it('refuses a purchase order naming another store’s product/variant (P0-2)', async () => {
    await expect(
      createPurchaseOrder({
        storeId: attackerStoreId,
        supplierId: victimSupplierId,
        items: [{ productId: victimProductId, variantId: victimVariantId, qty: 5, unitCost: 100 }],
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await victimVariantStock()).toBe(VICTIM_VARIANT_STOCK);
    expect(await victimProductStock()).toBe(VICTIM_STOCK);
  });

  it('refuses a purchase order naming another store’s SUPPLIER (P0-2 read path)', async () => {
    // The supplier row is read back verbatim by getPurchaseOrder's
    // `include: { supplier: true }` — name, phone, email, address, terms.
    await expect(
      createPurchaseOrder({
        storeId: attackerStoreId,
        supplierId: victimSupplierId,
        items: [{ productId: victimProductId, qty: 1, unitCost: 100 }],
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('still allows a store to adjust its OWN stock', async () => {
    const own = await withRlsBypass(tx =>
      tx.product.create({
        data: {
          storeId: attackerStoreId,
          name: 'Own Product',
          slug: `xt-own-product-${suffix}-${Date.now()}`,
          price: 1000,
          inventory: 5,
          trackInventory: true,
        },
      })
    );

    const adjustment = await createAdjustment({
      storeId: attackerStoreId,
      type: 'cycle_count',
      items: [{ productId: own.id, newQty: 9 }],
    });
    expect(adjustment.items).toHaveLength(1);
    // Cleanup is left to afterAll: a StockAdjustmentItem FK now references
    // this product, so it must be deleted after the adjustment rows.
  });
});
