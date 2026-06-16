/**
 * Warehouse CRUD + Stock Integration Tests
 *
 * Requires a real Postgres DB (DATABASE_URL env var).
 * CI provides it via the postgres service container.
 *
 * Isolation: creates its own store/user with a unique timestamp suffix
 * and cleans up in afterAll. Uses TRUNCATE ... RESTART IDENTITY CASCADE
 * on the warehouse_stock and warehouses tables after the test run
 * (only for rows created in this test's store) to avoid polluting
 * other test runs.
 *
 * Tests:
 *  1. Create warehouse → appears in list
 *  2. Update warehouse → changes reflected
 *  3. Set stock for a product → warehouse_stock row created, aggregate synced
 *  4. Adjust stock (delta) → quantity changes, InventoryHistory row created
 *  5. Deactivate non-default warehouse → disappears from list
 *  6. Cannot deactivate last active warehouse
 *  7. Set-as-default clears previous default
 *  8. Stock list for a warehouse → returns correct rows
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, withRlsBypass } from '@force/database';
import { WarehouseService } from '@api/services/warehouse.service';

// ─── Test isolation owner ──────────────────────────────────────────────────────

const OWNER_ID = '00000000-0000-0000-0000-000000000099'; // unused by other suites
let storeId: string;
let productId: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await withRlsBypass(async tx => {
    // Upsert owner
    await tx.user.upsert({
      where: { id: OWNER_ID },
      update: {},
      create: {
        id: OWNER_ID,
        email: `wh-test-${Date.now()}@x.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'WH',
        lastName: 'Test',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });

    // Create store
    const store = await tx.store.create({
      data: {
        name: `Warehouse Test Store ${Date.now()}`,
        slug: `wh-test-${Date.now()}`,
        ownerId: OWNER_ID,
        status: 'active',
      },
    });
    storeId = store.id;

    // Create a product to use for stock tests
    const product = await tx.product.create({
      data: {
        storeId,
        name: 'Warehouse Test Product',
        slug: `wh-prod-${Date.now()}`,
        price: 5000,
        inventory: 0,
        status: 'active',
        trackInventory: true,
      },
    });
    productId = product.id;
  });
});

// ─── Teardown ─────────────────────────────────────────────────────────────────

afterAll(async () => {
  await withRlsBypass(async tx => {
    await tx.warehouseStock.deleteMany({ where: { storeId } });
    await tx.warehouse.deleteMany({ where: { storeId } });
    await tx.inventoryHistory.deleteMany({ where: { storeId } });
    await tx.product.deleteMany({ where: { storeId } });
    await tx.store.delete({ where: { id: storeId } }).catch(() => {});
    await tx.user.delete({ where: { id: OWNER_ID } }).catch(() => {});
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WarehouseService — CRUD', () => {
  let mainWarehouseId: string;
  let secondWarehouseId: string;

  it('creates a warehouse and it appears in the list', async () => {
    await withRlsBypass(async () => {
      const wh = await WarehouseService.createWarehouse(storeId, {
        name: 'Main Warehouse',
        nameAr: 'المستودع الرئيسي',
        code: 'MAIN',
        isDefault: true,
        priority: 100,
      });

      mainWarehouseId = wh.id;

      expect(wh.name).toBe('Main Warehouse');
      expect(wh.code).toBe('MAIN');
      expect(wh.isDefault).toBe(true);
      expect(wh.priority).toBe(100);
    });

    const list = await withRlsBypass(() => WarehouseService.listWarehouses(storeId));
    expect(list.some(w => w.id === mainWarehouseId)).toBe(true);
  });

  it('creates a second warehouse', async () => {
    const wh = await withRlsBypass(() =>
      WarehouseService.createWarehouse(storeId, {
        name: 'South Branch',
        code: 'SOUTH',
        isDefault: false,
        priority: 50,
      })
    );

    secondWarehouseId = wh.id;
    expect(wh.isDefault).toBe(false);
  });

  it('updates warehouse name and priority', async () => {
    const updated = await withRlsBypass(() =>
      WarehouseService.updateWarehouse(storeId, mainWarehouseId, {
        name: 'Main Warehouse (Updated)',
        priority: 200,
      })
    );

    expect(updated.name).toBe('Main Warehouse (Updated)');
    expect(updated.priority).toBe(200);
  });

  it('setting second warehouse as default clears the first', async () => {
    await withRlsBypass(() =>
      WarehouseService.updateWarehouse(storeId, secondWarehouseId, { isDefault: true })
    );

    const list = await withRlsBypass(() => WarehouseService.listWarehouses(storeId));
    const main = list.find(w => w.id === mainWarehouseId);
    const south = list.find(w => w.id === secondWarehouseId);

    expect(main?.isDefault).toBe(false);
    expect(south?.isDefault).toBe(true);

    // Restore MAIN as default for subsequent tests
    await withRlsBypass(() =>
      WarehouseService.updateWarehouse(storeId, mainWarehouseId, { isDefault: true })
    );
  });

  it('rejects duplicate code within same store', async () => {
    await expect(
      withRlsBypass(() =>
        WarehouseService.createWarehouse(storeId, {
          name: 'Duplicate',
          code: 'MAIN', // already exists
          priority: 0,
        })
      )
    ).rejects.toMatchObject({ code: 'WAREHOUSE_CODE_EXISTS' });
  });

  it('blocks deactivating the last active warehouse', async () => {
    // Deactivate SOUTH first so MAIN is the only one left
    await withRlsBypass(() => WarehouseService.deactivateWarehouse(storeId, secondWarehouseId));

    await expect(
      withRlsBypass(() => WarehouseService.deactivateWarehouse(storeId, mainWarehouseId))
    ).rejects.toMatchObject({ code: 'WAREHOUSE_LAST_ACTIVE' });

    // Re-activate SOUTH (update isActive=true) for subsequent tests
    await withRlsBypass(() =>
      WarehouseService.updateWarehouse(storeId, secondWarehouseId, { isActive: true })
    );
  });

  it('deactivates a non-default warehouse successfully', async () => {
    await withRlsBypass(() => WarehouseService.deactivateWarehouse(storeId, secondWarehouseId));

    const list = await withRlsBypass(() => WarehouseService.listWarehouses(storeId));
    expect(list.some(w => w.id === secondWarehouseId)).toBe(false); // isActive=false → not in list
  });
});

describe('WarehouseService — stock operations', () => {
  let warehouseId: string;

  beforeAll(async () => {
    // Create a fresh warehouse for stock tests
    const wh = await withRlsBypass(() =>
      WarehouseService.createWarehouse(storeId, {
        name: 'Stock Test WH',
        code: 'STK',
        isDefault: false,
        priority: 10,
      })
    );
    warehouseId = wh.id;
  });

  it('sets stock for a product and syncs the aggregate', async () => {
    await withRlsBypass(() =>
      WarehouseService.setStock(storeId, warehouseId, {
        productId,
        variantId: null,
        quantity: 42,
      })
    );

    // Check warehouse_stock row
    const stockRow = await withRlsBypass(() =>
      prisma.warehouseStock.findFirst({
        where: { warehouseId, productId, variantId: null },
      })
    );
    expect(stockRow?.quantity).toBe(42);

    // Check aggregate (Product.inventory)
    const product = await withRlsBypass(() =>
      prisma.product.findUnique({ where: { id: productId } })
    );
    expect(product?.inventory).toBe(42);
  });

  it('upserts stock (overwrites previous quantity)', async () => {
    await withRlsBypass(() =>
      WarehouseService.setStock(storeId, warehouseId, {
        productId,
        quantity: 30,
      })
    );

    const stockRow = await withRlsBypass(() =>
      prisma.warehouseStock.findFirst({
        where: { warehouseId, productId, variantId: null },
      })
    );
    expect(stockRow?.quantity).toBe(30);
  });

  it('adjusts stock by positive delta, creates InventoryHistory', async () => {
    const result = await withRlsBypass(() =>
      WarehouseService.adjustStock(storeId, warehouseId, {
        productId,
        delta: 10,
        reason: 'restock',
      })
    );

    expect(result.newQuantity).toBe(40); // 30 + 10

    const history = await withRlsBypass(() =>
      prisma.inventoryHistory.findFirst({
        where: { productId, storeId, reference: warehouseId },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(history).not.toBeNull();
    expect(history?.quantity).toBe(10);
    expect(history?.previousStock).toBe(30);
    expect(history?.newStock).toBe(40);
  });

  it('adjusts stock by negative delta, floors at 0', async () => {
    // Current: 40. Request: -100. Should floor at 0.
    const result = await withRlsBypass(() =>
      WarehouseService.adjustStock(storeId, warehouseId, {
        productId,
        delta: -100,
      })
    );

    expect(result.newQuantity).toBe(0);

    const stockRow = await withRlsBypass(() =>
      prisma.warehouseStock.findFirst({
        where: { warehouseId, productId, variantId: null },
      })
    );
    expect(stockRow?.quantity).toBe(0);
  });

  it('lists stock rows for a warehouse', async () => {
    // Restore some stock first
    await withRlsBypass(() =>
      WarehouseService.setStock(storeId, warehouseId, { productId, quantity: 15 })
    );

    const { rows, total } = await withRlsBypass(() =>
      WarehouseService.listWarehouseStock(storeId, warehouseId)
    );

    expect(total).toBeGreaterThanOrEqual(1);
    const row = rows.find(r => r.productId === productId);
    expect(row).toBeDefined();
    expect(row?.quantity).toBe(15);
  });

  it('gets cross-warehouse product stock breakdown', async () => {
    const breakdown = await withRlsBypass(() =>
      WarehouseService.getProductStock(storeId, productId)
    );

    expect(breakdown.length).toBeGreaterThanOrEqual(1);
    const entry = breakdown.find(b => b.warehouseId === warehouseId);
    expect(entry).toBeDefined();
    expect(entry?.quantity).toBe(15);
  });
});
