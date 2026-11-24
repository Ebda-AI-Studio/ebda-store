/** STORE-QA-59: the Postgres createAdjustment path refuses a product-only line for a product with variants. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  variantFindMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../lib/repo-factory', () => ({ storeStock: async () => null, storeDb: vi.fn() }));
vi.mock('./assert-store-owns', () => ({ assertStoreOwnsInTenantScope: async () => undefined }));
vi.mock('../sequence.service', () => ({ nextSequence: async () => 'ADJ-1' }));
vi.mock('@ebda/database', () => ({
  prisma: {
    product: { findMany: m.productFindMany },
    productVariant: { findMany: m.variantFindMany },
    stockAdjustment: { create: m.create },
  },
  Prisma: {},
  withMoneyTx: vi.fn(),
}));

import { createAdjustment } from './stock-adjustment.service';

const input = (items: Array<{ productId: string; variantId?: string; newQty: number }>) => ({
  storeId: 's1',
  type: 'cycle_count' as const,
  items,
});

describe('createAdjustment variant guard (Postgres path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.variantFindMany.mockResolvedValue([]);
    m.create.mockResolvedValue({ id: 'adj1' });
  });

  it('422 VARIANT_REQUIRED for a product-only line on a product with variants, writes nothing', async () => {
    m.productFindMany.mockResolvedValue([
      { id: 'p1', inventory: 0, costPrice: 0, _count: { variants: 2 } },
    ]);
    await expect(createAdjustment(input([{ productId: 'p1', newQty: 18 }]))).rejects.toMatchObject({
      statusCode: 422,
      code: 'VARIANT_REQUIRED',
    });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('accepts a product-only line for a simple product and a variant line for a variant product', async () => {
    m.productFindMany.mockResolvedValue([
      { id: 'p2', inventory: 5, costPrice: 10, _count: { variants: 0 } },
    ]);
    m.variantFindMany.mockResolvedValue([
      { id: 'v1', productId: 'p1', inventory: 7, costPrice: 10 },
    ]);
    await createAdjustment(
      input([
        { productId: 'p2', newQty: 9 },
        { productId: 'p1', variantId: 'v1', newQty: 9 },
      ])
    );
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});
