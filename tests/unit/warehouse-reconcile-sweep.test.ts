/**
 * warehouse-reconcile-sweep — daily completeness sweep (Task 4, item 5
 * data-integrity). Verifies: (1) stores are enumerated via withRlsBypass
 * (FORCE RLS, no tenant GUC in a cron), (2) each store's reconcile is NOT
 * wrapped in a whole-store `runInTenantContext` (fix wave 2, #936 — that
 * wrapper opened ONE 30s Prisma transaction across an unbounded SKU count,
 * relocating rather than removing the same ceiling `warehouse.routes.ts`
 * already hit once in the request path; `backfillReconcileAll` and
 * `reconcileWarehouseStockToAggregate` already filter every query explicitly
 * by storeId and RLS permits an unset GUC, so the wrapper bought no
 * additional tenant isolation), and (3) the sweep is FAIL-SOFT — one store's
 * rejection is logged/counted and does NOT abort the loop, unlike the
 * order-refunded fanout's reconcile step which deliberately throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  warehouseFindMany: vi.fn(),
  backfillReconcileAll: vi.fn(),
  runInTenant: vi.fn((_s: string, fn: () => unknown) => fn()),
  withRlsBypass: vi.fn((fn: (tx: unknown) => unknown) =>
    fn({ warehouse: { findMany: h.warehouseFindMany } })
  ),
}));

vi.mock('@force/database', () => ({
  runInTenantContext: h.runInTenant,
  withRlsBypass: h.withRlsBypass,
}));
vi.mock('@api/services/warehouse.service', () => ({
  WarehouseService: { backfillReconcileAll: h.backfillReconcileAll },
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})) } }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  sweepAllWarehouseStores,
  reconcileOneStoreOnDemand,
} from '@api/lib/inngest/functions/warehouse-reconcile-sweep';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.withRlsBypass.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ warehouse: { findMany: h.warehouseFindMany } })
  );
});

describe('sweepAllWarehouseStores', () => {
  it('enumerates stores with warehouses via withRlsBypass and reconciles each WITHOUT a whole-store runInTenantContext wrapper', async () => {
    h.warehouseFindMany.mockResolvedValue([{ storeId: 's1' }, { storeId: 's2' }]);
    h.backfillReconcileAll.mockResolvedValue({ skusReconciled: 2, skusFailed: 0 });

    const result = await sweepAllWarehouseStores(stepStub);

    expect(h.warehouseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ distinct: ['storeId'] })
    );
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('s1');
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('s2');
    // #936: no whole-store 30s transaction ceiling — backfillReconcileAll
    // (and reconcileWarehouseStockToAggregate underneath it) scope RLS
    // per-query/per-SKU themselves.
    expect(h.runInTenant).not.toHaveBeenCalled();

    expect(result).toEqual({
      storesTotal: 2,
      storesSwept: 2,
      storesFailed: 0,
      totalSkusReconciled: 4,
      totalSkusFailed: 0,
    });
  });

  it('is FAIL-SOFT — one store rejecting does not abort the sweep, later stores still run', async () => {
    h.warehouseFindMany.mockResolvedValue([{ storeId: 'bad' }, { storeId: 'good' }]);
    h.backfillReconcileAll.mockImplementation((storeId: string) => {
      if (storeId === 'bad') return Promise.reject(new Error('db down for bad store'));
      return Promise.resolve({ skusReconciled: 3, skusFailed: 0 });
    });

    const resolved = await sweepAllWarehouseStores(stepStub);

    // The call resolves (never rejects/throws) even with a bad store, and
    // the good store AFTER it in the list still ran.
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('good');
    expect(resolved.storesFailed).toBe(1);
    expect(resolved.storesSwept).toBe(1);
    expect(resolved.totalSkusReconciled).toBe(3);
  });

  it('returns zeroed counts when no store has a warehouse', async () => {
    h.warehouseFindMany.mockResolvedValue([]);

    const result = await sweepAllWarehouseStores(stepStub);

    expect(h.backfillReconcileAll).not.toHaveBeenCalled();
    expect(result).toEqual({
      storesTotal: 0,
      storesSwept: 0,
      storesFailed: 0,
      totalSkusReconciled: 0,
      totalSkusFailed: 0,
    });
  });
});

describe('reconcileOneStoreOnDemand', () => {
  it('reconciles the single requested store WITHOUT a whole-store runInTenantContext wrapper', async () => {
    h.backfillReconcileAll.mockResolvedValue({ skusReconciled: 5, skusFailed: 1 });

    const result = await reconcileOneStoreOnDemand('s1', 'admin-1', stepStub);

    expect(h.runInTenant).not.toHaveBeenCalled();
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ skusReconciled: 5, skusFailed: 1 });
  });

  it('propagates a rejection (no fail-soft for the single-store on-demand path)', async () => {
    h.backfillReconcileAll.mockRejectedValue(new Error('boom'));

    await expect(reconcileOneStoreOnDemand('s1', undefined, stepStub)).rejects.toThrow('boom');
  });
});
