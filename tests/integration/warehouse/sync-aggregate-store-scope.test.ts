/**
 * Review M9 (search Task 11, pre-existing; Ruling WAREHOUSE-STORE-SCOPE-1): the raw SQL in
 * `WarehouseService.syncAggregateInventory` carries the store id, so a call with another store's
 * id touches 0 rows even on a role that bypasses RLS (defence in depth under R-EBDA-001, the Global
 * Constraint "every raw query that names a tenant table carries store_id"). Runs on the owner-role
 * fixture client on purpose: RLS cannot hide the defect there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { WarehouseService } from '../../../apps/api/src/services/warehouse.service';
import { hasDb } from '../../helpers/bundle-fixtures';

const run = crypto.randomUUID().slice(0, 8);

describe.skipIf(!hasDb)('syncAggregateInventory is store-scoped (review M9)', () => {
  let userId: string;
  let storeId: string;
  let otherStoreId: string;
  let warehouseId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `wh-scope-${run}@example.test`,
        passwordHash: 'x',
        firstName: 'W',
        lastName: 'S',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    userId = user.id;
    storeId = (
      await prisma.store.create({
        data: { name: 'WH scope', slug: `wh-scope-${run}`, ownerId: userId, status: 'active' },
      })
    ).id;
    otherStoreId = (
      await prisma.store.create({
        data: { name: 'WH other', slug: `wh-other-${run}`, ownerId: userId, status: 'active' },
      })
    ).id;
    warehouseId = (
      await prisma.warehouse.create({
        data: { storeId, name: 'Main', code: `SC-${run}`, isDefault: true, isActive: true },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.warehouseStock.deleteMany({ where: { storeId } });
    await prisma.warehouse.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: { in: [storeId, otherStoreId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function productWithStock(qty: number) {
    const p = await prisma.product.create({
      data: {
        storeId,
        name: 'Scoped',
        slug: `wh-scope-p-${crypto.randomUUID().slice(0, 8)}`,
        price: 100,
        inventory: 0,
        status: 'active',
        trackInventory: true,
      },
    });
    await prisma.warehouseStock.create({
      data: { storeId, warehouseId, productId: p.id, variantId: null, quantity: qty },
    });
    return p.id;
  }

  it("another store's id updates 0 rows; the product's own store id recomputes", async () => {
    const productId = await productWithStock(9);
    await prisma.$transaction(tx =>
      WarehouseService.syncAggregateInventory(otherStoreId, productId, null, tx)
    );
    expect((await prisma.product.findUnique({ where: { id: productId } }))?.inventory).toBe(0);
    await prisma.$transaction(tx =>
      WarehouseService.syncAggregateInventory(storeId, productId, null, tx)
    );
    expect((await prisma.product.findUnique({ where: { id: productId } }))?.inventory).toBe(9);
  });

  it('the variant path is scoped too', async () => {
    const productId = await productWithStock(0);
    const variant = await prisma.productVariant.create({
      data: {
        productId,
        title: 'V',
        sku: `v-${crypto.randomUUID().slice(0, 8)}`,
        price: 100,
        inventory: 0,
      },
    });
    await prisma.warehouseStock.create({
      data: { storeId, warehouseId, productId, variantId: variant.id, quantity: 4 },
    });
    await prisma.$transaction(tx =>
      WarehouseService.syncAggregateInventory(otherStoreId, productId, variant.id, tx)
    );
    expect((await prisma.productVariant.findUnique({ where: { id: variant.id } }))?.inventory).toBe(
      0
    );
    await prisma.$transaction(tx =>
      WarehouseService.syncAggregateInventory(storeId, productId, variant.id, tx)
    );
    expect((await prisma.productVariant.findUnique({ where: { id: variant.id } }))?.inventory).toBe(
      4
    );
  });
});
