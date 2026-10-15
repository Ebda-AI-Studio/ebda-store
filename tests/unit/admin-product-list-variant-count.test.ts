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
    },
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
