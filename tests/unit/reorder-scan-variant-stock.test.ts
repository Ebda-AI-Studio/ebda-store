/**
 * #1100 — the reorder scan must read a variant product's stock from its
 * variants, not from the parent `products.inventory` column (held at 0 for
 * every variant product since migration 20260830090000). Before the fix a
 * variant product with 500 units scanned as onHand=0 and became a false
 * reorder candidate (and a Gemini call).
 *
 * Owner decision 2026-10-01: the unit is now each ACTIVE variant (one
 * suggestion per variant, keyed (store, product, variant)), so a variant's
 * onHand is its OWN stock. The DB-backed proof is
 * tests/integration/accounting/reorder-per-variant.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const upserted: Array<{ productId: string; variantId?: string | null; onHand: number }> = [];

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
    create: vi.fn(
      async ({
        data,
      }: {
        data: { productId: string; variantId: string | null; onHand: number };
      }) => {
        upserted.push({
          productId: data.productId,
          variantId: data.variantId,
          onHand: data.onHand,
        });
        return data;
      }
    ),
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

  it('asks Prisma for each variant with its stock AND isActive flag', async () => {
    findMany.mockResolvedValue([]);
    await runReorderScan('store-1');
    const select = findMany.mock.calls[0][0].select;
    expect(select.variants.select).toMatchObject({ id: true, inventory: true, isActive: true });
  });

  it('does not suggest a reorder for a well-stocked variant product whose parent column is 0', async () => {
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'variant-product',
        inventory: 0,
        variants: [
          { id: 'v1', title: 'A', inventory: 300 },
          { id: 'v2', title: 'B', inventory: 200 },
        ],
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
    expect(upserted).toEqual([{ productId: 'plain-product', variantId: null, onHand: 0 }]);
  });

  it('suggests each low variant with its OWN stock as onHand (not the product sum)', async () => {
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'low-variant',
        inventory: 0,
        variants: [
          { id: 'v1', title: 'A', inventory: 1 },
          { id: 'v2', title: 'B', inventory: 2 },
        ],
      },
    ]);
    await runReorderScan('store-1');
    expect(upserted).toEqual([
      { productId: 'low-variant', variantId: 'v1', onHand: 1 },
      { productId: 'low-variant', variantId: 'v2', onHand: 2 },
    ]);
  });

  // Ruling M5-6 (#1103): a disabled variant's units are not sellable stock.
  it('never makes a disabled variant a unit', async () => {
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'disabled-variant',
        inventory: 0,
        variants: [
          { id: 'v-on', title: 'On', inventory: 2, isActive: true },
          // Low enough to be a candidate if it were scanned — it must not be.
          { id: 'v-off', title: 'Off', inventory: 0, isActive: false },
        ],
      },
    ]);
    await runReorderScan('store-1');
    expect(upserted).toEqual([{ productId: 'disabled-variant', variantId: 'v-on', onHand: 2 }]);
  });

  it('a product whose variants are ALL disabled scans as nothing — never its parent column', async () => {
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'all-off',
        inventory: 0,
        variants: [{ id: 'v-off', title: 'Off', inventory: 0, isActive: false }],
      },
    ]);
    const result = await runReorderScan('store-1');
    expect(result.suggested).toBe(0);
    expect(upserted).toEqual([]);
  });

  // Issue 2344: supplier resolution is product-level — once per product, not
  // once per variant unit.
  it('looks up the last-PO supplier and its lead time once per product, not per variant', async () => {
    tx.purchaseOrderItem.findFirst.mockClear();
    tx.supplier.findUnique.mockClear();
    tx.purchaseOrderItem.findFirst.mockResolvedValue({ po: { supplierId: 'sup-1' } } as never);
    tx.supplier.findUnique.mockResolvedValue({ leadTimeDays: 10 } as never);
    const variants = Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`,
      title: `V${i}`,
      inventory: 0,
    }));
    findMany.mockResolvedValue([
      { ...base, id: 'many-variants', inventory: 0, variants },
      { ...base, id: 'other', inventory: 0, variants: [] },
    ]);
    await runReorderScan('store-1');
    // 30 variant units over two chunks + 1 plain product = 2 products → 2 lookups.
    expect(tx.purchaseOrderItem.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.supplier.findUnique).toHaveBeenCalledTimes(1); // one supplier
    tx.purchaseOrderItem.findFirst.mockResolvedValue(null);
    tx.supplier.findUnique.mockResolvedValue(null);
  });
});
