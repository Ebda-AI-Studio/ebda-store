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

const { catalogueMaxPrice, priceRangeWhere } = await import('@api/services/product.service');

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

describe('priceRangeWhere: match what the shopper can actually buy (PL1)', () => {
  it('a product matches when ANY active variant (own price, else inherited) or, with none, its base price is in range', () => {
    const w = priceRangeWhere(100, 500_000) as { OR: Array<Record<string, unknown>> };
    const range = { gte: 100, lte: 500_000 };
    expect(w.OR[0]).toEqual({ variants: { none: { isActive: true } }, price: range });
    expect(w.OR[1]).toEqual({
      variants: {
        some: {
          isActive: true,
          OR: [{ price: range }, { price: null, product: { price: range } }],
        },
      },
    });
  });
  it('an open-ended side stays open (only max, only min)', () => {
    const only = (w: unknown) =>
      ((w as { OR: Array<{ price?: object }> }).OR[0] as { price: object }).price;
    expect(only(priceRangeWhere(undefined, 500_000))).toEqual({ lte: 500_000 });
    expect(only(priceRangeWhere(100, undefined))).toEqual({ gte: 100 });
  });
});

describe('meta.priceMax is opt-in (Ruling SEARCH-T12-2: the default listing payload is unchanged)', () => {
  it('the list endpoint accepts withPriceMax and forwards it only when it is "1"', async () => {
    const { readFileSync } = await import('node:fs');
    const { PUBLIC_PRODUCT_LIST_QUERY_KEYS } = await import('@api/lib/query-params');
    expect(PUBLIC_PRODUCT_LIST_QUERY_KEYS).toContain('withPriceMax');
    const route = readFileSync('apps/api/src/routes/public.routes.ts', 'utf8');
    expect(route).toMatch(/withPriceMax: req\.query\.withPriceMax === '1' \? true : undefined/);
  });

  it('the service computes and emits priceMax only on request (never in the default meta)', async () => {
    const { readFileSync } = await import('node:fs');
    const svc = readFileSync('apps/api/src/services/product.service.ts', 'utf8');
    // both listing paths: gated on the option, and the key is spread in only when defined
    expect(svc.match(/options\.withPriceMax/g)?.length).toBeGreaterThanOrEqual(2);
    expect(svc.match(/\.\.\.\(priceMax !== undefined \? \{ priceMax \} : \{\}\)/g)).toHaveLength(2);
    expect(svc).not.toMatch(/^\s+priceMax,\s*$/m);
  });

  it('the storefront PLP asks for it on its server fetch', async () => {
    const { readFileSync } = await import('node:fs');
    const body = readFileSync('apps/web/src/app/products/ProductsPageBody.tsx', 'utf8');
    expect(body).toMatch(/withPriceMax: '1'/);
  });
});
