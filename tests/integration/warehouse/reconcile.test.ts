/**
 * WarehouseService.reconcileWarehouseStockToAggregate + backfillReconcileAll
 *
 * THE BUG: `Product.inventory` / `ProductVariant.inventory` is authoritative
 * and has 4 writers, but only `syncAggregateInventory` (called from
 * setStock/adjustStock) touches `WarehouseStock`. So other writers of the
 * aggregate (e.g. order placement decrementing `Product.inventory` directly)
 * move the aggregate WITHOUT moving `WarehouseStock` — per-warehouse counts
 * drift from `SUM(WarehouseStock) != Product.inventory`. This suite
 * simulates that drift directly (writing `Product.inventory` without going
 * through WarehouseService) and proves the reconcile helper repairs it by
 * writing the DIFF onto the default warehouse's row — never touching the
 * authoritative aggregate itself.
 *
 * Real DB required (docker ephemeral Postgres per task-1-report.md's
 * recipe). Self-contained: creates its own owner/store/products/warehouses
 * and cleans up in afterAll.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { WarehouseService } from '../../../apps/api/src/services/warehouse.service';
import logger from '../../../apps/api/src/lib/logger';
import { retryOnWriteConflict } from '../../../apps/api/src/lib/db-retry';

describe('WarehouseService.reconcileWarehouseStockToAggregate', () => {
  let storeId: string;
  let userId: string;
  let warehouseId: string; // sole/default warehouse for most cases

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `wh-reconcile-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'WH',
        lastName: 'Reconcile',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Warehouse Reconcile Test Store',
        slug: `wh-reconcile-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    storeId = store.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Reconcile WH',
        code: `RECON-${Date.now()}`,
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

  async function makeProduct(tag: string, inventory = 0): Promise<string> {
    const p = await prisma.product.create({
      data: {
        storeId,
        name: 'Reconcile SKU',
        slug: `wh-reconcile-sku-${tag}-${Date.now()}`,
        price: 5000,
        inventory,
        status: 'active',
        trackInventory: true,
      },
    });
    return p.id;
  }

  it('drifted single-warehouse SKU: WarehouseStock=10, Product.inventory set to 7 → reconcile makes SUM == 7', async () => {
    const productId = await makeProduct('drift', 10);
    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 10, storeId },
    });

    // Simulate a drifted sale: some OTHER writer moved the authoritative
    // aggregate directly, without touching WarehouseStock (the bug this
    // helper exists to fix). We deliberately do NOT call WarehouseService
    // here — that's the point.
    await prisma.product.update({ where: { id: productId }, data: { inventory: 7 } });

    const result = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      null
    );

    expect(result.reconciled).toBe(true);
    expect(result.diff).toBe(-3);

    const stock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(stock?.quantity).toBe(7);

    // Authoritative aggregate itself must be untouched by reconcile.
    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(7);
  });

  it('store with NO warehouses → {reconciled:false, diff:0}, zero writes', async () => {
    const noWhUser = await prisma.user.create({
      data: {
        email: `wh-reconcile-nowh-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'NoWh',
        lastName: 'Store',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    const noWhStore = await prisma.store.create({
      data: {
        name: 'No Warehouse Store',
        slug: `wh-reconcile-nowh-${Date.now()}`,
        ownerId: noWhUser.id,
        status: 'active',
      },
    });
    const noWhProduct = await prisma.product.create({
      data: {
        storeId: noWhStore.id,
        name: 'No WH SKU',
        slug: `wh-reconcile-nowh-sku-${Date.now()}`,
        price: 5000,
        inventory: 42,
        status: 'active',
        trackInventory: true,
      },
    });

    const result = await WarehouseService.reconcileWarehouseStockToAggregate(
      noWhStore.id,
      noWhProduct.id,
      null
    );
    expect(result).toEqual({ reconciled: false, diff: 0 });

    const stockCount = await prisma.warehouseStock.count({ where: { storeId: noWhStore.id } });
    expect(stockCount).toBe(0);

    const product = await prisma.product.findUnique({ where: { id: noWhProduct.id } });
    expect(product?.inventory).toBe(42); // untouched

    await prisma.product.deleteMany({ where: { storeId: noWhStore.id } });
    await prisma.store.deleteMany({ where: { id: noWhStore.id } });
    await prisma.user.deleteMany({ where: { id: noWhUser.id } });
  });

  it('already-consistent SKU → {reconciled:false, diff:0}, no write', async () => {
    const productId = await makeProduct('consistent', 15);
    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 15, storeId },
    });

    const result = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      null
    );
    expect(result).toEqual({ reconciled: false, diff: 0 });

    const stock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(stock?.quantity).toBe(15);
  });

  it('variant SKU: reconciles the variant warehouse row + keeps product-level rollup consistent', async () => {
    const productId = await makeProduct('variant-drift', 20);
    const variant = await prisma.productVariant.create({
      data: {
        productId,
        title: 'Reconcile Variant',
        sku: `wh-reconcile-variant-${Date.now()}`,
        price: 5000,
        inventory: 20,
      },
    });
    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: variant.id, quantity: 20, storeId },
    });

    // Drift: variant sold 6 units via some other path (not WarehouseService).
    await prisma.productVariant.update({ where: { id: variant.id }, data: { inventory: 14 } });
    await prisma.product.update({ where: { id: productId }, data: { inventory: 14 } });

    const result = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      variant.id
    );
    expect(result.reconciled).toBe(true);
    expect(result.diff).toBe(-6);

    const stock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: variant.id },
    });
    expect(stock?.quantity).toBe(14);

    const updatedVariant = await prisma.productVariant.findUnique({ where: { id: variant.id } });
    expect(updatedVariant?.inventory).toBe(14);
  });

  it('two warehouses (10+10=20), aggregate drifted to 15 → default absorbs -5 (allow-negative-on-default policy N/A here, still non-negative)', async () => {
    const productId = await makeProduct('two-wh', 20);
    const warehouseB = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Reconcile WH B',
        code: `RECON-B-${Date.now()}`,
        isDefault: false,
        priority: 50,
        isActive: true,
      },
    });

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 10, storeId },
    });
    await prisma.warehouseStock.create({
      data: { warehouseId: warehouseB.id, productId, variantId: null, quantity: 10, storeId },
    });

    await prisma.product.update({ where: { id: productId }, data: { inventory: 15 } });

    const result = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      null
    );
    expect(result.reconciled).toBe(true);
    expect(result.diff).toBe(-5);

    const defaultStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(defaultStock?.quantity).toBe(5); // 10 - 5, default absorbs the whole diff

    const bStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId: warehouseB.id, productId, variantId: null },
    });
    expect(bStock?.quantity).toBe(10); // untouched — only the default warehouse absorbs

    const sum = (defaultStock?.quantity ?? 0) + (bStock?.quantity ?? 0);
    expect(sum).toBe(15);

    await prisma.warehouse.deleteMany({ where: { id: warehouseB.id } });
  });

  it('allow-negative-on-default: default cannot absorb the full diff without going negative → still SUM == aggregate', async () => {
    // Default warehouse only holds 2 units; other warehouse holds 10.
    // Aggregate drifts down to 3 (diff = 3 - 12 = -9). The default warehouse
    // must absorb the FULL -9 (going from 2 to -7) so that
    // SUM(WarehouseStock) == Product.inventory always holds exactly — a
    // clamp-at-0 policy would leave SUM at 1 instead of 3, reintroducing
    // drift. This test locks in the allow-negative-on-default decision.
    const productId = await makeProduct('negative-absorb', 12);
    const warehouseC = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Reconcile WH C',
        code: `RECON-C-${Date.now()}`,
        isDefault: false,
        priority: 10,
        isActive: true,
      },
    });

    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 2, storeId },
    });
    await prisma.warehouseStock.create({
      data: { warehouseId: warehouseC.id, productId, variantId: null, quantity: 10, storeId },
    });

    await prisma.product.update({ where: { id: productId }, data: { inventory: 3 } });

    const result = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      null
    );
    expect(result.reconciled).toBe(true);
    expect(result.diff).toBe(-9);

    const defaultStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(defaultStock?.quantity).toBe(-7); // allowed negative — no clamp

    const cStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId: warehouseC.id, productId, variantId: null },
    });
    expect(cStock?.quantity).toBe(10);

    const sum = (defaultStock?.quantity ?? 0) + (cStock?.quantity ?? 0);
    expect(sum).toBe(3); // SUM == Product.inventory, the invariant holds exactly

    await prisma.warehouse.deleteMany({ where: { id: warehouseC.id } });
  });

  it('reconcile is idempotent: re-running immediately after a successful reconcile makes no further change', async () => {
    const productId = await makeProduct('idempotent', 8);
    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 20, storeId },
    });
    await prisma.product.update({ where: { id: productId }, data: { inventory: 8 } });

    const first = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      null
    );
    expect(first.reconciled).toBe(true);
    expect(first.diff).toBe(-12);

    const second = await WarehouseService.reconcileWarehouseStockToAggregate(
      storeId,
      productId,
      null
    );
    expect(second).toEqual({ reconciled: false, diff: 0 });

    const stock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    expect(stock?.quantity).toBe(8);
  });

  it('concurrent reconcile + adjustStock on the SAME product/default-warehouse row survive the inverted lock order via retry, final state consistent', async () => {
    // reconcileWarehouseStockToAggregate locks the aggregate (products) row
    // FIRST, then the warehouse_stock row SECOND. adjustStock locks the
    // warehouse_stock row FIRST (via upsertWarehouseStock), then the
    // aggregate SECOND (via syncAggregateInventory). Racing many real
    // concurrent adjustStock calls against a real reconcile call on the
    // SAME row exercises the actual inverted-lock-order deadlock hazard
    // (Postgres 40P01 / Prisma P2034) fix wave 1 added a retry for — no
    // artificial mocking, real transactions, real locks.
    const productId = await makeProduct('deadlock', 100); // authoritative aggregate = 100
    await prisma.warehouseStock.create({
      // Deliberately drifted (diff = +30) so reconcile's write path is
      // eligible to reach the warehouse_stock upsert (a diff===0 reconcile
      // returns before ever touching warehouse_stock, and the deadlock
      // hazard can't manifest). NOTE: any of the concurrent `adjustStock`
      // calls below can win the race and re-sync `Product.inventory` down
      // to the warehouse_stock SUM (70) before reconcile reads it — that's
      // adjustStock's own correct, pre-existing self-heal behavior, not a
      // bug — so reconcile may legitimately see diff===0 by the time it
      // runs. Either outcome (reconcile fixes the drift, or finds it
      // already gone) is fine; what this test actually locks in is (a) no
      // unretried throw from EITHER side and (b) the invariant holds
      // exactly at the end.
      data: { warehouseId, productId, variantId: null, quantity: 70, storeId },
    });

    const warnSpy = vi.spyOn(logger, 'warn');

    // The deadlock this inverted lock order creates is symmetric — Postgres
    // picks EITHER side as the victim, arbitrarily. `reconcileWarehouseStockToAggregate`
    // now retries itself internally (the actual fix). `adjustStock` is
    // Task-1 code this task must NOT modify, so it has no internal retry —
    // exactly like every other caller of it today. Wrapping the test's own
    // calls in the SAME shared `retryOnWriteConflict` helper stands in for
    // what any caller already ought to do around a Serializable-adjacent
    // write under heavy contention (identical to how cart.service already
    // uses this helper) — this is caller-side retry, not a change to
    // adjustStock's source.
    const CONCURRENT_ADJUSTS = 40;
    const [reconcileResult] = await Promise.all([
      WarehouseService.reconcileWarehouseStockToAggregate(storeId, productId, null),
      ...Array.from({ length: CONCURRENT_ADJUSTS }, () =>
        retryOnWriteConflict(
          () => WarehouseService.adjustStock(storeId, warehouseId, { productId, delta: 0 }),
          { extraRetryCodes: ['40P01', '40001'], label: 'test-adjustStock-guard' }
        )
      ),
    ]);

    // No unretried throw: Promise.all above would have rejected already if
    // any call surfaced an unretried deadlock/serialization failure — that
    // is the primary thing this test proves.
    expect(reconcileResult).toEqual(expect.objectContaining({ reconciled: expect.any(Boolean) }));

    // Invariant: SUM(WarehouseStock) === Product.inventory, exactly — holds
    // regardless of whether reconcile or a racing adjustStock's own resync
    // was the one that last touched it.
    const stock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId, variantId: null },
    });
    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(stock?.quantity).toBe(product?.inventory);

    // Proves the retry path (not just the matched lock order) actually
    // engaged: at least one write-conflict retry was logged for reconcile
    // under this real concurrent load.
    const reconcileRetried = warnSpy.mock.calls.some(
      call =>
        (call[0] as { label?: string } | undefined)?.label === 'reconcileWarehouseStockToAggregate'
    );
    expect(reconcileRetried).toBe(true);

    warnSpy.mockRestore();
  }, 30000);
});

describe('WarehouseService.backfillReconcileAll', () => {
  let storeId: string;
  let userId: string;
  let warehouseId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `wh-backfill-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'WH',
        lastName: 'Backfill',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Warehouse Backfill Test Store',
        slug: `wh-backfill-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    storeId = store.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Backfill WH',
        code: `BACKFILL-${Date.now()}`,
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

  it('fixes a seeded multi-SKU drift, then re-run makes no further change (idempotent)', async () => {
    // Seed 3 drifted SKUs + 1 already-consistent SKU.
    const productIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const productId = await prisma.product
        .create({
          data: {
            storeId,
            name: `Backfill SKU ${i}`,
            slug: `wh-backfill-sku-${i}-${Date.now()}`,
            price: 5000,
            inventory: 10 + i, // drifted authoritative value
            status: 'active',
            trackInventory: true,
          },
        })
        .then(p => p.id);
      await prisma.warehouseStock.create({
        data: { warehouseId, productId, variantId: null, quantity: 50, storeId }, // stale shadow
      });
      productIds.push(productId);
    }

    const consistentProductId = await prisma.product
      .create({
        data: {
          storeId,
          name: 'Backfill Consistent SKU',
          slug: `wh-backfill-consistent-${Date.now()}`,
          price: 5000,
          inventory: 5,
          status: 'active',
          trackInventory: true,
        },
      })
      .then(p => p.id);
    await prisma.warehouseStock.create({
      data: { warehouseId, productId: consistentProductId, variantId: null, quantity: 5, storeId },
    });

    const firstRun = await WarehouseService.backfillReconcileAll(storeId);
    expect(firstRun.skusReconciled).toBe(3);
    expect(firstRun.skusFailed).toBe(0);

    for (let i = 0; i < 3; i++) {
      const stock = await prisma.warehouseStock.findFirst({
        where: { warehouseId, productId: productIds[i], variantId: null },
      });
      expect(stock?.quantity).toBe(10 + i);
    }
    const consistentStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: consistentProductId, variantId: null },
    });
    expect(consistentStock?.quantity).toBe(5); // unchanged, was already consistent

    // Idempotent: re-run immediately → zero further reconciliations.
    const secondRun = await WarehouseService.backfillReconcileAll(storeId);
    expect(secondRun.skusReconciled).toBe(0);
    expect(secondRun.skusFailed).toBe(0);
  });

  it('one un-reconcilable SKU is skipped-and-counted-failed, the other SKU still reconciles, no throw', async () => {
    // Good SKU: a normal drifted product in this store.
    const goodProductId = await prisma.product
      .create({
        data: {
          storeId,
          name: 'Backfill Good SKU',
          slug: `wh-backfill-good-${Date.now()}`,
          price: 5000,
          inventory: 42,
          status: 'active',
          trackInventory: true,
        },
      })
      .then(p => p.id);
    await prisma.warehouseStock.create({
      data: { warehouseId, productId: goodProductId, variantId: null, quantity: 100, storeId },
    });

    // Bad SKU: WarehouseStock row is stamped with THIS store's id, but its
    // product actually belongs to a DIFFERENT store. reconcile's under-lock
    // lookup filters `WHERE id = productId AND store_id = storeId`, so it
    // finds 0 rows and throws AppError(404, PRODUCT_NOT_FOUND) — the same
    // "product/variant not found under lock" failure class a genuine
    // deleted/orphaned SKU would hit. (A stable hard-deleted orphan can't be
    // seeded directly here: WarehouseStock.productId has `onDelete: Cascade`,
    // so deleting the product would cascade-delete this row along with it —
    // this cross-store mismatch is the FK-safe stand-in for "un-reconcilable".)
    const otherUser = await prisma.user.create({
      data: {
        email: `wh-backfill-other-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Other',
        lastName: 'Store',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    const otherStore = await prisma.store.create({
      data: {
        name: 'Other Store (backfill bad SKU)',
        slug: `wh-backfill-other-store-${Date.now()}`,
        ownerId: otherUser.id,
        status: 'active',
      },
    });
    const badProduct = await prisma.product.create({
      data: {
        storeId: otherStore.id,
        name: 'Backfill Bad SKU (wrong store)',
        slug: `wh-backfill-bad-${Date.now()}`,
        price: 5000,
        inventory: 5,
        status: 'active',
        trackInventory: true,
      },
    });
    await prisma.warehouseStock.create({
      data: { warehouseId, productId: badProduct.id, variantId: null, quantity: 50, storeId },
    });

    const result = await WarehouseService.backfillReconcileAll(storeId);

    expect(result.skusReconciled).toBe(1); // only the good SKU
    expect(result.skusFailed).toBe(1); // the bad SKU, skipped not thrown

    const goodStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: goodProductId, variantId: null },
    });
    expect(goodStock?.quantity).toBe(42); // reconciled despite the sibling SKU's failure

    const badStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: badProduct.id, variantId: null },
    });
    expect(badStock?.quantity).toBe(50); // untouched — reconcile never got to write it

    await prisma.warehouseStock.deleteMany({ where: { productId: badProduct.id } });
    await prisma.product.deleteMany({ where: { id: badProduct.id } });
    await prisma.store.deleteMany({ where: { id: otherStore.id } });
    await prisma.user.deleteMany({ where: { id: otherUser.id } });
  });

  it('store with NO warehouses → {skusReconciled:0}, no-op', async () => {
    const noWhUser = await prisma.user.create({
      data: {
        email: `wh-backfill-nowh-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'NoWh',
        lastName: 'Backfill',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    const noWhStore = await prisma.store.create({
      data: {
        name: 'No Warehouse Backfill Store',
        slug: `wh-backfill-nowh-${Date.now()}`,
        ownerId: noWhUser.id,
        status: 'active',
      },
    });

    const result = await WarehouseService.backfillReconcileAll(noWhStore.id);
    expect(result).toEqual({ skusReconciled: 0, skusFailed: 0 });

    await prisma.store.deleteMany({ where: { id: noWhStore.id } });
    await prisma.user.deleteMany({ where: { id: noWhUser.id } });
  });
});
