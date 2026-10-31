/**
 * warehouse-reconcile-sweep — daily completeness sweep (Task 4, item 5
 * data-integrity). Verifies: (1) stores are enumerated with acrossStores
 * (strict RLS, one tenant transaction per store), (2) each store's reconcile is NOT
 * wrapped in a whole-store `runInTenantContext` but IS wrapped in
 * `runInStoreScope` (issue 2081 — per-query scoping; fix wave 2, #936 — that
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
  scopes: [] as string[],
  runInStoreScope: vi.fn(),
  sendAlert: vi.fn().mockResolvedValue('sent'),
}));

vi.mock('@ebda/database', () => ({
  runInTenantContext: h.runInTenant,
  runInStoreScope: h.runInStoreScope,
  // the sweep asks each store whether it has a warehouse row; `warehouseFindMany` stands for "the stores that have one"
  prisma: {
    warehouse: {
      findFirst: async ({ where }: { where: { storeId: string } }) => ({ storeId: where.storeId }),
    },
  },
  acrossStores: async (fn: (storeId: string) => Promise<unknown>) => {
    const rows = (await h.warehouseFindMany()) as Array<{ storeId: string }>;
    for (const r of rows) await fn(r.storeId);
    return [];
  },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({ storeId, backend: 'pg', db: {} }),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
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
  h.scopes.length = 0;
  h.runInStoreScope.mockImplementation((storeId: string, fn: () => unknown) => {
    h.scopes.push(storeId);
    return fn();
  });
});

describe('sweepAllWarehouseStores', () => {
  it('enumerates stores with warehouses across stores and reconciles each WITHOUT a whole-store runInTenantContext wrapper', async () => {
    h.warehouseFindMany.mockResolvedValue([{ storeId: 's1' }, { storeId: 's2' }]);
    h.backfillReconcileAll.mockResolvedValue({ skusReconciled: 2, skusFailed: 0 });

    const result = await sweepAllWarehouseStores(stepStub);

    expect(h.warehouseFindMany).toHaveBeenCalled();
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('s1');
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('s2');
    // #936: no whole-store 30s transaction ceiling — backfillReconcileAll
    // (and reconcileWarehouseStockToAggregate underneath it) scope RLS
    // per-query/per-SKU themselves.
    expect(h.runInTenant).not.toHaveBeenCalled();
    // issue 2081: …but every store's work IS tenant-scoped, per query, via
    // runInStoreScope — not left to allow-contextless RLS policies.
    expect(h.scopes).toEqual(['s1', 's2']);

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

describe('reconcile failures are alerted (issue 2081)', () => {
  it('pages P1 when a whole store fails', async () => {
    h.warehouseFindMany.mockResolvedValue([{ storeId: 'bad' }, { storeId: 'good' }]);
    h.backfillReconcileAll.mockImplementation((storeId: string) =>
      storeId === 'bad'
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ skusReconciled: 1, skusFailed: 0 })
    );
    await sweepAllWarehouseStores(stepStub);
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'warehouse.reconcile_sweep' })
    );
  });

  it('sends an info alert when only SKUs failed, and nothing on a clean night', async () => {
    h.warehouseFindMany.mockResolvedValue([{ storeId: 's1' }]);
    h.backfillReconcileAll.mockResolvedValue({ skusReconciled: 1, skusFailed: 2 });
    await sweepAllWarehouseStores(stepStub);
    expect(h.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'info' }));
    h.sendAlert.mockClear();
    h.backfillReconcileAll.mockResolvedValue({ skusReconciled: 1, skusFailed: 0 });
    await sweepAllWarehouseStores(stepStub);
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});

describe('reconcileOneStoreOnDemand', () => {
  it('reconciles the single requested store WITHOUT a whole-store runInTenantContext wrapper', async () => {
    h.backfillReconcileAll.mockResolvedValue({ skusReconciled: 5, skusFailed: 1 });

    const result = await reconcileOneStoreOnDemand('s1', 'admin-1', stepStub);

    expect(h.runInTenant).not.toHaveBeenCalled();
    expect(h.scopes).toEqual(['s1']); // issue 2081
    expect(h.backfillReconcileAll).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ skusReconciled: 5, skusFailed: 1 });
  });

  it('propagates a rejection (no fail-soft for the single-store on-demand path)', async () => {
    h.backfillReconcileAll.mockRejectedValue(new Error('boom'));

    await expect(reconcileOneStoreOnDemand('s1', undefined, stepStub)).rejects.toThrow('boom');
  });
});
