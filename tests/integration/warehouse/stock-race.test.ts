/**
 * WarehouseService.adjustStock — lost-update race under concurrency.
 *
 * Before the fix, `adjustStock` did an ungguarded `findFirst → update/create`
 * read-modify-write with no row lock and no transaction: N concurrent admin
 * edits to the same (warehouseId, productId, variantId) row each read the
 * same starting quantity and clobber each other's write, so the final
 * quantity ends up LOWER than the sum of all deltas (a classic lost update).
 *
 * This test seeds a WarehouseStock row at quantity 100, fires 20 concurrent
 * `adjustStock(delta: +1)` calls, and asserts the final quantity is exactly
 * 120 — proving no delta was lost. A second case mixes +/- deltas.
 *
 * Real DB required (docker ephemeral Postgres per task brief). Self-contained:
 * creates its own owner/store/product/warehouse and cleans up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { WarehouseService } from '../../../apps/api/src/services/warehouse.service';

describe('WarehouseService.adjustStock — lost-update race', () => {
  let storeId: string;
  let userId: string;
  let warehouseId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `wh-race-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'WH',
        lastName: 'Race',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Warehouse Race Test Store',
        slug: `wh-race-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    storeId = store.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Race WH',
        code: `RACE-${Date.now()}`,
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

  async function makeProduct(tag: string): Promise<string> {
    const p = await prisma.product.create({
      data: {
        storeId,
        name: 'Race SKU',
        slug: `wh-race-sku-${tag}-${Date.now()}`,
        price: 5000,
        inventory: 0,
        status: 'active',
        trackInventory: true,
      },
    });
    return p.id;
  }

  it('quantity=100, 20 concurrent +1 adjustments → exactly 120 (no lost update)', async () => {
    const productId = await makeProduct('plus');

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 100, storeId },
    });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        WarehouseService.adjustStock(storeId, warehouseId, { productId, delta: 1 })
      )
    );

    const row = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(row?.quantity).toBe(120);

    // Aggregate must reflect the same value (Product.inventory synced from WarehouseStock)
    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(120);
  });

  it('quantity=100, mixed +/- concurrent deltas → lands on the exact net sum', async () => {
    const productId = await makeProduct('mixed');

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 100, storeId },
    });

    // 15 x +2 (+30), 10 x -3 (-30) → net 0 change from 100 → 100
    const deltas = [
      ...Array.from({ length: 15 }, () => 2),
      ...Array.from({ length: 10 }, () => -3),
    ];

    await Promise.all(
      deltas.map(delta => WarehouseService.adjustStock(storeId, warehouseId, { productId, delta }))
    );

    const row = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(row?.quantity).toBe(100);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(100);
  });

  it('variant stock (non-null variantId): quantity=50, 20 concurrent +1 adjustments → exactly 70', async () => {
    // Exercises the ON CONFLICT (warehouse_id, product_id, variant_id) branch
    // (the composite unique constraint) — the mixed/plus cases above only
    // exercise the partial-index branch for variantId=null.
    const productId = await makeProduct('variant');
    const variant = await prisma.productVariant.create({
      data: {
        productId,
        title: 'V1',
        sku: `wh-race-variant-${Date.now()}`,
        price: 5000,
        inventory: 0,
      },
    });

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: variant.id, quantity: 50, storeId },
    });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        WarehouseService.adjustStock(storeId, warehouseId, {
          productId,
          variantId: variant.id,
          delta: 1,
        })
      )
    );

    const row = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: variant.id },
    });
    expect(row?.quantity).toBe(70);

    const updatedVariant = await prisma.productVariant.findUnique({ where: { id: variant.id } });
    expect(updatedVariant?.inventory).toBe(70);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(70);
  });

  it('cross-warehouse: 2 warehouses concurrently adjusting the SAME product → aggregate == exact SUM', async () => {
    // Regression test for the aggregate-race that survives the per-row upsert
    // fix: warehouse A and warehouse B write DIFFERENT warehouse_stock rows
    // (different warehouseId), so they never collide on the per-row ON
    // CONFLICT upsert. The old `syncAggregateInventory` recomputed
    // `products.inventory` via a single `UPDATE … SET inventory = (SELECT
    // SUM… ) WHERE id = productId` statement. Under READ COMMITTED, when this
    // UPDATE blocks on the `products` row lock and later unblocks via
    // EvalPlanQual, only the WHERE-clause row (products) is re-checked
    // against the latest committed version — the correlated subquery's scan
    // of the DIFFERENT table (`warehouse_stock`) still uses the original
    // per-statement snapshot taken before the block (see Postgres docs,
    // "Read Committed Isolation Level": the second updater "does not see
    // effects of [concurrent] commands on any other rows in the database").
    // So two concurrent syncs for the same product can each recompute SUM
    // from a stale warehouse_stock snapshot and the later commit silently
    // discards the other warehouse's contribution — a lost update in the
    // aggregate despite every individual warehouse_stock row being correct.
    const productId = await makeProduct('cross-warehouse');

    const warehouseB = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Race WH B',
        code: `RACE-B-${Date.now()}`,
        isDefault: false,
        priority: 50,
        isActive: true,
      },
    });

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 100, storeId },
    });
    await prisma.warehouseStock.create({
      data: { warehouseId: warehouseB.id, productId, variantId: null, quantity: 100, storeId },
    });

    // 10 concurrent +1s to warehouse A, 10 concurrent +1s to warehouse B —
    // interleaved via Promise.all so both sets race against each other.
    const writes = [
      ...Array.from({ length: 10 }, () =>
        WarehouseService.adjustStock(storeId, warehouseId, { productId, delta: 1 })
      ),
      ...Array.from({ length: 10 }, () =>
        WarehouseService.adjustStock(storeId, warehouseB.id, { productId, delta: 1 })
      ),
    ];
    await Promise.all(writes);

    const rows = await prisma.warehouseStock.findMany({
      where: { productId, variantId: null },
    });
    const sumOfRows = rows.reduce((sum, r) => sum + r.quantity, 0);
    expect(sumOfRows).toBe(220); // 100 + 100 + 10 + 10, per-row upsert was never racy

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(sumOfRows);
    expect(product?.inventory).toBe(220);
  });

  it('cross-variant rollup: 2 variants of the SAME product concurrently adjusted → product.inventory == exact SUM', async () => {
    // Same hazard, one level up: two DIFFERENT variants of the SAME product
    // never collide on their own warehouse_stock/product_variants rows, but
    // both race to roll up into `products.inventory` via the variant→product
    // SUM-update. Proves the parent-rollup UPDATE is subject to the identical
    // stale-subquery-snapshot hazard as the base-product path above.
    const productId = await makeProduct('cross-variant');
    const variantA = await prisma.productVariant.create({
      data: { productId, title: 'VA', sku: `wh-race-va-${Date.now()}`, price: 5000, inventory: 0 },
    });
    const variantB = await prisma.productVariant.create({
      data: { productId, title: 'VB', sku: `wh-race-vb-${Date.now()}`, price: 5000, inventory: 0 },
    });

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: variantA.id, quantity: 50, storeId },
    });
    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: variantB.id, quantity: 50, storeId },
    });

    const writes = [
      ...Array.from({ length: 10 }, () =>
        WarehouseService.adjustStock(storeId, warehouseId, {
          productId,
          variantId: variantA.id,
          delta: 1,
        })
      ),
      ...Array.from({ length: 10 }, () =>
        WarehouseService.adjustStock(storeId, warehouseId, {
          productId,
          variantId: variantB.id,
          delta: 1,
        })
      ),
    ];
    await Promise.all(writes);

    const updatedA = await prisma.productVariant.findUnique({ where: { id: variantA.id } });
    const updatedB = await prisma.productVariant.findUnique({ where: { id: variantB.id } });
    expect(updatedA?.inventory).toBe(60);
    expect(updatedB?.inventory).toBe(60);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(120); // 60 + 60, exact rollup
  });
});
