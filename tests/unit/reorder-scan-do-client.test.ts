/**
 * 2026-11-09 P1: `stock-reorder-scan-cron` failed on every DO store with "DO client: $queryRaw is not available on the StoreDO
 * read path". `sumOrderQty` probed the client with `typeof tx.$queryRaw`, and the DO read client THROWS on any `$`-prefixed
 * property (packages/repo/src/rpc/client.ts), so the feature probe itself was the crash. The scan must decide the DO path from the
 * money client it already holds, never by touching a raw-SQL member of the read client.
 */
import { describe, it, expect, vi } from 'vitest';

const upsert = vi.fn(async (a: { items: unknown[] }) => ({ upserted: a.items.length }));

// Same behaviour as createDoClient's proxy: any `$x` member throws, models resolve to delegates.
const orderItemAggregate = vi.fn(async () => ({ _sum: { quantity: 20 } }));
const doDb = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop === 'symbol' || prop === 'then') return undefined;
    if (prop[0] === '$')
      throw new Error(`DO client: ${prop} is not available on the StoreDO read path`);
    if (prop === 'product')
      return {
        findMany: async () => [
          {
            id: 'p1',
            name: 'P',
            nameAr: null,
            sku: null,
            inventory: 0,
            variants: [],
            lowStockThreshold: 5,
            reorderRules: [],
          },
        ],
      };
    if (prop === 'orderItem') return { aggregate: orderItemAggregate };
    if (prop === 'returnItem') return { aggregate: async () => ({ _sum: { quantity: null } }) };
    if (prop === 'purchaseOrderItem')
      return {
        findFirst: async () => null,
        aggregate: async () => ({ _sum: { qty: null, qtyReceived: null } }),
      };
    if (prop === 'backorderLine')
      return { aggregate: async () => ({ _sum: { qty: null, qtyFulfilled: null } }) };
    return {};
  },
});
const money = {
  reorderExpire: async () => ({ expired: 0, variantlessOpenPoLines: 0 }),
  reorderUpsert: upsert,
};

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeMoney: vi.fn(async () => money),
  storeDb: vi.fn(async () => doDb),
}));
vi.mock('@ebda/database', async () => ({
  ...(await import('./helpers/database-mock')).databaseMock({ prisma: {} }),
}));
vi.mock('../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({ items: [] })),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runReorderScan } from '../../apps/api/src/services/accounting/reorder-scan.service';

describe('runReorderScan on a StoreDO store', () => {
  it('sums velocity through orderItem.aggregate and never touches a $-member of the read client', async () => {
    const r = await runReorderScan('store-do');
    expect(orderItemAggregate).toHaveBeenCalledTimes(2); // 7d + 28d
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(r.suggested).toBe(1);
  });
});
