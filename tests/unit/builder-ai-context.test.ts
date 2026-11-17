/**
 * The page-builder AI's view of a store: scoped to the store, public active products only, bounded, and
 * the allow-list is exactly what was shown (so a reference the model invents is refused).
 */
import { describe, it, expect, vi } from 'vitest';

const productFind = vi.fn();
const categoryFind = vi.fn();
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: {
      findUnique: async () => ({
        name: 'Amelia',
        nameAr: 'أميليا',
        template: 'qamar',
        look: 'qamar.atelier',
      }),
    },
    product: { findMany: productFind },
    category: { findMany: categoryFind },
  }),
}));

const { loadBuilderAiCatalogue, AI_CONTEXT_MAX_PRODUCTS } =
  await import('@api/services/builder-ai-context.service');

describe('loadBuilderAiCatalogue', () => {
  it('reads public active products of this store only, bounded, and builds the allow-list from them', async () => {
    productFind.mockResolvedValue([
      {
        id: 'p-1',
        slug: 'ring',
        name: 'Ring',
        nameAr: 'خاتم',
        images: [{ url: 'https://cdn/p1.jpg' }],
      },
      { id: 'p-2', slug: 'chain', name: 'Chain', nameAr: null, images: [] },
    ]);
    categoryFind.mockResolvedValue([{ slug: 'rings', name: 'Rings', nameAr: 'خواتم' }]);
    const c = (await loadBuilderAiCatalogue('s1'))!;
    const where = productFind.mock.calls[0][0].where;
    expect(where).toMatchObject({
      storeId: 's1',
      status: 'active',
      deletedAt: null,
      audience: 'public',
    });
    expect(productFind.mock.calls[0][0].take).toBe(AI_CONTEXT_MAX_PRODUCTS);
    expect(c.allow.productIds).toEqual(new Set(['p-1', 'p-2']));
    expect(c.allow.categorySlugs).toEqual(new Set(['rings']));
    expect(c.allow.imageUrls).toEqual(new Set(['https://cdn/p1.jpg']));
    expect(c.allow.linkPaths.has('/products/ring')).toBe(true);
    expect(c.allow.linkPaths.has('/products?category=rings')).toBe(true);
    expect(c.allow.linkPaths.has('/products/ghost')).toBe(false);
    expect(c.store).toMatchObject({ name: 'Amelia', look: 'qamar.atelier' });
  });
});
