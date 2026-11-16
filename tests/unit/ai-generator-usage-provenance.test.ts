/**
 * Every shared lib/ai generator records its usage row against the model it was
 * handed (#1038 defect class). `recordUsage` otherwise falls back to
 * GEMINI_MODEL, so a caller that passes a different `modelName` would be
 * priced at the wrong model's rate.
 *
 * Each generator records usage BEFORE parsing the reply, so an empty reply
 * (which some of them then reject) is enough to observe the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateContent, mockRecordUsage } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockRecordUsage: vi.fn(),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: (...args: unknown[]) => mockGenerateContent(...args) };
    }
  },
}));
// The generator budgets itself (#838/#845); the quota is not under test here.
vi.mock('@api/lib/ai-quota', () => ({
  assertAiQuota: async () => ({ release: async () => undefined }),
}));
vi.mock('@api/services/ai.service', () => ({ recordUsage: mockRecordUsage }));

import { suggestProductTags } from '@api/lib/ai/product-tag-suggester';
import { suggestProductCategory } from '@api/lib/ai/product-category-suggester';
import { generateProductExcerpt } from '@api/lib/ai/product-excerpt-generator';
import { generateProductFaqs } from '@api/lib/ai/product-faq-generator';
import { generateProductMetaAeo } from '@api/lib/ai/product-meta-aeo-generator';

const MODEL = 'gemini-some-other-model';
const product = { name: 'Dates', nameAr: 'تمر', description: 'Sweet', descriptionAr: 'حلو' };
const base = { storeId: 'store-1', storeName: 'Shop' };

const generators: Array<[string, () => Promise<unknown>]> = [
  ['tags', () => suggestProductTags({ ...base, product, existingTagNames: [] }, 'k', MODEL)],
  [
    'categorize',
    () =>
      suggestProductCategory(
        { ...base, product, existingCategories: [{ id: 'c1', name: 'Food' }] } as never,
        'k',
        MODEL
      ),
  ],
  ['excerpt', () => generateProductExcerpt({ ...base, product }, 'k', MODEL)],
  ['product-faqs', () => generateProductFaqs({ ...base, product } as never, 'k', MODEL)],
  ['aeo', () => generateProductMetaAeo({ ...base, product }, 'k', MODEL)],
];

describe('lib/ai generators record usage against the invoked model', () => {
  beforeEach(() => {
    mockRecordUsage.mockReset().mockResolvedValue(undefined);
    mockGenerateContent.mockReset().mockResolvedValue({
      response: {
        text: () => '',
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      },
    });
  });

  it.each(generators)('%s', async (feature, run) => {
    await run().catch(() => undefined);
    expect(mockRecordUsage).toHaveBeenCalledWith('store-1', feature, 7, 3, false, {
      model: MODEL,
    });
  });
});
