/**
 * #1100 — the reorder scan must read a variant product's stock from its
 * variants, not from the parent `products.inventory` column (held at 0 for
 * every variant product since migration 20260830090000). Before the fix a
 * variant product with 500 units scanned as onHand=0 and became a false
 * reorder candidate (and a Gemini call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const upserted: Array<{ productId: string; onHand: number }> = [];

const tx = {
  $executeRaw: vi.fn(async () => 0),
  // Each candidate's write runs inside SAVEPOINT / RELEASE (withSavepointOn).
  $executeRawUnsafe: vi.fn(async () => 0),
  $queryRaw: vi.fn(async () => [{ total: 0n }]),
  product: { findMany },
  purchaseOrderItem: {
    findFirst: vi.fn(async () => null),
    aggregate: vi.fn(async () => ({ _sum: { qty: null, qtyReceived: null } })),
  },
  supplier: { findUnique: vi.fn(async () => null) },
  backorderLine: {
    aggregate: vi.fn(async () => ({ _sum: { qty: null, qtyFulfilled: null } })),
  },
  reorderSuggestion: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: { productId: string; onHand: number } }) => {
      upserted.push({ productId: data.productId, onHand: data.onHand });
      return data;
    }),
    update: vi.fn(),
  },
};

vi.mock('@force/database', () => ({
  prisma: {},
  withRlsBypass: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
}));

vi.mock('../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({ items: [] })),
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runReorderScan } from '../../apps/api/src/services/accounting/reorder-scan.service';

const base = { name: 'P', nameAr: null, sku: null, lowStockThreshold: 5, reorderRules: [] };

describe('runReorderScan — variant-aware on-hand (#1100)', () => {
  beforeEach(() => {
    upserted.length = 0;
    findMany.mockReset();
  });

  it('asks Prisma for the variants so the stock can be summed', async () => {
    findMany.mockResolvedValue([]);
    await runReorderScan('store-1');
    const select = findMany.mock.calls[0][0].select;
    expect(select.variants).toEqual({ select: { inventory: true, isActive: true } });
  });

  it('does not suggest a reorder for a well-stocked variant product whose parent column is 0', async () => {
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'variant-product',
        inventory: 0,
        variants: [{ inventory: 300 }, { inventory: 200 }],
      },
    ]);
    const result = await runReorderScan('store-1');
    expect(result.suggested).toBe(0);
    expect(upserted).toEqual([]);
  });

  it('still suggests a reorder for an out-of-stock product with no variants (control)', async () => {
    findMany.mockResolvedValue([{ ...base, id: 'plain-product', inventory: 0, variants: [] }]);
    const result = await runReorderScan('store-1');
    expect(result.suggested).toBe(1);
    expect(upserted).toEqual([{ productId: 'plain-product', onHand: 0 }]);
  });

  it('reports the variant sum as onHand when a variant product is genuinely low', async () => {
    findMany.mockResolvedValue([
      { ...base, id: 'low-variant', inventory: 0, variants: [{ inventory: 1 }, { inventory: 2 }] },
    ]);
    await runReorderScan('store-1');
    expect(upserted).toEqual([{ productId: 'low-variant', onHand: 3 }]);
  });

  // Ruling M5-6 (#1103): a disabled variant's units are not sellable stock.
  it('leaves a disabled variant out of onHand', async () => {
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'disabled-variant',
        inventory: 0,
        variants: [
          { inventory: 2, isActive: true },
          { inventory: 500, isActive: false },
        ],
      },
    ]);
    await runReorderScan('store-1');
    expect(upserted).toEqual([{ productId: 'disabled-variant', onHand: 2 }]);
  });
});
