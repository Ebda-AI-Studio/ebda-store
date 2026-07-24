import type { InngestFunction } from 'inngest';
import { withRlsBypass, runInTenantContext } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { WarehouseService } from '../../../services/warehouse.service';

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
 * INNGEST_DEPLOY_ID note: like every other cron in this registry, this new
 * function is invisible to the Inngest platform until a deploy bumps
 * `INNGEST_DEPLOY_ID` (see the trap explained in `client.ts` and
 * `queue-depth-watch.ts`) — the first deploy that ships this file needs a
 * real deploy (not just a hot-reload) for Inngest to pick up the new
 * cron/on-demand pair.
 */
export async function sweepAllWarehouseStores(step: FanoutStep): Promise<WarehouseSweepResult> {
  // FORCE RLS: cron has no storeId — use withRlsBypass to enumerate every
  // store that has at least one warehouse row (distinct storeId).
  const stores = await step.run('list-stores-with-warehouses', () =>
    withRlsBypass(tx =>
      tx.warehouse.findMany({
        distinct: ['storeId'],
        select: { storeId: true },
      })
    )
  );

  let storesSwept = 0;
  let storesFailed = 0;
  let totalSkusReconciled = 0;
  let totalSkusFailed = 0;

  for (const { storeId } of stores) {
    try {
      const result = await step.run(`sweep-${storeId}`, () =>
        runInTenantContext(storeId, () => WarehouseService.backfillReconcileAll(storeId))
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
  return result;
}

export const warehouseReconcileSweepCron: InngestFunction.Any = inngest.createFunction(
  {
    id: 'warehouse-reconcile-sweep-cron',
    name: 'Warehouse stock reconcile — daily completeness sweep',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 * * *' }], // 06:00 KW = 03:00 UTC (Kuwait is UTC+3)
  },
  async ({ step }) => sweepAllWarehouseStores(step)
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
    runInTenantContext(storeId, () => WarehouseService.backfillReconcileAll(storeId))
  );

  logger.info({ storeId, requestedBy, ...result }, '[warehouse-reconcile-on-demand] complete');

  return result;
}

export const warehouseReconcileOnDemand: InngestFunction.Any = inngest.createFunction(
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
