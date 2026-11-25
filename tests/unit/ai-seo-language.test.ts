/**
 * BE:F-4 / QA P2-2: AI SEO wrote Arabic into the English fields. The prompt now states which field is which language and the
 * answer is post-checked (Arabic letter share); one retry, then 422 AI_WRONG_LANGUAGE. Every attempt is metered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generate = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: { aiUsage: { aggregate: vi.fn().mockResolvedValue({ _sum: {} }), create: vi.fn() } },
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../apps/api/src/config', () => ({
  config: { googleAiKey: 'k', aiFeaturesEnabled: true, aiDailyTokenBudgetPerStore: 1e9 },
}));
vi.mock('../../apps/api/src/lib/ai/gemini-keys', () => ({
  GeminiFailoverClient: class {
    getGenerativeModel() {
      return { generateContent: generate };
    }
  },
}));
vi.mock('../../apps/api/src/lib/ai-quota', () => ({
  assertAiQuota: vi.fn(),
  storeAiCapFactor: async () => 1,
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AIService, seoLanguagesOk } from '../../apps/api/src/services/ai.service';

const good = {
  title: 'Pecan Mix',
  titleAr: 'بيكان مشكل',
  description: 'A tasty mix of pecans.',
  descriptionAr: 'خليط لذيذ من البيكان.',
  keywords: ['pecan'],
};
const swapped = { ...good, title: 'بيكان مشكل', description: 'خليط لذيذ من البيكان.' };
const answer = (o: object) => ({
  response: {
    text: () => JSON.stringify(o),
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
  },
});
const input = (n: string) => ({
  storeId: 's1',
  kind: 'product' as const,
  storeName: 'Shop',
  entityName: n,
});

describe('seoLanguagesOk', () => {
  it('accepts English title/description with Arabic Ar fields', () =>
    expect(seoLanguagesOk(good)).toBe(true));
  it('rejects Arabic in an English field', () => expect(seoLanguagesOk(swapped)).toBe(false));
  it('rejects English in an Arabic field', () =>
    expect(seoLanguagesOk({ ...good, titleAr: 'Pecan Mix' })).toBe(false));
  it('keeps brand names and codes in the other language', () =>
    expect(
      seoLanguagesOk({ ...good, titleAr: 'بيكان Mix 500g', description: 'Sold in 500 جرام packs' })
    ).toBe(true));
  it('does not judge a field with no letters', () =>
    expect(seoLanguagesOk({ ...good, title: '500', descriptionAr: '٥٠٠' })).toBe(true));
});

describe('seoLanguagesOk with product names (Opus review #4)', () => {
  const nike = {
    title: 'Nike Air Max 90',
    titleAr: 'Nike Air Max 90 حذاء',
    description: 'Classic running shoe.',
    descriptionAr: 'حذاء جري كلاسيكي Nike Air Max 90 مريح.',
  };
  it('a brand-heavy Arabic title passes (the brand words are not judged)', () => {
    expect(seoLanguagesOk(nike, ['Nike Air Max 90'])).toBe(true);
    // even without the names the 25% floor lets it through
    expect(seoLanguagesOk(nike)).toBe(true);
  });
  it('a real swap still fails', () => {
    expect(seoLanguagesOk({ ...nike, titleAr: 'Nike Air Max 90 shoes' }, ['Nike Air Max 90'])).toBe(
      false
    );
  });
  it('an English title carrying the Arabic store name passes; a title that is only that name does not (PR #512 review)', () => {
    const qamar = {
      title: 'Qamar قمر بوتيك — Dresses',
      titleAr: 'قمر بوتيك — فساتين سهرة',
      description: 'Evening dresses from Cairo.',
      descriptionAr: 'فساتين سهرة من القاهرة.',
    };
    expect(seoLanguagesOk(qamar, ['قمر بوتيك'])).toBe(true);
    // without the name, 8 Arabic letters of 21 (38%) is over the English ceiling
    expect(seoLanguagesOk(qamar)).toBe(false);
    // an English field made of nothing but the Arabic name is still Arabic
    expect(seoLanguagesOk({ ...qamar, title: 'قمر بوتيك' }, ['قمر بوتيك'])).toBe(false);
  });
});

describe('AIService.suggestSeo language check', () => {
  beforeEach(() => generate.mockReset());

  it('retries once when the model swaps the languages, then returns the good answer', async () => {
    generate.mockResolvedValueOnce(answer(swapped)).mockResolvedValueOnce(answer(good));
    const r = await AIService.suggestSeo(input('retry'));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(r.suggestion.title).toBe('Pecan Mix');
  });

  it('answers 422 AI_WRONG_LANGUAGE after the retry also fails', async () => {
    generate.mockResolvedValue(answer(swapped));
    await expect(AIService.suggestSeo(input('fail'))).rejects.toMatchObject({
      statusCode: 422,
      code: 'AI_WRONG_LANGUAGE',
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('a correct first answer is not retried', async () => {
    generate.mockResolvedValue(answer(good));
    await AIService.suggestSeo(input('once'));
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
