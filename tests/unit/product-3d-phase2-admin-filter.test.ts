/**
 * 3D viewer phase 2: the admin products list "has 3D model" filter reaches the query as a
 * ProductModel relation predicate (1:1 on productId), tri-state: absent = no predicate.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prisma: {
    product: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    productVariant: { groupBy: vi.fn(async () => []) },
  },
  hasTenantContext: () => false,
}));

const { ProductService } = await import('@api/services/product.service');
const { prisma } = await import('@ebda/database');

const whereOf = () =>
  vi.mocked(prisma.product.findMany).mock.calls.at(-1)![0]!.where as Record<string, unknown>;

describe('ProductService.list — has3d filter', () => {
  it('has3d=true keeps only products WITH a model', async () => {
    await ProductService.list('s1', { has3d: true });
    expect(whereOf().model3d).toEqual({ isNot: null });
  });
  it('has3d=false keeps only products WITHOUT a model', async () => {
    await ProductService.list('s1', { has3d: false });
    expect(whereOf().model3d).toEqual({ is: null });
  });
  it('absent adds no predicate (the default list is unchanged)', async () => {
    await ProductService.list('s1', {});
    expect(whereOf()).not.toHaveProperty('model3d');
  });
});
