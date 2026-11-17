/**
 * PL1: the price filter's slider ceiling comes from the store's real highest price, variant-aware.
 * Fails on main (catalogueMaxPrice does not exist; the web used a fixed 5,000).
 */
import { describe, it, expect, vi } from 'vitest';

const productAgg = vi.fn();
const variantAgg = vi.fn();
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeDb: async () => ({
    product: { aggregate: productAgg },
    productVariant: { aggregate: variantAgg },
  }),
}));

const { catalogueMaxPrice } = await import('@api/services/product.service');

describe('catalogueMaxPrice', () => {
  it('is the larger of the dearest product and the dearest variant, scoped to this store public active products', async () => {
    productAgg.mockResolvedValue({ _max: { price: 500_000 } });
    variantAgg.mockResolvedValue({ _max: { price: 740_000 } });
    expect(await catalogueMaxPrice('s1')).toBe(740_000);
    expect(productAgg.mock.calls[0]![0].where).toMatchObject({
      storeId: 's1',
      status: 'active',
      audience: 'public',
    });
    expect(variantAgg.mock.calls[0]![0].where.product).toMatchObject({ storeId: 's1' });
  });
  it('is 0 for an empty store or one with no variant prices (the web then keeps its default)', async () => {
    productAgg.mockResolvedValue({ _max: { price: null } });
    variantAgg.mockResolvedValue({ _max: { price: null } });
    expect(await catalogueMaxPrice('s1')).toBe(0);
    productAgg.mockResolvedValue({ _max: { price: 90_000 } });
    expect(await catalogueMaxPrice('s1')).toBe(90_000);
  });
});
