/**
 * scripts/flatten-single-variant-products-2026-09-30.ts against a real
 * database, with the cart asserted through the real API route.
 *
 * The seeded product mirrors pecannbee's shape: ONE active variant
 * ("Size: 380 Gram") holding the stock, the parent's inventory column at 0,
 * an order line and a cart line pointing at the variant, a warehouse shadow
 * row for the variant plus a stale product-level one.
 *
 * Proves: before → cart add without a variantId is refused (the parent column
 * is not stock); apply → the product is simple, the same add is accepted, the
 * order line is unlinked with its snapshot intact, stock is not double
 * counted; a second apply is a no-op; restore → the variant comes back with
 * its original id, the order line is re-linked, and the add without a
 * variantId is refused again. Also: a product whose variant is on an order is
 * BLOCKED without --unlink-order-lines, and a dry-run transaction cannot write.
 *
 * Fixtures are per-CALL (retry-safe).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import crypto from 'crypto';
import { prisma, withRlsBypass } from '@force/database';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  cartClientFor,
  cartSessionId,
  type FixtureStore,
} from '../helpers/bundle-fixtures';
import {
  inTx,
  planProduct,
  applyProduct,
  snapshotProduct,
  restoreProduct,
  selectCandidates,
  type BackupFile,
} from '../../scripts/flatten-single-variant-products-2026-09-30';
import { effectiveInventory, EFFECTIVE_STOCK_SELECT } from '@api/lib/effective-inventory';

async function seedSingleVariantProduct(store: FixtureStore) {
  const uniq = crypto.randomUUID().slice(0, 10);
  return withRlsBypass(async tx => {
    const product = await tx.product.create({
      data: {
        storeId: store.storeId,
        name: `Baked Pretzos ${uniq}`,
        nameAr: 'مخبوزات بريتزوس',
        slug: `pretzos-${uniq}`,
        price: 2500,
        sku: `P-${uniq}`,
        barcode: `B-${uniq}`,
        inventory: 0,
        status: 'active',
        hasVariants: true,
        description: 'Healthy Romanian baked goods',
        descriptionAr: 'مخبوزات رومانية صحية',
      },
    });
    const option = await tx.productOption.create({
      data: { productId: product.id, name: 'Size', position: 0 },
    });
    const value = await tx.productOptionValue.create({
      data: { optionId: option.id, value: '380 Gram', position: 0 },
    });
    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        title: '380 Gram',
        sku: `P-${uniq}-380`,
        barcode: `BV-${uniq}`,
        price: 4000,
        costPrice: 1500,
        inventory: 7,
        imageUrl: `https://example.r2.dev/${uniq}.jpg`,
        options: { create: [{ valueId: value.id }] },
      },
    });
    const order = await tx.order.create({
      data: {
        storeId: store.storeId,
        orderNumber: `SVF-${uniq}`,
        status: 'delivered',
        paymentStatus: 'paid',
        subtotal: 4000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 4000,
        currency: 'KWD',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: product.id,
              variantId: variant.id,
              productName: product.name,
              variantName: '380 Gram',
              sku: variant.sku,
              quantity: 1,
              price: 4000,
              costPrice: 1500,
              total: 4000,
            },
          ],
        },
      },
      include: { items: true },
    });
    const otherCart = await tx.cart.create({
      data: { storeId: store.storeId, sessionId: `svf-other-${uniq}` },
    });
    const cartLine = await tx.cartItem.create({
      data: { cartId: otherCart.id, productId: product.id, variantId: variant.id, quantity: 2 },
    });
    const warehouse = await tx.warehouse.create({
      data: { storeId: store.storeId, name: 'Main', code: `M-${uniq}`, isDefault: true },
    });
    await tx.warehouseStock.create({
      data: {
        warehouseId: warehouse.id,
        storeId: store.storeId,
        productId: product.id,
        variantId: null,
        quantity: 0,
      },
    });
    await tx.warehouseStock.create({
      data: {
        warehouseId: warehouse.id,
        storeId: store.storeId,
        productId: product.id,
        variantId: variant.id,
        quantity: 7,
      },
    });
    return {
      productId: product.id,
      variantId: variant.id,
      orderItemId: order.items[0].id,
      cartLineId: cartLine.id,
      warehouseId: warehouse.id,
    };
  });
}

const readProduct = (id: string) =>
  withRlsBypass(tx =>
    tx.product.findUniqueOrThrow({
      where: { id },
      select: {
        ...EFFECTIVE_STOCK_SELECT,
        price: true,
        costPrice: true,
        sku: true,
        barcode: true,
        hasVariants: true,
        description: true,
        descriptionAr: true,
        images: true,
        options: true,
      },
    })
  );

describe.skipIf(!hasDb)('flatten-single-variant-products script', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(`svf-${suffix}`);
  });

  it('blocks a product whose variant is on an order unless --unlink-order-lines', async () => {
    const s = await seedSingleVariantProduct(store);
    const plan = await inTx(true, tx => planProduct(tx, s.productId, { unlinkOrderLines: false }));
    expect(plan?.blockers.join(' ')).toMatch(/1 order line\(s\) reference the variant/);
    const res = await inTx(false, tx => applyProduct(tx, s.productId, { unlinkOrderLines: false }));
    expect(res.status).toBe('skipped');
    const v = await withRlsBypass(tx =>
      tx.productVariant.findUnique({ where: { id: s.variantId } })
    );
    expect(v).not.toBeNull();
  });

  it('a dry-run transaction cannot write', async () => {
    const s = await seedSingleVariantProduct(store);
    await expect(
      inTx(true, tx => applyProduct(tx, s.productId, { unlinkOrderLines: true }))
    ).rejects.toThrow(/read-only transaction/);
    const v = await withRlsBypass(tx =>
      tx.productVariant.findUnique({ where: { id: s.variantId } })
    );
    expect(v?.inventory).toBe(7);
  });

  it('apply makes it a simple, orderable product; restore puts the variant back', async () => {
    const s = await seedSingleVariantProduct(store);
    const cart = cartClientFor(app, store.storeId, cartSessionId('svf-before'));

    // BEFORE: the parent column (0) is not stock, so a variant-less add is refused.
    await cart.addToCart({ productId: s.productId, quantity: 1 }).expect(400);

    const sel = await inTx(true, tx => selectCandidates(tx, store.storeId));
    expect(sel.candidateIds).toContain(s.productId);

    const opts = { unlinkOrderLines: true };
    const plan = await inTx(true, tx => planProduct(tx, s.productId, opts));
    expect(plan).not.toBeNull();
    expect(plan!.blockers).toEqual([]);
    const snap = await inTx(true, tx => snapshotProduct(tx, plan!));
    const applied = await inTx(false, tx => applyProduct(tx, s.productId, opts));
    expect(applied.status).toBe('flattened');

    const p = await readProduct(s.productId);
    expect(p.hasVariants).toBe(false);
    expect(p.variants).toEqual([]);
    expect(p.options).toEqual([]);
    expect(p.inventory).toBe(7);
    expect(effectiveInventory(p)).toBe(7); // not 14: counted once
    expect(p.price).toBe(4000);
    expect(p.costPrice).toBe(1500);
    expect(p.sku).toMatch(/-380$/);
    expect(p.barcode).toMatch(/^BV-/);
    expect(p.description).toBe('Healthy Romanian baked goods\n\nSize: 380 Gram');
    expect(p.descriptionAr).toBe('مخبوزات رومانية صحية\n\nالحجم: 380 جرام');
    expect(p.images).toHaveLength(1);

    const oi = await withRlsBypass(tx =>
      tx.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } })
    );
    expect(oi.variantId).toBeNull();
    expect(oi.variantName).toBe('380 Gram'); // snapshot untouched
    const cl = await withRlsBypass(tx =>
      tx.cartItem.findUniqueOrThrow({ where: { id: s.cartLineId } })
    );
    expect(cl.variantId).toBeNull();
    const ws = await withRlsBypass(tx =>
      tx.warehouseStock.findMany({ where: { productId: s.productId } })
    );
    expect(ws.map(w => [w.variantId, w.quantity])).toEqual([[null, 7]]);
    const hist = await withRlsBypass(tx =>
      tx.inventoryHistory.findMany({ where: { reference: `flatten-variant:${s.variantId}` } })
    );
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ quantity: 0, previousStock: 7, newStock: 7 });

    // AFTER: the real cart route accepts the product with NO variantId.
    const cartAfter = cartClientFor(app, store.storeId, cartSessionId('svf-after'));
    await cartAfter.addToCart({ productId: s.productId, quantity: 2 }).expect(201);
    await cartAfter.addToCart({ productId: s.productId, quantity: 6 }).expect(400); // 8 > 7

    // Idempotent: a second run finds nothing to do.
    const again = await inTx(false, tx => applyProduct(tx, s.productId, opts));
    expect(again.status).toBe('skipped');

    // Restore — after one unit "sold" while flat, the variant takes the CURRENT stock.
    await withRlsBypass(tx =>
      tx.product.update({ where: { id: s.productId }, data: { inventory: { decrement: 1 } } })
    );
    const backup: BackupFile['products'][number] = {
      ...JSON.parse(JSON.stringify(snap)),
      createdImageId: (applied as { imageId: string | null }).imageId,
    };
    const restored = await inTx(false, tx => restoreProduct(tx, backup));
    expect(restored.status).toBe('restored');

    const r = await readProduct(s.productId);
    expect(r.hasVariants).toBe(true);
    expect(r.inventory).toBe(0);
    expect(r.variants).toHaveLength(1);
    expect(effectiveInventory(r)).toBe(6);
    expect(r.price).toBe(2500);
    expect(r.sku).toBe(snap.product.sku);
    expect(r.description).toBe('Healthy Romanian baked goods');
    expect(r.images).toHaveLength(0);
    const v = await withRlsBypass(tx =>
      tx.productVariant.findUniqueOrThrow({
        where: { id: s.variantId },
        include: { options: true },
      })
    );
    expect(v.options).toHaveLength(1);
    const oi2 = await withRlsBypass(tx =>
      tx.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } })
    );
    expect(oi2.variantId).toBe(s.variantId);
    const ws2 = await withRlsBypass(tx =>
      tx.warehouseStock.findMany({
        where: { productId: s.productId },
        orderBy: { variantId: 'asc' },
      })
    );
    expect(ws2.map(w => [w.variantId, w.quantity])).toEqual([
      [s.variantId, 7],
      [null, 0],
    ]);

    // Back to a variant product: the variant-less add is refused again,
    // the variant add is accepted.
    const cartRestored = cartClientFor(app, store.storeId, cartSessionId('svf-restored'));
    await cartRestored.addToCart({ productId: s.productId, quantity: 1 }).expect(400);
    await cartRestored
      .addToCart({ productId: s.productId, quantity: 1, variantId: s.variantId })
      .expect(201);

    // Restoring twice is a no-op.
    const twice = await inTx(false, tx => restoreProduct(tx, backup));
    expect(twice.status).toBe('skipped');
  });
});
