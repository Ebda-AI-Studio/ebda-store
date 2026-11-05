/**
 * #937 — setStock/adjustStock lock warehouse_stock then the aggregate row;
 * reconcile locks them in the opposite order. Postgres picks the deadlock
 * victim arbitrarily, so when a merchant's stock edit loses it must retry the
 * whole transaction instead of surfacing a raw 40P01 as a 500.
 *
 * The real-Postgres race lives in tests/integration/warehouse/reconcile.test.ts
 * but cannot force WHICH side loses; this test forces it deterministically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // What Prisma throws for a deadlock inside a raw query: P2010 with the
  // SQLSTATE nested at meta.code (see lib/db-retry.ts extractRetryCodes).
  const deadlock = () =>
    Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } });
  const tx = {
    $queryRaw: vi.fn(async () => [{ quantity: 7 }]),
    $executeRaw: vi.fn(async () => 1),
    warehouseStock: { findFirst: vi.fn(async () => ({ quantity: 5 })) },
    inventoryHistory: { create: vi.fn(async () => ({})) },
  };
  return {
    deadlock,
    tx,
    withMoneyTx: vi.fn(),
    warehouseFindFirst: vi.fn(async () => ({ id: 'wh-1', code: 'MAIN' })),
    productFindFirst: vi.fn(async () => ({ id: 'prod-1' })),
  };
});

vi.mock('@ebda/database', () => ({
  prisma: {
    warehouse: { findFirst: h.warehouseFindFirst },
    product: { findFirst: h.productFindFirst },
    productVariant: { count: vi.fn(async () => 0) },
  },
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
  withRlsBypass: vi.fn(),
  withMoneyTx: h.withMoneyTx,
  afterTxCommit: () => false, // no hook registry: notifyAfterCommit notifies immediately
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn(async () => {}) }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { WarehouseService } from '@api/services/warehouse.service';

/** First attempt dies as the deadlock victim; the second runs the body. */
function loseTheFirstDeadlock() {
  let attempt = 0;
  h.withMoneyTx.mockImplementation(async (_client: unknown, fn: (tx: typeof h.tx) => unknown) => {
    attempt++;
    if (attempt === 1) throw h.deadlock();
    return fn(h.tx);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('warehouse stock writers retry a lost deadlock (#937)', () => {
  it('adjustStock re-runs its transaction and returns the committed quantity', async () => {
    loseTheFirstDeadlock();
    await expect(
      WarehouseService.adjustStock('store-1', 'wh-1', { productId: 'prod-1', delta: 2 })
    ).resolves.toEqual({ newQuantity: 7 });
    expect(h.withMoneyTx).toHaveBeenCalledTimes(2);
    // The audit row is written once — by the attempt that committed.
    expect(h.tx.inventoryHistory.create).toHaveBeenCalledTimes(1);
  });

  it('setStock re-runs its transaction instead of throwing 40P01', async () => {
    loseTheFirstDeadlock();
    await expect(
      WarehouseService.setStock('store-1', 'wh-1', { productId: 'prod-1', quantity: 9 })
    ).resolves.toBeUndefined();
    expect(h.withMoneyTx).toHaveBeenCalledTimes(2);
  });

  it('does not retry a business error (control)', async () => {
    h.withMoneyTx.mockImplementation(async () => {
      throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    });
    await expect(
      WarehouseService.adjustStock('store-1', 'wh-1', { productId: 'prod-1', delta: 1 })
    ).rejects.toThrow('not found');
    expect(h.withMoneyTx).toHaveBeenCalledTimes(1);
  });
});
