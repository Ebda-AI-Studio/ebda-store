/**
 * Search program P1 (Task 8): the autofill core fills products.search_terms through
 * generateProductSearchTerms. Merchant words always win: 'human' provenance, and legacy
 * words saved before the field was AI-managed (no provenance entry), are never touched.
 * Prisma, AIService and the generator are fakes (no DB, no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  isStoreAiEnabled: async () => true,
  assertStoreAiEnabled: async () => undefined,
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
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
    $queryRaw: vi.fn(async () => []),
    category: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
    productCategory: { createMany: vi.fn() },
  },
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => ({ name: 'Shop', nameAr: 'متجر' }) } }),
  hasTenantContext: () => false,
  runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  onClosedTenantTxAccess: vi.fn(),
}));
// The autofill core reads through storeDb and writes through storeWriter/storeRepo (CF-JOBS-4): a Postgres store, faked.
const fakeDb = () => ({
  product: {
    findFirst: async () => productRow,
    update: (...a: unknown[]) => updateSpy(...(a as [])),
  },
  store: { findUnique: async () => ({ name: 'Shop', nameAr: 'متجر', theme: {} }) },
  category: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
  productCategory: { createMany: vi.fn() },
});
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => fakeDb(),
  storeWriter: async () => fakeDb(),
  storeRepo: async () => ({ backend: 'pg' }),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));

const translate = vi.fn();
const suggestCategories = vi.fn();
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: {
    translate: (...a: unknown[]) => translate(...a),
    suggestSeo: vi.fn(),
    suggestCategories: (...a: unknown[]) => suggestCategories(...a),
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
  suggestCategories.mockReset();
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

  it('M8: on a product with no category, the words use the categories picked in the same run', async () => {
    productRow = {
      ...baseProduct,
      categories: [],
      searchTerms: null,
      aiFieldSources: { ...humanSources },
    };
    categoryFindMany.mockResolvedValue([
      { id: 'c1', name: 'Shoes', nameAr: 'أحذية' },
      { id: 'c2', name: 'Bags', nameAr: 'شنط' },
    ]);
    suggestCategories.mockResolvedValue({
      suggestions: [
        { id: 'c1', confidence: 'high' },
        { id: 'c2', confidence: 'low' },
      ],
      cached: false,
    });
    await fillProductFields('s1', 'p1', { op: 'create' });
    expect(generateProductSearchTerms.mock.calls[0][0].categoryNames).toEqual(['أحذية', 'Shoes']);
  });

  describe('I1: a merchant save while generation is in flight survives', () => {
    it("the merchant's words and human stamp survive; the stale AI words are not written", async () => {
      productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
      generateProductSearchTerms.mockImplementation(async () => {
        // The merchant saves their own words while Gemini is answering.
        productRow = {
          ...productRow,
          searchTerms: 'كوتشي, kotshy',
          aiFieldSources: { ...humanSources, searchTerms: 'human' },
        };
        return 'جزمه, gazma, shoes';
      });
      await fillProductFields('s1', 'p1', { op: 'create' });
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('a field whose value changed since the read is skipped even without a human stamp; others still write, on the FRESH provenance map', async () => {
      productRow = {
        ...baseProduct,
        name: '',
        searchTerms: null,
        aiFieldSources: { ...humanSources, name: undefined, metaTitle: 'human' },
      };
      translate.mockResolvedValue({ translation: 'Leather sneakers', cached: false });
      generateProductSearchTerms.mockImplementation(async () => {
        // Another writer (bulk import of an older export) set the words, no stamp change;
        // and the merchant stamped a different field meanwhile.
        productRow = {
          ...productRow,
          searchTerms: 'kotshy',
          aiFieldSources: { ...(productRow.aiFieldSources as object), metaTitleAr: 'human' },
        };
        return 'جزمه, gazma';
      });
      await fillProductFields('s1', 'p1', { op: 'create' });
      const data = (updateSpy.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
        .data;
      expect(data).not.toHaveProperty('searchTerms');
      expect(data.name).toBe('Leather sneakers');
      const src = data.aiFieldSources as Record<string, string>;
      expect(src.name).toBe('ai');
      expect(src.metaTitleAr).toBe('human'); // the concurrent stamp is kept, not overwritten
      expect(src.searchTerms).toBeUndefined();
    });
  });

  describe('I4: the fill reports real calls and does not swallow a 429', () => {
    it('counts only non-cached provider calls', async () => {
      productRow = {
        ...baseProduct,
        name: '',
        description: '',
        searchTerms: null,
        aiFieldSources: { ...humanSources, name: undefined, description: undefined },
      };
      translate
        .mockResolvedValueOnce({ translation: 'Leather sneakers', cached: true })
        .mockResolvedValueOnce({ translation: 'White leather sneakers', cached: false });
      const r = await fillProductFields('s1', 'p1', { op: 'create' });
      expect(r.calls).toBe(2); // 1 uncached translate + 1 search-words call
    });

    it('a provider 429 is flagged rateLimited and logged at warn with a running count', async () => {
      warn.mockClear();
      generateProductSearchTerms.mockRejectedValue(
        Object.assign(new Error('AI quota reached'), { code: 'AI_QUOTA_EXCEEDED', status: 429 })
      );
      productRow = { ...baseProduct, searchTerms: null, aiFieldSources: { ...humanSources } };
      const r = await fillProductFields('s1', 'p1', { op: 'create' });
      expect(r.rateLimited).toBe(true);
      expect(r.capped).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ rateLimitedTotal: expect.any(Number) }),
        expect.stringMatching(/429/)
      );
    });
  });
});
