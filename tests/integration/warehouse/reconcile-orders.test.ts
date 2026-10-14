/**
 * Task 4 — async reconcile: order fanout (sales/refunds) + daily
 * completeness SWEEP. THE ORDER MONEY/DECREMENT PATH IS NOT MODIFIED.
 *
 * Four things this suite proves against a real ephemeral Postgres:
 *
 * 1. **Sweep covers an un-hooked writer** (the key completeness proof) —
 *    `InventoryService.bulkAdjustInventory` is a real Product.inventory
 *    writer that was NEVER hooked to reconcile (Task 3 only wired
 *    adjustInventory/setInventory/postAdjustment). Drifting a SKU through it
 *    and then running `WarehouseService.backfillReconcileAll` (the exact
 *    per-store work the sweep cron calls) restores the invariant — this is
 *    what makes the sweep the CLASS-fix rather than another one-off hook.
 *
 * 2. **Order refund reconcile** — the `order-refunded` fanout's new
 *    `reconcile-warehouse-stock` step (added right after `restore-inventory`)
 *    reconciles every SKU the order touched, using the real exported
 *    `handleOrderRefunded` function against a real DB.
 *
 * 3. **Order sale reconcile relies on the sweep, not the fanout** —
 *    documented decision (see task-4-report.md): `order-created.ts` is a
 *    pure notification fanout with no inventory-touching step, and the
 *    checkout decrement is synchronous, not itself part of any fanout. A
 *    post-sale drift (simulated here exactly like the un-hooked-writer case)
 *    is reconciled by the same daily sweep.
 *
 * 4. **Best-effort (Task 4C)** — `StockAdjustment.postAdjustment` still
 *    returns `status: 'posted'` even when
 *    `WarehouseService.reconcileWarehouseStockToAggregate` throws (stubbed to
 *    reject) — reconcile failure must never roll back or fail the posted
 *    adjustment.
 *
 * Real DB required (docker ephemeral Postgres per task-1-report.md's
 * recipe). Self-contained: creates its own owner/store/products/warehouses
 * and cleans up in afterAll per describe block.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma } from '@ebda/database';
import { InventoryService } from '../../../apps/api/src/services/inventory.service';
import { WarehouseService } from '../../../apps/api/src/services/warehouse.service';
import { handleOrderRefunded } from '../../../apps/api/src/lib/inngest/functions/order-refunded';
import {
  postAdjustment,
  createAdjustment,
} from '../../../apps/api/src/services/accounting/stock-adjustment.service';

async function sumWarehouseStock(productId: string, variantId: string | null): Promise<number> {
  const rows = await prisma.warehouseStock.findMany({
    where: { productId, variantId },
    select: { quantity: true },
  });
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

describe('Task 4: order fanout reconcile + daily completeness sweep', () => {
  describe('sweep covers an un-hooked writer (bulkAdjustInventory)', () => {
    let storeId: string;
    let userId: string;
    let warehouseId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `t4-sweep-unhooked-${Date.now()}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Sweep',
          lastName: 'Unhooked',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      userId = user.id;

      const store = await prisma.store.create({
        data: {
          name: 'Sweep Unhooked Store',
          slug: `t4-sweep-unhooked-store-${Date.now()}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      storeId = store.id;

      const warehouse = await prisma.warehouse.create({
        data: {
          storeId,
          name: 'Sweep Unhooked WH',
          code: `T4SWH-${Date.now()}`,
          isDefault: true,
          priority: 100,
          isActive: true,
        },
      });
      warehouseId = warehouse.id;
    });

    afterAll(async () => {
      await prisma.warehouseStock.deleteMany({ where: { storeId } });
      await prisma.inventoryHistory.deleteMany({ where: { storeId } });
      await prisma.warehouse.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it("bulkAdjustInventory drifts the shadow, backfillReconcileAll (the sweep's per-store work) restores it", async () => {
      const product = await prisma.product.create({
        data: {
          storeId,
          name: 'Sweep Unhooked SKU',
          slug: `t4-sweep-unhooked-sku-${Date.now()}`,
          price: 5000,
          inventory: 10,
          status: 'active',
          trackInventory: true,
        },
      });
      await prisma.warehouseStock.create({
        data: { warehouseId, productId: product.id, variantId: null, quantity: 10, storeId },
      });

      // Invariant holds before the drift.
      expect(await sumWarehouseStock(product.id, null)).toBe(10);

      // Drift via a writer that is NOT hooked to reconcile anywhere.
      const result = await InventoryService.bulkAdjustInventory(storeId, [
        { productId: product.id, quantity: -6, type: 'adjustment', reason: 'sweep test' },
      ]);
      expect(result.successful).toBe(1);

      const afterBulk = await prisma.product.findUnique({ where: { id: product.id } });
      expect(afterBulk?.inventory).toBe(4);

      // The shadow never moved — bulkAdjustInventory has no reconcile hook.
      expect(await sumWarehouseStock(product.id, null)).toBe(10);
      expect(afterBulk?.inventory).not.toBe(await sumWarehouseStock(product.id, null));

      // The sweep's per-store work is exactly backfillReconcileAll.
      const sweepResult = await WarehouseService.backfillReconcileAll(storeId);
      expect(sweepResult.skusReconciled).toBeGreaterThanOrEqual(1);
      expect(sweepResult.skusFailed).toBe(0);

      // Invariant restored, and the aggregate itself was NOT touched by reconcile.
      const afterSweep = await prisma.product.findUnique({ where: { id: product.id } });
      expect(afterSweep?.inventory).toBe(4);
      expect(await sumWarehouseStock(product.id, null)).toBe(4);
    });
  });

  describe('order refund reconcile via the order-refunded fanout', () => {
    let storeId: string;
    let userId: string;
    let warehouseId: string;
    let productId: string;
    let orderId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `t4-refund-reconcile-${Date.now()}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Refund',
          lastName: 'Reconcile',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      userId = user.id;

      const store = await prisma.store.create({
        data: {
          name: 'Refund Reconcile Store',
          slug: `t4-refund-reconcile-store-${Date.now()}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      storeId = store.id;

      const warehouse = await prisma.warehouse.create({
        data: {
          storeId,
          name: 'Refund Reconcile WH',
          code: `T4RWH-${Date.now()}`,
          isDefault: true,
          priority: 100,
          isActive: true,
        },
      });
      warehouseId = warehouse.id;

      // Seed a product with WarehouseStock == Product.inventory, matching
      // "the invariant holds" starting state a real store would have.
      const product = await prisma.product.create({
        data: {
          storeId,
          name: 'Refund Reconcile SKU',
          slug: `t4-refund-reconcile-sku-${Date.now()}`,
          price: 5000,
          inventory: 10,
          status: 'active',
          trackInventory: true,
        },
      });
      productId = product.id;
      await prisma.warehouseStock.create({
        data: { warehouseId, productId, variantId: null, quantity: 10, storeId },
      });

      // Place a guest order for qty 2 — simulates the UNTOUCHED checkout
      // decrement (order.service.ts's transaction) moving the aggregate
      // without ever touching WarehouseStock, exactly the drift class this
      // task fixes. Directly decrementing here (rather than driving the
      // full checkout route) isolates this test to the fanout's reconcile
      // step, which is this task's actual scope — the decrement transaction
      // itself is Task 1's already-proven, untouched code.
      await prisma.product.update({
        where: { id: productId },
        data: { inventory: { decrement: 2 } },
      });

      // Independently drift the shadow itself (simulating some OTHER
      // unrelated writer touching WarehouseStock directly, e.g. a warehouse
      // recount) DOWN to a value that is NOT what the post-refund aggregate
      // will coincidentally land on. Without this, restoring the aggregate
      // by +2 back to 10 would happen to match the shadow's original
      // untouched value of 10 by pure arithmetic symmetry, masking whether
      // reconcile actually ran at all. Setting the shadow to 2 here means
      // the ONLY way `SUM(WarehouseStock) == Product.inventory` (== 10)
      // holds after the refund is if the new reconcile-warehouse-stock step
      // genuinely executed.
      await prisma.warehouseStock.updateMany({
        where: { warehouseId, productId, variantId: null },
        data: { quantity: 2 },
      });

      const order = await prisma.order.create({
        data: {
          storeId,
          orderNumber: `T4-ORD-${Date.now()}`,
          status: 'pending',
          paymentStatus: 'paid',
          subtotal: 10000,
          total: 10000,
          shippingAddress: { firstName: 'Sam', lastName: 'Buyer', email: 'sam@example.test' },
          billingAddress: { firstName: 'Sam', lastName: 'Buyer', email: 'sam@example.test' },
          items: {
            create: [
              {
                productId,
                productName: 'Refund Reconcile SKU',
                quantity: 2,
                price: 5000,
                total: 10000,
              },
            ],
          },
        },
      });
      orderId = order.id;
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
      await prisma.warehouseStock.deleteMany({ where: { storeId } });
      await prisma.inventoryHistory.deleteMany({ where: { storeId } });
      await prisma.warehouse.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it('the sale drop left the shadow un-reconciled (drift exists before the refund fires)', async () => {
      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(8);
      // Shadow sits at the independently-drifted value (2), not 8 — proving
      // the invariant is genuinely broken going into the refund, not merely
      // "different by the sale's own delta".
      expect(await sumWarehouseStock(productId, null)).toBe(2);
      expect(product?.inventory).not.toBe(await sumWarehouseStock(productId, null));
    });

    it('driving the refund fanout restores the aggregate AND reconciles the shadow', async () => {
      await handleOrderRefunded(orderId, storeId, true, false, stepStub);

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(10); // restored by +2

      // The invariant now holds: reconcile-warehouse-stock ran as part of
      // the SAME fanout call, after restore-inventory committed.
      expect(await sumWarehouseStock(productId, null)).toBe(10);
    });
  });

  describe('order sale reconcile relies on the sweep (order-created.ts is unmodified)', () => {
    let storeId: string;
    let userId: string;
    let warehouseId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `t4-sale-sweep-${Date.now()}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Sale',
          lastName: 'Sweep',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      userId = user.id;

      const store = await prisma.store.create({
        data: {
          name: 'Sale Sweep Store',
          slug: `t4-sale-sweep-store-${Date.now()}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      storeId = store.id;

      const warehouse = await prisma.warehouse.create({
        data: {
          storeId,
          name: 'Sale Sweep WH',
          code: `T4SSWH-${Date.now()}`,
          isDefault: true,
          priority: 100,
          isActive: true,
        },
      });
      warehouseId = warehouse.id;
    });

    afterAll(async () => {
      await prisma.warehouseStock.deleteMany({ where: { storeId } });
      await prisma.inventoryHistory.deleteMany({ where: { storeId } });
      await prisma.warehouse.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it('a post-sale drift (aggregate decremented, shadow untouched) is reconciled by backfillReconcileAll', async () => {
      const product = await prisma.product.create({
        data: {
          storeId,
          name: 'Sale Sweep SKU',
          slug: `t4-sale-sweep-sku-${Date.now()}`,
          price: 5000,
          inventory: 10,
          status: 'active',
          trackInventory: true,
        },
      });
      await prisma.warehouseStock.create({
        data: { warehouseId, productId: product.id, variantId: null, quantity: 10, storeId },
      });

      // Simulate the checkout decrement — order.service.ts's transaction,
      // untouched by this task — dropping the aggregate by 3 without ever
      // touching WarehouseStock.
      await prisma.product.update({
        where: { id: product.id },
        data: { inventory: { decrement: 3 } },
      });
      expect(await sumWarehouseStock(product.id, null)).toBe(10); // drifted

      const sweepResult = await WarehouseService.backfillReconcileAll(storeId);
      expect(sweepResult.skusReconciled).toBeGreaterThanOrEqual(1);

      const after = await prisma.product.findUnique({ where: { id: product.id } });
      expect(after?.inventory).toBe(7);
      expect(await sumWarehouseStock(product.id, null)).toBe(7);
    });
  });

  describe('best-effort: postAdjustment stays posted even when reconcile throws (Task 4C)', () => {
    let storeId: string;
    let userId: string;
    let warehouseId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `t4-best-effort-${Date.now()}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Best',
          lastName: 'Effort',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      userId = user.id;

      const store = await prisma.store.create({
        data: {
          name: 'Best Effort Store',
          slug: `t4-best-effort-store-${Date.now()}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      storeId = store.id;

      const warehouse = await prisma.warehouse.create({
        data: {
          storeId,
          name: 'Best Effort WH',
          code: `T4BEWH-${Date.now()}`,
          isDefault: true,
          priority: 100,
          isActive: true,
        },
      });
      warehouseId = warehouse.id;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await prisma.warehouseStock.deleteMany({ where: { storeId } });
      await prisma.inventoryHistory.deleteMany({ where: { storeId } });
      await prisma.stockAdjustmentItem.deleteMany({ where: { adjustment: { storeId } } });
      await prisma.stockAdjustment.deleteMany({ where: { storeId } });
      await prisma.warehouse.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it('reconcile rejecting does not roll back or fail the already-posted adjustment', async () => {
      const product = await prisma.product.create({
        data: {
          storeId,
          name: 'Best Effort SKU',
          slug: `t4-best-effort-sku-${Date.now()}`,
          price: 5000,
          inventory: 10,
          status: 'active',
          trackInventory: true,
        },
      });
      await prisma.warehouseStock.create({
        data: { warehouseId, productId: product.id, variantId: null, quantity: 10, storeId },
      });

      const reconcileSpy = vi
        .spyOn(WarehouseService, 'reconcileWarehouseStockToAggregate')
        .mockRejectedValue(new Error('reconcile boom — simulated failure'));

      const draft = await createAdjustment({
        storeId,
        type: 'cycle_count',
        reason: 'Task 4 best-effort test',
        items: [{ productId: product.id, newQty: 3 }],
      });

      const posted = await postAdjustment(storeId, draft.id, userId);

      // The core best-effort contract: the accounting post already
      // committed (status flips to 'posted') even though every reconcile
      // call for this adjustment's items rejected.
      expect(posted.status).toBe('posted');
      expect(reconcileSpy).toHaveBeenCalled();

      const after = await prisma.product.findUnique({ where: { id: product.id } });
      expect(after?.inventory).toBe(3);

      // Shadow was NOT reconciled (reconcile failed), but the adjustment's
      // own write (Product.inventory) is unaffected/uncorrupted by the
      // failure — proving reconcile failure has zero blast radius on the
      // money-adjacent write it followed.
      expect(await sumWarehouseStock(product.id, null)).toBe(10);
    });
  });
});
