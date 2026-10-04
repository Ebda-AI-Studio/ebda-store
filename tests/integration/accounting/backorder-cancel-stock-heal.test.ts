/**
 * Cancelling one backorder line heals the stock debt it left — up to 0, never
 * above (owner decision 2026-10-01, #2277, ruling AP-5c).
 *
 * A NON-variant backordered checkout force-decrements `products.inventory`
 * unfloored, so the product carries the shortfall as a negative debt. Before
 * this, cancelling the line restored nothing and the product read out of
 * stock forever for units that will never ship. Now the cancel restores
 * `min(unfulfilled units, −inventory)`: the negative part only.
 *
 * Driven through the REAL checkout (`OrderService.create`) so the debt under
 * test is the one checkout actually writes, then the real `cancelBackorder`
 * and the real whole-order inventory restore (`handleOrderRefunded`).
 * `applyRefundEffects` is captured (it only enqueues the fanout event), and
 * the storefront cache purge is spied.
 *
 * DB-direct, self-skips without a real DATABASE_URL, per-call unique fixtures
 * (retry-safe).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { cancelBackorder } from '@api/services/accounting/backorder.service';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { invalidateStoreProductCaches } from '@api/lib/public-cache';
import { seedCoaForStore } from '@api/services/accounting/account.service';
import { createSupplier } from '@api/services/accounting/supplier.service';
import {
  createPurchaseOrder,
  receivePurchaseOrder,
} from '@api/services/accounting/purchase-order.service';
import {
  hasDb,
  seedBundleStore,
  cartSessionId,
  DEFAULT_TEST_SHIPPING_ADDRESS,
} from '../../helpers/bundle-fixtures';

vi.mock('@api/lib/public-cache', async orig => ({
  ...(await orig<typeof import('@api/lib/public-cache')>()),
  invalidateStoreProductCaches: vi.fn(async () => undefined),
}));

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const stepStub = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

beforeEach(() => {
  if (!hasDb) return;
  vi.mocked(invalidateStoreProductCaches).mockClear();
  vi.spyOn(OrderService, 'applyRefundEffects').mockImplementation(async () => undefined);
});

async function backorderStore() {
  const store = await seedBundleStore(uid());
  await withRlsBypass(tx =>
    tx.storeFeature.create({
      data: { storeId: store.storeId, featureKey: 'inventory.backorder', enabled: true },
    })
  );
  return store;
}

async function simpleProduct(storeId: string, inventory: number, trackInventory = true) {
  const suffix = uid();
  return withRlsBypass(tx =>
    tx.product.create({
      data: {
        storeId,
        name: `heal-simple-${suffix}`,
        slug: `heal-simple-${suffix}`,
        price: 1000,
        costPrice: 400,
        inventory,
        trackInventory,
        allowBackorder: true,
        status: 'active',
      },
    })
  );
}

/** A real guest checkout of `lines`; returns the order + its backorder lines. */
async function checkout(
  storeId: string,
  lines: Array<{ productId: string; quantity: number; variantId?: string }>
) {
  const sessionId = cartSessionId('backorder-heal');
  await CartService.getOrCreate(storeId, sessionId);
  for (const l of lines) {
    await CartService.addItem(storeId, sessionId, l.productId, l.quantity, undefined, l.variantId);
  }
  const order = await OrderService.create(storeId, undefined, sessionId, {
    shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
    paymentMethod: 'paymob',
  });
  const backorders = await withRlsBypass(tx =>
    tx.backorderLine.findMany({
      where: { orderItem: { orderId: order.id } },
      orderBy: { createdAt: 'asc' },
    })
  );
  return { order, backorders };
}

const stock = async (productId: string) =>
  (await withRlsBypass(tx => tx.product.findUniqueOrThrow({ where: { id: productId } }))).inventory;

const cancel = (storeId: string, ownerId: string, backorderId: string) =>
  runInTenantContext(storeId, () => cancelBackorder(storeId, backorderId, 'supplier out', ownerId));

const healRows = (productId: string) =>
  withRlsBypass(tx =>
    tx.inventoryHistory.findMany({
      where: { productId, type: 'return_stock' },
      orderBy: { createdAt: 'asc' },
    })
  );

describe.skipIf(!hasDb)('backorder line cancel → stock debt healed to 0 (#2277)', () => {
  it('heals only the negative part: 2 on hand, 5 ordered → −3 → cancel → 0 (not 2)', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 2);
    const { order, backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 5 }]);
    expect(await stock(p.id)).toBe(-3); // checkout's unfloored force-decrement
    expect(backorders).toHaveLength(1);

    await cancel(store.storeId, store.ownerId, backorders[0].id);

    expect(await stock(p.id)).toBe(0);
    const rows = await healRows(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      storeId: store.storeId,
      quantity: 3,
      previousStock: -3,
      newStock: 0,
      reference: `backorder:${backorders[0].id}`,
      createdBy: store.ownerId,
    });
    const marker = await withRlsBypass(tx =>
      tx.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, toStatus: 'backorder_line_cancelled' },
      })
    );
    expect((marker.metadata as { stockRestored: number }).stockRestored).toBe(3);
    expect(invalidateStoreProductCaches).toHaveBeenCalledWith(store.storeId);
  });

  it('never goes above 0 across two lines sharing one debt', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 2);
    const a = await checkout(store.storeId, [{ productId: p.id, quantity: 5 }]); // → −3
    const b = await checkout(store.storeId, [{ productId: p.id, quantity: 4 }]); // → −7
    expect(await stock(p.id)).toBe(-7);

    await cancel(store.storeId, store.ownerId, a.backorders[0].id);
    expect(await stock(p.id)).toBe(-2); // 5 units back, still in debt
    await cancel(store.storeId, store.ownerId, b.backorders[0].id);
    expect(await stock(p.id)).toBe(0); // 4 units, but only 2 of debt left
    expect((await healRows(p.id)).map(r => r.quantity)).toEqual([5, 2]);
  });

  it('a product that is not negative gets nothing — no phantom units, no ledger row', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 0);
    const { backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 3 }]);
    // The merchant counted stock back up before the cancel.
    await withRlsBypass(tx => tx.product.update({ where: { id: p.id }, data: { inventory: 4 } }));

    await cancel(store.storeId, store.ownerId, backorders[0].id);

    expect(await stock(p.id)).toBe(4);
    expect(await healRows(p.id)).toHaveLength(0);
    expect(invalidateStoreProductCaches).not.toHaveBeenCalled();
  });

  it('an untracked product is never healed', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 0);
    const { backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 3 }]);
    expect(await stock(p.id)).toBe(-3);
    await withRlsBypass(tx =>
      tx.product.update({ where: { id: p.id }, data: { trackInventory: false } })
    );
    await cancel(store.storeId, store.ownerId, backorders[0].id);
    expect(await stock(p.id)).toBe(-3);
    expect(await healRows(p.id)).toHaveLength(0);
  });

  it('is idempotent: a second cancel of the same line is a 404 and heals nothing more', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 0);
    const { backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 3 }]);
    await cancel(store.storeId, store.ownerId, backorders[0].id);
    expect(await stock(p.id)).toBe(0);

    await expect(cancel(store.storeId, store.ownerId, backorders[0].id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await stock(p.id)).toBe(0);
    expect(await healRows(p.id)).toHaveLength(1);
  });

  it('a partly-fulfilled line heals at most its unfulfilled units', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 0);
    const { backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 5 }]);
    expect(await stock(p.id)).toBe(-5);
    await withRlsBypass(tx =>
      tx.backorderLine.update({ where: { id: backorders[0].id }, data: { qtyFulfilled: 2 } })
    );
    await cancel(store.storeId, store.ownerId, backorders[0].id);
    expect(await stock(p.id)).toBe(-2);
    expect((await healRows(p.id))[0].quantity).toBe(3);
  });

  it('a later whole-order cancel does not restore the healed units a second time', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 2);
    const { order, backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 5 }]);
    await cancel(store.storeId, store.ownerId, backorders[0].id);
    expect(await stock(p.id)).toBe(0);

    // Whole-order restore: puts back what checkout took (5) minus what the
    // line cancel already healed (3) → the 2 that were really on hand.
    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub);
    expect(await stock(p.id)).toBe(2);
  });

  it('variant line: checkout floors the variant at 0, so the cancel heals nothing', async () => {
    const store = await backorderStore();
    const suffix = uid();
    const vp = await withRlsBypass(tx =>
      tx.product.create({
        data: {
          storeId: store.storeId,
          name: `heal-variant-${suffix}`,
          slug: `heal-variant-${suffix}`,
          price: 1000,
          inventory: 0,
          hasVariants: true,
          status: 'active',
          variants: {
            create: [{ title: 'Only', price: 1000, inventory: 2, allowBackorder: true }],
          },
        },
        include: { variants: true },
      })
    );
    const variant = vp.variants[0];
    const { backorders } = await checkout(store.storeId, [
      { productId: vp.id, variantId: variant.id, quantity: 5 },
    ]);
    const variantStock = async () =>
      (
        await withRlsBypass(tx =>
          tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } })
        )
      ).inventory;
    expect(backorders).toHaveLength(1);
    expect(await variantStock()).toBe(0); // floored — no debt was ever written

    await cancel(store.storeId, store.ownerId, backorders[0].id);

    expect(await variantStock()).toBe(0);
    expect(await stock(vp.id)).toBe(0); // parent column untouched
    expect(await healRows(vp.id)).toHaveLength(0);
    expect(invalidateStoreProductCaches).not.toHaveBeenCalled();
  });
});

/** Draft + receive a PO for `productId`, outside any request (like Inngest). */
async function receivePo(storeId: string, productId: string, qty: number) {
  await seedCoaForStore(storeId);
  const sup = await createSupplier({ storeId, name: `heal-supplier-${uid()}` });
  const po = await createPurchaseOrder({
    storeId,
    supplierId: sup.id,
    items: [{ productId, qty, unitCost: 400 }],
  });
  return receivePurchaseOrder({
    storeId,
    poId: po.id,
    receipts: [{ poItemId: po.items[0].id, qtyReceived: qty }],
  });
}

describe.skipIf(!hasDb)('issue 2299 — the other two backorder stock paths', () => {
  it('(a) a PO receipt that fulfils a backorder heals the debt up to 0', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 2);
    const { backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 5 }]);
    expect(await stock(p.id)).toBe(-3);

    const res = await receivePo(store.storeId, p.id, 5);

    expect(res.clearedBackorders.map(c => c.qty)).toEqual([5]);
    expect(await stock(p.id)).toBe(0); // was −3 forever
    const rows = await healRows(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      quantity: 3,
      previousStock: -3,
      newStock: 0,
      reference: `po-backorder:${backorders[0].id}`,
    });
  });

  it('(a) a PO receipt larger than the backlog heals to 0, then adds only the remainder', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 0);
    await checkout(store.storeId, [{ productId: p.id, quantity: 4 }]); // → −4
    await receivePo(store.storeId, p.id, 7); // 4 clear the backorder, 3 go on the shelf
    expect(await stock(p.id)).toBe(3);
  });

  it('(b) a whole-order cancel of a variant backorder returns only what checkout took', async () => {
    const store = await backorderStore();
    const suffix = uid();
    const vp = await withRlsBypass(tx =>
      tx.product.create({
        data: {
          storeId: store.storeId,
          name: `heal-v2299-${suffix}`,
          slug: `heal-v2299-${suffix}`,
          price: 1000,
          inventory: 0,
          hasVariants: true,
          status: 'active',
          variants: {
            create: [{ title: 'Only', price: 1000, inventory: 2, allowBackorder: true }],
          },
        },
        include: { variants: true },
      })
    );
    const variant = vp.variants[0];
    const { order, backorders } = await checkout(store.storeId, [
      { productId: vp.id, variantId: variant.id, quantity: 5 },
    ]);
    const variantStock = async () =>
      (
        await withRlsBypass(tx =>
          tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } })
        )
      ).inventory;
    expect(await variantStock()).toBe(0);
    expect(backorders[0].stockTaken).toBe(2); // took 2, 3 never existed
    // The sale's ledger row records the real movement: 2 → 0, not 5 → 0.
    const sale = await withRlsBypass(tx =>
      tx.inventoryHistory.findFirstOrThrow({ where: { productId: vp.id, type: 'sale' } })
    );
    expect(sale).toMatchObject({ previousStock: 2, newStock: 0 });

    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub);

    expect(await variantStock()).toBe(2); // was 5: three phantom units
  });

  // issue 2316 — PO-fulfilled units went to the customer without touching
  // the variant row, so on a whole-order cancel they come back and are real.
  it('(b) a variant backorder PO-fulfilled then cancelled restores every unit', async () => {
    const store = await backorderStore();
    const suffix = uid();
    const vp = await withRlsBypass(tx =>
      tx.product.create({
        data: {
          storeId: store.storeId,
          name: `heal-v2316-${suffix}`,
          slug: `heal-v2316-${suffix}`,
          price: 1000,
          inventory: 0,
          hasVariants: true,
          status: 'active',
          variants: {
            create: [{ title: 'Only', price: 1000, inventory: 2, allowBackorder: true }],
          },
        },
        include: { variants: true },
      })
    );
    const variant = vp.variants[0];
    const { order, backorders } = await checkout(store.storeId, [
      { productId: vp.id, variantId: variant.id, quantity: 5 },
    ]);
    expect(backorders[0].stockTaken).toBe(2);
    // The PO receipt fulfils the whole line: those units ship to the customer.
    await withRlsBypass(tx =>
      tx.backorderLine.update({
        where: { id: backorders[0].id },
        data: { qtyFulfilled: 5, fulfilledAt: new Date() },
      })
    );
    const variantStock = async () =>
      (
        await withRlsBypass(tx =>
          tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } })
        )
      ).inventory;
    expect(await variantStock()).toBe(0);

    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub);

    expect(await variantStock()).toBe(5); // was 2: three real units lost
  });

  it('(b) a non-variant whole-order cancel still returns everything checkout took', async () => {
    const store = await backorderStore();
    const p = await simpleProduct(store.storeId, 2);
    const { order, backorders } = await checkout(store.storeId, [{ productId: p.id, quantity: 5 }]);
    expect(backorders[0].stockTaken).toBe(5);
    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub);
    expect(await stock(p.id)).toBe(2);
  });
});

// issue 2302 — a PARTIAL return releases the returned item's open backorder
// line; that release must heal the line's debt the same way a merchant's
// single-line cancel does, or the product reads out of stock forever.
describe.skipIf(!hasDb)(
  'issue 2302 — a partial return releasing a backorder heals its debt',
  () => {
    it('heals the released line to 0 and a later whole-order cancel does not double it', async () => {
      const store = await backorderStore();
      const p = await simpleProduct(store.storeId, 2);
      const { order, backorders } = await checkout(store.storeId, [
        { productId: p.id, quantity: 5 },
      ]);
      expect(await stock(p.id)).toBe(-3);
      const orderItemId = backorders[0].orderItemId;

      // Return 2 of the 5: restores the 2 returned units (→ −1), releases the
      // line's open demand, and heals the remaining −1 of debt (→ 0).
      await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, {
        items: [{ orderItemId, quantity: 2 }],
        refundKey: `ret-${uid()}`,
      });
      expect(await stock(p.id)).toBe(0);
      const line = await withRlsBypass(tx =>
        tx.backorderLine.findUniqueOrThrow({ where: { id: backorders[0].id } })
      );
      expect(line.cancelledAt).not.toBeNull();
      const heal = (await healRows(p.id)).find(r => r.reference === `backorder:${line.id}`);
      expect(heal).toMatchObject({ quantity: 1, previousStock: -1, newStock: 0 });

      // Whole-order cancel afterwards: 5 taken − 2 already returned − 1 healed.
      await handleOrderRefunded(order.id, store.storeId, true, false, stepStub);
      expect(await stock(p.id)).toBe(2);
    });

    it('is idempotent: a redelivered partial event heals nothing more', async () => {
      const store = await backorderStore();
      const p = await simpleProduct(store.storeId, 2);
      const { order, backorders } = await checkout(store.storeId, [
        { productId: p.id, quantity: 5 },
      ]);
      const partial = {
        items: [{ orderItemId: backorders[0].orderItemId, quantity: 2 }],
        refundKey: `ret-${uid()}`,
      };
      await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, partial);
      await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, partial);
      expect(await stock(p.id)).toBe(0);
    });
  }
);
