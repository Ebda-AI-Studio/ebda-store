import type { JobDef } from '../../jobs/types';
import { runInStoreScope } from '@ebda/database';
import { acrossStoresDb } from '../../jobs/store-db';
import logger from '../../logger';
import { inngest } from '../client';
import { WarehouseService } from '../../../services/warehouse.service';
import { sendAlert } from '../../../services/alerts.service';

import { REGION } from '@ebda/shared';
interface FanoutStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface WarehouseSweepResult {
  storesTotal: number;
  storesSwept: number;
  storesFailed: number;
  totalSkusReconciled: number;
  totalSkusFailed: number;
}

/**
 * Daily completeness sweep — the class-fix for `WarehouseStock` drift
 * (Task 4, item 5 data-integrity).
 *
 * THE PROBLEM: `Product.inventory`/`ProductVariant.inventory` has many
 * writers (order sale/refund decrement+restore, `bulkAdjustInventory`,
 * `VariantService.bulkUpdateInventory`, `ProductService.updateInventory`/
 * `bulkUpdate`, the barcode-scan variant branch, purchase-order receive/WAC,
 * plus any future writer) but only a handful were individually hooked to
 * call `WarehouseService.reconcileWarehouseStockToAggregate` (Task 3's 3
 * admin writers + Task 4's order-refunded fanout step). Hooking every writer
 * one at a time is fragile and was already found incomplete during Task 3's
 * review. `WarehouseStock` is an admin-view-only shadow (never read by the
 * storefront/checkout — the authoritative value is always
 * `Product.inventory`/`ProductVariant.inventory`), so eventual consistency is
 * fine: a DAILY sweep that reconciles every multi-warehouse store, regardless
 * of which writer last touched the aggregate, is the robust fix that covers
 * every writer — current AND future — without per-writer wiring.
 *
 * Enumerates stores that HAVE at least one warehouse (via `withRlsBypass`,
 * since `warehouses` is FORCE RLS and this cron has no tenant GUC) rather
 * than gating on a feature flag — multi-warehouse has no dedicated feature
 * key today, and "has a warehouse row" is the precise condition under which
 * `WarehouseStock` drift is even possible.
 *
 * Fail-soft (per item 5's Task 4 spec): each store's reconcile runs inside
 * its own `step.run` AND its own try/catch — a single store's failure is
 * logged and counted, never aborts the sweep or fails the whole cron run.
 * This differs from `orderRefunded`'s reconcile step (which THROWS so
 * Inngest retries + dead-letters a single order's failure) because THIS job
 * iterates every store in one run: throwing on store #3 of 500 would abandon
 * stores #4-500 for the day, which is worse than logging store #3 and
 * reconciling it again tomorrow.
 *
 * `WarehouseService.backfillReconcileAll` already never writes
 * `Product.inventory`/`ProductVariant.inventory` (read-only on the
 * aggregate) and already isolates per-SKU failures internally — this sweep
 * only adds the per-STORE isolation layer on top.
 *
 * Wrapped in `runInStoreScope`, NOT `runInTenantContext` (issue 2081; fix
 * wave 2, #936): a store's SKU count is unbounded, and `runInTenantContext`
 * opens ONE Prisma interactive transaction with a 30s `timeout` for whatever
 * runs inside it — `POST /warehouses/reconcile-all` hit exactly that ceiling
 * (2026-07-23). #936 removed the wrapper entirely, which worked only because
 * all four touched tables (`warehouses`, `warehouse_stock`, `products`,
 * `product_variants`) allow an unset `app.current_store_id` today — nothing
 * tied the code to that. `runInStoreScope` gives every query its own short
 * `runInTenantContext` and makes each per-SKU `withMoneyTx` start with the
 * store's `SET LOCAL`, so there is no whole-store ceiling AND the sweep keeps
 * working if one of those policies is ever made strict. The SUMs in
 * `reconcileWarehouseStockToAggregate` also filter `store_id` explicitly now,
 * rather than relying on RLS for it.
 *
 * Failures are alerted, not only logged: a store that throws is a P1, and a
 * night with failed SKUs sends an info alert with the counts.
 */
export async function sweepAllWarehouseStores(
  step: FanoutStep,
  event?: { data?: unknown }
): Promise<WarehouseSweepResult> {
  // FORCE RLS: cron has no storeId — visit every store and keep the ones that
  // have at least one warehouse row.
  // PORTED (Ruling CF-JOBS-4): the cron lists the Postgres stores, a DO store's alarm reads its own Durable Object, and
  // `backfillReconcileAll` then reconciles through the DO stock op.
  const stores = await step.run('list-stores-with-warehouses', async () => {
    const found: Array<{ storeId: string }> = [];
    await acrossStoresDb(event, async (storeId, db) => {
      if (await db.warehouse.findFirst({ where: { storeId }, select: { storeId: true } }))
        found.push({ storeId });
    });
    return found;
  });

  let storesSwept = 0;
  let storesFailed = 0;
  let totalSkusReconciled = 0;
  let totalSkusFailed = 0;

  for (const { storeId } of stores) {
    try {
      const result = await step.run(`sweep-${storeId}`, () =>
        runInStoreScope(storeId, () => WarehouseService.backfillReconcileAll(storeId))
      );
      storesSwept++;
      totalSkusReconciled += result.skusReconciled;
      totalSkusFailed += result.skusFailed;
    } catch (err) {
      // Fail-soft: one store's failure is logged + counted, never aborts
      // the sweep. The store is simply retried on tomorrow's run.
      storesFailed++;
      logger.error(
        { err, storeId },
        '[warehouse-reconcile-sweep] store sweep failed, continuing to next store'
      );
    }
  }

  const result: WarehouseSweepResult = {
    storesTotal: stores.length,
    storesSwept,
    storesFailed,
    totalSkusReconciled,
    totalSkusFailed,
  };
  logger.info(result, '[warehouse-reconcile-sweep] daily completeness sweep complete');
  if (storesFailed > 0 || totalSkusFailed > 0) {
    await step.run('alert-reconcile-failures', () =>
      sendAlert({
        // A whole store failing means its drift was not repaired tonight; a
        // failed SKU is usually a soft-deleted product (see backfillReconcileAll).
        level: storesFailed > 0 ? 'p1' : 'info',
        scope: 'platform',
        source: 'warehouse.reconcile_sweep',
        title: 'Warehouse reconcile sweep had failures',
        body: `${storesFailed} of ${stores.length} store(s) failed; ${totalSkusFailed} SKU(s) could not be reconciled. Inventory drift for those is NOT repaired until a later run succeeds.`,
        context: { ...result },
      }).then(() => undefined)
    );
  }
  return result;
}

export const warehouseReconcileSweepCron: JobDef = inngest.createFunction(
  {
    id: 'warehouse-reconcile-sweep-cron',
    name: 'Warehouse stock reconcile — daily completeness sweep',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 0 6 * * *` }], // 06:00 Cairo (DST-aware via TZ=)
  },
  async ({ event, step }) => sweepAllWarehouseStores(step, event)
);

/**
 * On-demand twin — fired by Task 5's admin "Reconcile now" button.
 * Event: `warehouse/reconcile-requested` with data `{ storeId, requestedBy? }`.
 * Single-store, so no per-store fail-soft loop is needed here — a failure
 * simply propagates so the admin UI/Inngest dashboard shows it failed
 * (retries:1, matching the other on-demand twins in this registry).
 */
export async function reconcileOneStoreOnDemand(
  storeId: string,
  requestedBy: string | undefined,
  step: FanoutStep
): ReturnType<typeof WarehouseService.backfillReconcileAll> {
  logger.info({ storeId, requestedBy }, '[warehouse-reconcile-on-demand] starting');

  const result = await step.run(`sweep-${storeId}`, () =>
    runInStoreScope(storeId, () => WarehouseService.backfillReconcileAll(storeId))
  );

  logger.info({ storeId, requestedBy, ...result }, '[warehouse-reconcile-on-demand] complete');

  return result;
}

export const warehouseReconcileOnDemand: JobDef = inngest.createFunction(
  {
    id: 'warehouse-reconcile-on-demand',
    name: 'Warehouse stock reconcile — on-demand',
    retries: 1,
    triggers: [{ event: 'warehouse/reconcile-requested' }],
  },
  async ({ event, step }) => {
    const { storeId, requestedBy } = event.data;
    return reconcileOneStoreOnDemand(storeId, requestedBy, step);
  }
);
