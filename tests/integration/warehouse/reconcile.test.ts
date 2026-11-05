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
import { prisma } from '@ebda/database';
import { WarehouseService } from '../../../apps/api/src/services/warehouse.service';
import logger from '../../../apps/api/src/lib/logger';

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

  it('WAREHOUSE-NEG-1: default cannot absorb the full deficit → the rest comes from the other warehouses, no row negative, SUM == aggregate', async () => {
    // Default warehouse only holds 2 units; other warehouse holds 10. The aggregate drifts down to 3 (diff = 3 - 12 = -9).
    // WAREHOUSE-NEG-1: the default gives its 2 (to 0), warehouse C gives the other 7 (to 3): SUM == aggregate and no row is
    // negative. (The earlier allow-negative-on-default policy took the whole -9 from the default: 2 -> -7.)
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
    expect(defaultStock?.quantity).toBe(0); // WAREHOUSE-NEG-1: floored at 0, the rest of the deficit comes from C

    const cStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId: warehouseC.id, productId, variantId: null },
    });
    expect(cStock?.quantity).toBe(3);

    const sum = (defaultStock?.quantity ?? 0) + (cStock?.quantity ?? 0);
    expect(sum).toBe(3); // SUM == Product.inventory, the invariant holds exactly

    await prisma.warehouse.deleteMany({ where: { id: warehouseC.id } });
  });

  it('WAREHOUSE-NEG-1: a deficit the rows cannot cover floors every row at 0 and logs reconcile_shortfall', async () => {
    const productId = await makeProduct('shortfall', 4);
    await prisma.warehouseStock.create({
      data: { warehouseId, productId, variantId: null, quantity: 4, storeId },
    });
    // the aggregate falls below zero (a state the stock operations cannot produce, forced here): no row may follow it down
    await prisma.$executeRaw`UPDATE "products" SET "inventory" = -3 WHERE "id" = ${productId}`;
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const result = await WarehouseService.reconcileWarehouseStockToAggregate(
        storeId,
        productId,
        null
      );
      expect(result.reconciled).toBe(true);
      const row = await prisma.warehouseStock.findFirst({
        where: { warehouseId, productId, variantId: null },
      });
      expect(row?.quantity).toBe(0);
      expect(errSpy.mock.calls.some(c => String(c[1]).includes('reconcile_shortfall'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
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
    // The deadlock this inverted lock order creates is symmetric — Postgres
    // picks EITHER side as the victim, arbitrarily. Both sides now retry
    // themselves internally: reconcile since fix wave 1, and `adjustStock` /
    // `setStock` since #937 (`WAREHOUSE_WRITE_RETRY`). The adjustStock calls
    // below are therefore made BARE, exactly as the warehouse routes make
    // them — a caller-side retry here would hide the 500 the route used to
    // return when adjustStock was the victim.
    const CONCURRENT_ADJUSTS = 40;

    // WHY THIS IS A LOOP (2026-08-08 flake fix).
    //
    // A single round cannot guarantee the deadlock manifests, and the setup
    // comment below says so explicitly: any racing `adjustStock` may win and
    // re-sync `Product.inventory` down to the warehouse_stock SUM first, after
    // which reconcile legitimately sees diff===0 and returns BEFORE it ever
    // touches warehouse_stock — no inverted lock order, no deadlock, nothing
    // to retry. That is correct behaviour, not a bug.
    //
    // The previous version asserted `reconcileRetried === true` after ONE round,
    // which contradicted its own comment and made the test non-deterministic:
    // observed pass/fail/fail/pass on identical code, costing 3 CI reruns.
    //
    // So: the two REAL invariants (no unretried throw, SUM === inventory) are
    // asserted on EVERY round and are fully deterministic. Only the
    // "did the retry path actually engage" observation is looped, because that
    // one is inherently probabilistic. Rounds use a fresh product each time —
    // once reconcile heals the drift, re-racing the same row proves nothing.
    const MAX_ROUNDS = 6;
    let reconcileRetried = false;
    let roundsRun = 0;

    for (let round = 0; round < MAX_ROUNDS && !reconcileRetried; round++) {
      roundsRun = round + 1;
      const productId = await makeProduct(`deadlock-${round}`, 100); // authoritative aggregate = 100
      await prisma.warehouseStock.create({
        // Deliberately drifted (diff = +30) so reconcile's write path is
        // eligible to reach the warehouse_stock upsert (a diff===0 reconcile
        // returns before ever touching warehouse_stock, and the deadlock
        // hazard can't manifest).
        data: { warehouseId, productId, variantId: null, quantity: 70, storeId },
      });

      const warnSpy = vi.spyOn(logger, 'warn');
      try {
        // MAKE THE INVERTED LOCK ORDER HAPPEN (2026-10-25). Racing 40 adjusts against reconcile
        // only produced the deadlock when scheduling happened to interleave them; with the
        // bounded 6-client pool (#161) reconcile finishes before the adjusts even reach their
        // transaction, so no round ever overlapped and the retry path went unobserved (red on
        // main since 2026-10-25, nothing in warehouse code had changed). Instead we play the
        // adjustStock side by hand, deterministically:
        //   1. `adjuster` locks the warehouse_stock row (what adjustStock does first),
        //   2. reconcile locks the products row, then blocks on that warehouse_stock row,
        //   3. after a pause shorter than deadlock_timeout (1 s) `adjuster` asks for the products
        //      row. Reconcile has been waiting longer, so ITS deadlock check fires first and
        //      Postgres aborts reconcile (40P01) -> `retryOnWriteConflict` must retry it.
        // The real adjustStock calls still race on top, bare, exactly as the routes make them.
        let adjusterLocked!: () => void;
        const adjusterHoldsStock = new Promise<void>(r => (adjusterLocked = r));
        let reconcileWaiting!: () => void;
        const reconcileIsWaiting = new Promise<void>(r => (reconcileWaiting = r));
        const adjuster = prisma
          .$transaction(
            async tx => {
              await tx.$queryRaw`
                SELECT 1 FROM "warehouse_stock"
                WHERE "store_id" = ${storeId} AND "product_id" = ${productId} AND "variant_id" IS NULL
                FOR UPDATE`;
              adjusterLocked();
              await reconcileIsWaiting;
              await new Promise(r => setTimeout(r, 300));
              await tx.$queryRaw`
                SELECT 1 FROM "products" WHERE "id" = ${productId} AND "store_id" = ${storeId} FOR UPDATE`;
            },
            { timeout: 30000, maxWait: 10000 }
          )
          .catch((e: unknown) => e); // it can be the deadlock victim instead: then this round proves nothing, the loop goes on
        await adjusterHoldsStock;

        const reconcileCall = WarehouseService.reconcileWarehouseStockToAggregate(
          storeId,
          productId,
          null
        );
        for (let i = 0; i < 100; i++) {
          const rows = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%warehouse_stock%'`;
          if ((rows[0]?.n ?? 0) > 0) break;
          await new Promise(r => setTimeout(r, 50));
        }
        reconcileWaiting();

        const [reconcileResult] = await Promise.all([
          reconcileCall,
          adjuster,
          ...Array.from({ length: CONCURRENT_ADJUSTS }, () =>
            WarehouseService.adjustStock(storeId, warehouseId, { productId, delta: 0 })
          ),
        ]);

        // INVARIANT 1 — no unretried throw: Promise.all would have rejected
        // already if any call surfaced an unretried deadlock/serialization
        // failure. This is the primary thing this test proves.
        expect(reconcileResult).toEqual(
          expect.objectContaining({ reconciled: expect.any(Boolean) })
        );

        // INVARIANT 2 — SUM(WarehouseStock) === Product.inventory, exactly.
        // Holds regardless of whether reconcile or a racing adjustStock's own
        // resync was the one that last touched it.
        const stock = await prisma.warehouseStock.findFirst({
          where: { warehouseId, productId, variantId: null },
        });
        const product = await prisma.product.findUnique({ where: { id: productId } });
        expect(stock?.quantity).toBe(product?.inventory);

        reconcileRetried = warnSpy.mock.calls.some(
          call =>
            (call[0] as { label?: string } | undefined)?.label ===
            'reconcileWarehouseStockToAggregate'
        );
      } finally {
        warnSpy.mockRestore();
      }
    }

    // Proves the retry path (not just the matched lock order) actually engaged
    // at least once across the rounds: a write-conflict retry was logged for
    // reconcile under real concurrent load. With 40 concurrent adjusts per
    // round this converges quickly; MAX_ROUNDS exists so a pathologically
    // serialized runner fails loudly instead of hanging.
    expect(
      reconcileRetried,
      `no reconcile write-conflict retry observed in ${roundsRun} round(s) of ` +
        `${CONCURRENT_ADJUSTS} concurrent adjustStock calls — the inverted-lock-order ` +
        `retry path was never exercised, so this run did not cover it`
    ).toBe(true);
  }, 120000);
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
