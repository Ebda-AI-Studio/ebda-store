/**
 * Search program P1 (Task 8): the autofill core fills products.search_terms through
 * generateProductSearchTerms. Merchant words always win: 'human' provenance, and legacy
 * words saved before the field was AI-managed (no provenance entry), are never touched.
 * Prisma, AIService and the generator are fakes (no DB, no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

let productRow: Record<string, unknown>;
const updateSpy = vi.fn(async () => ({}));
const categoryFindMany = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: {
    product: {
      findFirst: vi.fn(async () => productRow),
      update: (...a: unknown[]) => updateSpy(...(a as [])),
    },
    category: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
    productCategory: { createMany: vi.fn() },
  },
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => ({ name: 'Shop', nameAr: 'متجر' }) } }),
  hasTenantContext: () => false,
  runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  onClosedTenantTxAccess: vi.fn(),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));

const translate = vi.fn();
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: {
    translate: (...a: unknown[]) => translate(...a),
    suggestSeo: vi.fn(),
    suggestCategories: vi.fn(),
  },
}));

const config = { googleAiKey: 'test-key' };
vi.mock('../../apps/api/src/config', () => ({ config }));

const generateProductSearchTerms = vi.fn();
vi.mock('../../apps/api/src/lib/ai/product-search-terms-generator', () => ({
  generateProductSearchTerms: (...a: unknown[]) => generateProductSearchTerms(...a),
}));

const { fillProductFields } = await import('../../apps/api/src/services/ai-autofill.service');

/** Every other AI field merchant-owned, so only searchTerms is ever in the fill set. */
const baseProduct = {
  id: 'p1',
  storeId: 's1',
  name: 'Leather sneakers',
  nameAr: 'كوتشي جلد',
  description: 'White leather sneakers',
  descriptionAr: 'كوتشي جلد أبيض',
  metaTitle: 't',
  metaTitleAr: 't',
  metaDescription: 'd',
  metaDescriptionAr: 'd',
  categories: [{ categoryId: 'c1' }],
};
const humanSources = {
  name: 'human',
  nameAr: 'human',
  description: 'human',
  descriptionAr: 'human',
  metaTitle: 'human',
  metaTitleAr: 'human',
  metaDescription: 'human',
  metaDescriptionAr: 'human',
};

beforeEach(() => {
  updateSpy.mockClear();
  translate.mockReset();
  generateProductSearchTerms.mockReset();
  generateProductSearchTerms.mockResolvedValue('جزمه, gazma, shoes');
  categoryFindMany.mockReset();
  categoryFindMany.mockResolvedValue([{ name: 'Shoes', nameAr: 'أحذية' }]);
  config.googleAiKey = 'test-key';
  delete process.env.GEMINI_MODEL;
});

describe('fillProductFields — searchTerms', () => {
  it('fills empty searchTerms and stamps it ai', async () => {
    productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          searchTerms: 'جزمه, gazma, shoes',
          aiFieldSources: expect.objectContaining({ searchTerms: 'ai' }),
        }),
      })
    );
  });

  it('passes both languages, store-scoped category names, the configured key and a *-latest model', async () => {
    productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(categoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: 's1', id: { in: ['c1'] } } })
    );
    expect(generateProductSearchTerms).toHaveBeenCalledWith(
      {
        storeId: 's1',
        storeName: 'متجر',
        product: {
          name: 'Leather sneakers',
          nameAr: 'كوتشي جلد',
          description: 'White leather sneakers',
          descriptionAr: 'كوتشي جلد أبيض',
        },
        categoryNames: ['أحذية', 'Shoes'],
      },
      'test-key',
      'gemini-flash-lite-latest'
    );
  });

  it('honours GEMINI_MODEL', async () => {
    process.env.GEMINI_MODEL = 'gemini-flash-latest';
    productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(generateProductSearchTerms.mock.calls[0][2]).toBe('gemini-flash-latest');
  });

  it('never overwrites merchant words', async () => {
    productRow = {
      ...baseProduct,
      searchTerms: 'كوتشي',
      aiFieldSources: { ...humanSources, searchTerms: 'human' },
    };
    await fillProductFields('s1', 'p1', { op: 'update', changedFields: ['nameAr'] });
    expect(generateProductSearchTerms).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('never overwrites legacy merchant words saved before the field was AI-managed (no provenance)', async () => {
    productRow = {
      ...baseProduct,
      searchTerms: 'kotshy, كوتشي',
      aiFieldSources: { ...humanSources },
    };
    await fillProductFields('s1', 'p1', { op: 'sweep', refreshStale: true });
    expect(generateProductSearchTerms).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('refreshes AI-owned words when a source changes', async () => {
    productRow = {
      ...baseProduct,
      searchTerms: 'old, words',
      aiFieldSources: { ...humanSources, searchTerms: 'ai' },
    };
    await fillProductFields('s1', 'p1', { op: 'update', changedFields: ['descriptionAr'] });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ searchTerms: 'جزمه, gazma, shoes' }),
      })
    );
  });

  it('leaves AI-owned words alone when no source changed', async () => {
    productRow = {
      ...baseProduct,
      searchTerms: 'old, words',
      aiFieldSources: { ...humanSources, searchTerms: 'ai' },
    };
    await fillProductFields('s1', 'p1', { op: 'update', changedFields: ['price'] });
    expect(generateProductSearchTerms).not.toHaveBeenCalled();
  });

  it('skips when no Gemini key is configured (no call, no stamp)', async () => {
    config.googleAiKey = '';
    productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(generateProductSearchTerms).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('skips when the product has no name in either language', async () => {
    productRow = {
      ...baseProduct,
      name: '',
      nameAr: null,
      searchTerms: null,
      aiFieldSources: { ...humanSources },
    };
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(generateProductSearchTerms).not.toHaveBeenCalled();
  });

  it('a null reply writes nothing and leaves the field fillable (no ai stamp)', async () => {
    generateProductSearchTerms.mockResolvedValue(null);
    productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('a quota cap defers the words but keeps the other writes of the same run', async () => {
    const capErr = Object.assign(new Error('cap'), { code: 'AI_QUOTA_STORE_DAILY_EXCEEDED' });
    generateProductSearchTerms.mockRejectedValue(capErr);
    translate.mockResolvedValue({ translation: 'Leather sneakers', cached: false });
    productRow = {
      ...baseProduct,
      name: '',
      searchTerms: null,
      aiFieldSources: { ...humanSources, name: undefined },
    };
    await fillProductFields('s1', 'p1', { op: 'create' });
    const data = (updateSpy.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data.name).toBe('Leather sneakers');
    expect(data).not.toHaveProperty('searchTerms');
    expect((data.aiFieldSources as Record<string, string>).searchTerms).toBeUndefined();
  });
});
