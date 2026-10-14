/**
 * Task 3: reconcile wired into the admin direct-writers of Product.inventory.
 *
 * THE DRIFT: `InventoryService.adjustInventory` / `setInventory`
 * (apps/api/src/services/inventory.service.ts) and
 * `StockAdjustment.postAdjustment`
 * (apps/api/src/services/accounting/stock-adjustment.service.ts) mutate
 * `Product.inventory` / `ProductVariant.inventory` directly, without ever
 * touching `WarehouseStock` — so a store with a warehouse drifts:
 * `SUM(WarehouseStock) != Product.inventory` after these calls. This suite
 * proves each writer now calls `WarehouseService.reconcileWarehouseStockToAggregate`
 * for its own affected SKU(s) so the invariant holds afterward, and that a
 * store with NO warehouses is unaffected (no-op, no error).
 *
 * Real DB required (docker ephemeral Postgres per task-1-report.md's
 * recipe). Self-contained: creates its own owner/store/products/warehouses
 * and cleans up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { InventoryService } from '../../../apps/api/src/services/inventory.service';
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

describe('Task 3: reconcile wired into admin direct-writers', () => {
  describe('store WITH a warehouse', () => {
    let storeId: string;
    let userId: string;
    let warehouseId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `admin-writers-wh-${Date.now()}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Admin',
          lastName: 'Writers',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      userId = user.id;

      const store = await prisma.store.create({
        data: {
          name: 'Admin Writers Reconcile Store',
          slug: `admin-writers-store-${Date.now()}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      storeId = store.id;

      const warehouse = await prisma.warehouse.create({
        data: {
          storeId,
          name: 'Admin Writers WH',
          code: `ADMWH-${Date.now()}`,
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
      await prisma.stockAdjustmentItem.deleteMany({ where: { adjustment: { storeId } } });
      await prisma.stockAdjustment.deleteMany({ where: { storeId } });
      await prisma.warehouse.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    async function makeProduct(tag: string, inventory: number): Promise<string> {
      const p = await prisma.product.create({
        data: {
          storeId,
          name: 'Admin Writers SKU',
          slug: `admin-writers-sku-${tag}-${Date.now()}`,
          price: 5000,
          inventory,
          status: 'active',
          trackInventory: true,
        },
      });
      return p.id;
    }

    it('adjustInventory: SUM(WarehouseStock) == Product.inventory afterward', async () => {
      const productId = await makeProduct('adjust', 10);
      await prisma.warehouseStock.create({
        data: { warehouseId, productId, variantId: null, quantity: 10, storeId },
      });

      await InventoryService.adjustInventory(storeId, {
        productId,
        quantity: -4,
        type: 'adjustment',
      });

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(6);

      const sum = await sumWarehouseStock(productId, null);
      expect(sum).toBe(product?.inventory);
    });

    it('setInventory: SUM(WarehouseStock) == Product.inventory afterward', async () => {
      const productId = await makeProduct('set', 10);
      await prisma.warehouseStock.create({
        data: { warehouseId, productId, variantId: null, quantity: 10, storeId },
      });

      await InventoryService.setInventory(storeId, productId, 25);

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(25);

      const sum = await sumWarehouseStock(productId, null);
      expect(sum).toBe(product?.inventory);
    });

    it('postAdjustment: invariant holds afterward, and the adjustment still commits/posts successfully', async () => {
      const productId = await makeProduct('post', 10);
      await prisma.warehouseStock.create({
        data: { warehouseId, productId, variantId: null, quantity: 10, storeId },
      });

      const draft = await createAdjustment({
        storeId,
        type: 'cycle_count',
        reason: 'Task 3 reconcile test',
        items: [{ productId, newQty: 3 }],
      });

      const posted = await postAdjustment(storeId, draft.id, userId);

      // Adjustment commits and posts independently of reconcile — this is
      // the core "best-effort" contract: even if reconcile were to fail,
      // the accounting post above must already have succeeded.
      expect(posted.status).toBe('posted');

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(3);

      const sum = await sumWarehouseStock(productId, null);
      expect(sum).toBe(product?.inventory);
    });
  });

  describe('store with NO warehouses', () => {
    let storeId: string;
    let userId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `admin-writers-nowh-${Date.now()}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'NoWh',
          lastName: 'Writers',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      userId = user.id;

      const store = await prisma.store.create({
        data: {
          name: 'No Warehouse Admin Writers Store',
          slug: `admin-writers-nowh-store-${Date.now()}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      storeId = store.id;
    });

    afterAll(async () => {
      await prisma.inventoryHistory.deleteMany({ where: { storeId } });
      await prisma.stockAdjustmentItem.deleteMany({ where: { adjustment: { storeId } } });
      await prisma.stockAdjustment.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    async function makeProduct(tag: string, inventory: number): Promise<string> {
      const p = await prisma.product.create({
        data: {
          storeId,
          name: 'No WH SKU',
          slug: `admin-writers-nowh-sku-${tag}-${Date.now()}`,
          price: 5000,
          inventory,
          status: 'active',
          trackInventory: true,
        },
      });
      return p.id;
    }

    it('adjustInventory: no warehouse rows exist, no error, aggregate still updates', async () => {
      const productId = await makeProduct('adjust', 10);

      await InventoryService.adjustInventory(storeId, {
        productId,
        quantity: -3,
        type: 'adjustment',
      });

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(7);

      const stockCount = await prisma.warehouseStock.count({ where: { productId } });
      expect(stockCount).toBe(0);
    });

    it('setInventory: no warehouse rows exist, no error, aggregate still updates', async () => {
      const productId = await makeProduct('set', 10);

      await InventoryService.setInventory(storeId, productId, 40);

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(40);

      const stockCount = await prisma.warehouseStock.count({ where: { productId } });
      expect(stockCount).toBe(0);
    });

    it('postAdjustment: no warehouse rows exist, adjustment still posts, no error', async () => {
      const productId = await makeProduct('post', 10);

      const draft = await createAdjustment({
        storeId,
        type: 'cycle_count',
        reason: 'Task 3 reconcile test (no warehouse)',
        items: [{ productId, newQty: 6 }],
      });

      const posted = await postAdjustment(storeId, draft.id, userId);
      expect(posted.status).toBe('posted');

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.inventory).toBe(6);

      const stockCount = await prisma.warehouseStock.count({ where: { productId } });
      expect(stockCount).toBe(0);
    });
  });
});
