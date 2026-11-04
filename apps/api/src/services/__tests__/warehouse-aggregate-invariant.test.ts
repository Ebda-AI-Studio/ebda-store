/**
 * Warehouse stock sync must honour the inventory invariant
 * (docs/architecture/inventory-model.md): `products.inventory` is stock ONLY for
 * a product with NO variants; a variant product's parent column stays 0.
 *
 * Regression: `syncAggregateInventory` used to write SUM(variant.inventory) into
 * `products.inventory` after every variant-level warehouse write, and the
 * product-level warehouse write path accepted a variant product, so the parent
 * column drifted away from 0 (the 2026-08-30 defect class).
 *
 * Unit-level: raw SQL is captured from a fake tx; no database is involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlLog: string[] = [];
const variantCount = vi.fn();
const variantFindFirst = vi.fn(async () => ({ id: 'v1' }));
const bustMock = vi.fn(async () => undefined);

function tagged(strings: TemplateStringsArray): unknown[] {
  sqlLog.push(strings.join('?'));
  return [{ quantity: 5 }];
}

const fakeTx = {
  $queryRaw: (strings: TemplateStringsArray) => Promise.resolve(tagged(strings)),
  $executeRaw: (strings: TemplateStringsArray) => Promise.resolve(tagged(strings).length),
  warehouseStock: { findFirst: vi.fn(async () => ({ quantity: 1 })) },
  inventoryHistory: { create: vi.fn(async () => ({})) },
};

vi.mock('@ebda/database', () => ({
  prisma: {
    warehouse: { findFirst: vi.fn(async () => ({ id: 'w1', code: 'W1' })) },
    product: { findFirst: vi.fn(async () => ({ id: 'p1' })) },
    productVariant: {
      count: (...a: unknown[]) => variantCount(...a),
      // BE:S-25: the variant must belong to the (store's) product
      findFirst: (...a: unknown[]) => variantFindFirst(...(a as [])),
    },
  },
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
  withMoneyTx: (_c: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));
vi.mock('../../lib/public-cache', () => ({
  invalidateStoreProductCaches: (...a: unknown[]) => bustMock(...(a as [])),
}));

import { WarehouseService } from '../warehouse.service';

const writesProductsInventory = () =>
  sqlLog.some(s => /UPDATE\s+"products"/i.test(s) && /SET\s+inventory/i.test(s));

describe('warehouse stock sync honours the inventory invariant', () => {
  beforeEach(() => {
    sqlLog.length = 0;
    variantCount.mockReset();
    bustMock.mockClear();
  });

  it('a variant-level sync writes the variant row and NEVER products.inventory', async () => {
    await WarehouseService.syncAggregateInventory('s1', 'p1', 'v1', fakeTx as never);
    expect(sqlLog.some(s => /UPDATE\s+"product_variants"/i.test(s))).toBe(true);
    expect(writesProductsInventory()).toBe(false);
  });

  it('a product-level sync (no variant) still writes the product row', async () => {
    await WarehouseService.syncAggregateInventory('s1', 'p1', null, fakeTx as never);
    expect(writesProductsInventory()).toBe(true);
  });

  it('setStock/adjustStock with no variantId on a variant product fails 400 VARIANT_PRODUCT and writes nothing', async () => {
    variantCount.mockResolvedValue(2);
    await expect(
      WarehouseService.setStock('s1', 'w1', { productId: 'p1', quantity: 3 })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_PRODUCT' });
    await expect(
      WarehouseService.adjustStock('s1', 'w1', { productId: 'p1', delta: 3 })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_PRODUCT' });
    expect(sqlLog).toHaveLength(0);
    expect(bustMock).not.toHaveBeenCalled();
  });

  it('a variant write through setStock/adjustStock busts the product caches and leaves the parent alone', async () => {
    await WarehouseService.setStock('s1', 'w1', { productId: 'p1', variantId: 'v1', quantity: 3 });
    await WarehouseService.adjustStock('s1', 'w1', { productId: 'p1', variantId: 'v1', delta: 1 });
    expect(writesProductsInventory()).toBe(false);
    expect(bustMock).toHaveBeenCalledTimes(2);
  });

  it('a plain product write busts the caches too', async () => {
    variantCount.mockResolvedValue(0);
    await WarehouseService.setStock('s1', 'w1', { productId: 'p1', quantity: 3 });
    expect(writesProductsInventory()).toBe(true);
    expect(bustMock).toHaveBeenCalledTimes(1);
  });
});
