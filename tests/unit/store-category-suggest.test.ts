/**
 * AI category suggestions for a store that has none, derived from its products. The model only PROPOSES; the
 * merchant accepts or edits; nothing is created until apply. Product text is merchant data (a JSON string field in
 * the prompt, never instructions); the model sees product names/descriptions only (no customers, orders or reviews);
 * every id it returns is checked against the products we actually showed it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  catCount: vi.fn(),
  catFindMany: vi.fn(),
  catCreate: vi.fn(),
  prodFindMany: vi.fn(),
  pcCreateMany: vi.fn(),
  propose: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tx = {
    category: { count: m.catCount, findMany: m.catFindMany, create: m.catCreate },
    product: { findMany: m.prodFindMany },
    productCategory: { createMany: m.pcCreateMany },
  };
  return {
    ...actual,
    prisma: {
      ...tx,
      $transaction: (arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : (arg as (t: unknown) => unknown)(tx),
    },
  };
});
vi.mock('@api/services/ai.service', () => ({ AIService: { proposeStoreCategories: m.propose } }));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreCategoriesCaches: m.invalidate }));
vi.mock('@api/middleware/security', () => ({ auditLog: m.audit }));

import {
  proposeStoreCategories,
  applyStoreCategories,
} from '@api/services/store-category-suggest.service';

const P = (id: string, name: string) => ({
  id,
  name,
  nameAr: null,
  description: `desc ${name} ${'x'.repeat(400)}`,
});
beforeEach(() => {
  vi.resetAllMocks();
  m.catCount.mockResolvedValue(0);
  m.catFindMany.mockResolvedValue([]);
  m.catCreate.mockImplementation(async ({ data }: any) => ({ id: `c-${data.slug}`, ...data }));
  m.pcCreateMany.mockResolvedValue({ count: 0 });
});

describe('proposeStoreCategories', () => {
  it('only runs for a store with no categories, and only when there are products', async () => {
    m.catCount.mockResolvedValue(2);
    expect(await proposeStoreCategories('s1')).toMatchObject({
      ok: false,
      status: 409,
      code: 'CATEGORIES_EXIST',
    });
    m.catCount.mockResolvedValue(0);
    m.prodFindMany.mockResolvedValue([]);
    expect(await proposeStoreCategories('s1')).toMatchObject({
      ok: false,
      status: 409,
      code: 'NO_PRODUCTS',
    });
    expect(m.propose).not.toHaveBeenCalled();
  });

  it('sends the model product text only (clipped), scoped to the store', async () => {
    m.prodFindMany.mockResolvedValue([P('p1', 'Blue shirt')]);
    m.propose.mockResolvedValue({ categories: [] });
    await proposeStoreCategories('s1');
    expect(m.prodFindMany.mock.calls[0][0].where).toMatchObject({ storeId: 's1', deletedAt: null });
    const sent = m.propose.mock.calls[0][0];
    expect(sent.storeId).toBe('s1');
    expect(Object.keys(sent.products[0]).sort()).toEqual(['description', 'id', 'name', 'nameAr']);
    expect(sent.products[0].description.length).toBeLessThanOrEqual(160);
  });

  it('keeps only ids it showed the model, one category per product, no empty or duplicate categories', async () => {
    m.prodFindMany.mockResolvedValue([P('p1', 'Shirt'), P('p2', 'Shoes'), P('p3', 'Cap')]);
    m.propose.mockResolvedValue({
      categories: [
        { name: ' Clothes ', nameAr: 'ملابس', productIds: ['p1', 'p3', 'FOREIGN'] },
        { name: 'clothes', nameAr: '', productIds: ['p2'] },
        { name: 'Footwear', nameAr: 'أحذية', productIds: ['p2', 'p1'] },
        { name: 'Ghost', nameAr: '', productIds: ['nope'] },
      ],
    });
    const r = await proposeStoreCategories('s1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.categories.map(c => [c.name, c.products.map(p => p.id)])).toEqual([
      ['Clothes', ['p1', 'p3']],
      ['Footwear', ['p2']],
    ]);
    expect(r.value.unassigned).toBe(0);
  });
});

describe('applyStoreCategories', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  it('creates the categories with unique slugs and links only this store’s products', async () => {
    m.prodFindMany.mockResolvedValue([{ id: uuid(1) }]);
    m.catFindMany.mockResolvedValue([{ slug: 'clothes' }]); // taken
    const r = await applyStoreCategories({
      storeId: 's1',
      userId: 'u1',
      categories: [{ name: 'Clothes', nameAr: 'ملابس', productIds: [uuid(1), uuid(2)] }],
    });
    expect(r.ok).toBe(true);
    expect(m.catCreate.mock.calls[0][0].data).toMatchObject({
      storeId: 's1',
      name: 'Clothes',
      slug: 'clothes-1',
    });
    expect(m.prodFindMany.mock.calls[0][0].where).toMatchObject({
      storeId: 's1',
      id: { in: [uuid(1), uuid(2)] },
    });
    expect(m.pcCreateMany.mock.calls[0][0].data).toEqual([
      // the service generates the category id (one atomic batch cannot read a generated id back)
      { productId: uuid(1), categoryId: m.catCreate.mock.calls[0][0].data.id, position: 0 },
    ]);
    expect(m.catCreate.mock.calls[0][0].data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.invalidate).toHaveBeenCalledWith('s1');
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'category.created_from_ai_suggestion' })
    );
  });

  it('rejects two categories with the same name, and anything over the limits, creating nothing', async () => {
    const dup = await applyStoreCategories({
      storeId: 's1',
      userId: 'u1',
      categories: [
        { name: 'A', nameAr: '', productIds: [] },
        { name: ' a ', nameAr: '', productIds: [] },
      ],
    });
    expect(dup).toMatchObject({ ok: false, status: 422 });
    const bad = await applyStoreCategories({
      storeId: 's1',
      userId: 'u1',
      categories: [{ name: 'x'.repeat(61), nameAr: '', productIds: [] }] as never,
    });
    expect(bad).toMatchObject({ ok: false, status: 422 });
    expect(m.catCreate).not.toHaveBeenCalled();
  });
});
