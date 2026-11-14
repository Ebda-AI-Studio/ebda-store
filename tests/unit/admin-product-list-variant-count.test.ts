/**
 * W1a re-review minor 4: the admin size pickers (new order, payment link) keyed
 * on the `hasVariants` column while the API's VARIANT_REQUIRED gates key on the
 * variant ROWS. If the two drift, the API refuses and the UI shows no picker.
 * The admin product list now ships `variantCount` (every row, disabled ones
 * included — the gates' own count) and its stock total keys on it too.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prisma: {
    product: {
      findMany: vi.fn(async () => [
        // Column drifted: says no variants, but two rows exist.
        { id: 'p1', hasVariants: false, inventory: 0, _count: { variants: 2 } },
        { id: 'p2', hasVariants: false, inventory: 7, _count: { variants: 0 } },
      ]),
      count: vi.fn(async () => 2),
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => ({})),
    },
    inventoryHistory: { createMany: vi.fn(async () => ({ count: 0 })) }, // INV-AUDIT-3 movement rows
    productVariant: {
      groupBy: vi.fn(async () => [{ productId: 'p1', _sum: { inventory: 5 } }]),
    },
  },
  hasTenantContext: () => false,
}));

const { ProductService } = await import('@api/services/product.service');
const { prisma } = await import('@ebda/database');

describe('ProductService.list (admin) — variantCount', () => {
  it('asks for the variant row count and ships it as variantCount', async () => {
    const { products } = await ProductService.list('store-1');
    const include = vi.mocked(prisma.product.findMany).mock.calls[0][0]!.include as Record<
      string,
      unknown
    >;
    expect(include._count).toEqual({ select: { variants: true } });
    expect(products.map(p => [p.id, p.variantCount])).toEqual([
      ['p1', 2],
      ['p2', 0],
    ]);
    expect(products[0]).not.toHaveProperty('_count');
  });

  it('the stock total keys on the rows, not the drifted column', async () => {
    const { products } = await ProductService.list('store-1');
    expect(products.map(p => [p.id, p.totalInventory])).toEqual([
      ['p1', 5],
      ['p2', 7],
    ]);
  });
});

describe('ProductService.bulkUpdate — a variant product is never written as simple (W1b fix round)', () => {
  it('a drifted hasVariants=false product WITH variant rows is skipped by a bulk stock set', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce([
      { id: 'p1', price: 100, inventory: 0, _count: { variants: 2 } },
      { id: 'p2', price: 100, inventory: 7, _count: { variants: 0 } },
    ] as never);
    vi.mocked(prisma.product.updateMany).mockClear();
    const r = await ProductService.bulkUpdate('store-1', ['p1', 'p2'], {
      inventory: { mode: 'set', value: 5 },
    });
    expect(r.skippedVariantProducts).toBe(1);
    const select = vi.mocked(prisma.product.findMany).mock.calls.at(-1)![0]!.select as Record<
      string,
      unknown
    >;
    expect(select._count).toEqual({ select: { variants: true } });
    const written = vi
      .mocked(prisma.product.updateMany)
      .mock.calls.map(c => (c[0] as { where: { id: { in: string[] } } }).where.id.in);
    expect(written).toEqual([['p2']]);
    // Only the simple product's movement is recorded; the skipped variant product writes no history row.
    const rows = vi.mocked(prisma.inventoryHistory.createMany).mock.calls.at(-1)![0] as {
      data: Array<{ productId: string }>;
    };
    expect(rows.data.map(d => d.productId)).toEqual(['p2']);
  });
});
