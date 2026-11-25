/**
 * Register row 29 (AI features): the bulk SEO sweep fills EMPTY fields only and never overwrites merchant text,
 * with or without `force`. Per-field: a product with a merchant title and an empty description keeps the title.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/ai-quota', () => ({ isAiQuotaCapError: () => false }));
vi.mock('../../apps/api/src/lib/inngest/ai-retry', () => ({
  callWithRetry: (fn: () => unknown) => fn(),
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../apps/api/src/services/store.service', () => ({
  bustStoreCachesById: vi.fn().mockResolvedValue(undefined),
}));

const mockSuggestSeo = vi.fn();
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: { suggestSeo: (...a: unknown[]) => mockSuggestSeo(...a) },
}));

const m = vi.hoisted(() => ({
  storeFind: vi.fn(),
  catFindMany: vi.fn(),
  prodFindMany: vi.fn(),
  prodFind: vi.fn(),
  prodUpdate: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  prisma: {
    store: { findUnique: m.storeFind },
    category: { findMany: m.catFindMany },
    product: { findMany: m.prodFindMany, findUnique: m.prodFind, update: m.prodUpdate },
    bulkAiJob: { findUnique: m.jobFind, update: m.jobUpdate },
  },
}));

let handler: (a: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<void>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_c: unknown, h: typeof handler) => {
      handler = h;
      return { id: 'bulk-ai-seo' };
    },
  },
}));

const SUGGESTION = {
  title: 'AI title',
  titleAr: 'AI عنوان',
  description: 'AI description',
  descriptionAr: 'AI وصف',
};

beforeEach(async () => {
  vi.resetModules();
  process.env.AI_BULK_THROTTLE_MS = '0';
  Object.values(m).forEach(f => f.mockReset());
  mockSuggestSeo.mockReset().mockResolvedValue({ suggestion: SUGGESTION });
  m.storeFind.mockResolvedValue({ id: 'store-1', name: 'S', nameAr: null });
  m.catFindMany.mockResolvedValue([]);
  m.jobFind.mockResolvedValue({ status: 'running' });
  m.jobUpdate.mockResolvedValue({});
  await import('../../apps/api/src/lib/inngest/functions/bulk-ai-seo.js');
});

async function run(force: boolean) {
  const step = { run: (_id: string, fn: () => unknown) => Promise.resolve(fn()) };
  await handler({ event: { data: { jobId: 'j1', storeId: 'store-1', force } }, step });
}

const product = (over: Record<string, unknown>) => ({
  id: 'p1',
  name: 'P',
  nameAr: null,
  description: 'd',
  descriptionAr: null,
  metaTitle: null,
  metaTitleAr: null,
  metaDescription: null,
  metaDescriptionAr: null,
  categories: [],
  ...over,
});

// the store row is also a work item: give it complete SEO so only the product is under test
beforeEach(() => {
  m.storeFind.mockResolvedValue({
    id: 'store-1',
    name: 'S',
    nameAr: null,
    description: null,
    descriptionAr: null,
    metaTitle: 'x',
    metaTitleAr: 'x',
    metaDescription: 'x',
    metaDescriptionAr: 'x',
  });
});

describe.each([false, true])('bulk-ai-seo product write (force=%s)', force => {
  it('fills only the empty fields and keeps the merchant text byte-for-byte', async () => {
    m.prodFindMany.mockResolvedValue([{ id: 'p1' }]);
    m.prodFind.mockResolvedValue(
      product({ metaTitle: '  Merchant title  ', metaDescriptionAr: 'وصف التاجر' })
    );
    await run(force);
    expect(m.prodUpdate).toHaveBeenCalledTimes(1);
    const data = m.prodUpdate.mock.calls[0][0].data;
    expect(data.metaTitle).toBe('  Merchant title  '.trim());
    expect(data.metaDescriptionAr).toBe('وصف التاجر');
    expect(data.metaTitleAr).toBe(SUGGESTION.titleAr);
    expect(data.metaDescription).toBe(SUGGESTION.description);
  });
});

describe('bulk-ai-seo skip rule', () => {
  it('without force, a product with all four fields filled is skipped (no AI call, no write)', async () => {
    m.prodFindMany.mockResolvedValue([{ id: 'p1' }]);
    m.prodFind.mockResolvedValue(
      product({ metaTitle: 'a', metaTitleAr: 'b', metaDescription: 'c', metaDescriptionAr: 'd' })
    );
    await run(false);
    expect(mockSuggestSeo).not.toHaveBeenCalled();
    expect(m.prodUpdate).not.toHaveBeenCalled();
  });

  it('with force, a fully filled product is re-sent to the AI but every merchant field is still kept', async () => {
    m.prodFindMany.mockResolvedValue([{ id: 'p1' }]);
    m.prodFind.mockResolvedValue(
      product({ metaTitle: 'a', metaTitleAr: 'b', metaDescription: 'c', metaDescriptionAr: 'd' })
    );
    await run(true);
    const data = m.prodUpdate.mock.calls[0][0].data;
    expect(data).toEqual({
      metaTitle: 'a',
      metaTitleAr: 'b',
      metaDescription: 'c',
      metaDescriptionAr: 'd',
    });
  });
});
