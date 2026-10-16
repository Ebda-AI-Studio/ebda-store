/**
 * Search program P1 (Task 8): AI search words for a product. A fake Gemini client stands in for
 * the provider (no network). Franco-Arabic fixtures come from the collected reference vocabulary
 * (`.superpowers/shared/franco-vocab.json`: 3abaya/3baya, gazma/gezma, kotshy, shibshib).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
vi.mock('../../apps/api/src/lib/ai/gemini-keys', () => ({
  // A plain function, not an arrow: the generator calls it with `new`.
  GeminiFailoverClient: vi.fn(function () {
    return { getGenerativeModel: () => ({ generateContent }) };
  }),
}));
const recordUsage = vi.fn(async () => undefined);
vi.mock('../../apps/api/src/services/ai.service', () => ({ recordUsage }));
const assertAiQuota = vi.fn(async () => undefined);
vi.mock('../../apps/api/src/lib/ai-quota', () => ({
  assertAiQuota,
  isAiQuotaCapError: () => false,
}));

const { generateProductSearchTerms, buildSearchTermsPrompt } =
  await import('../../apps/api/src/lib/ai/product-search-terms-generator');
const input = {
  storeId: 's1',
  storeName: 'متجر',
  product: { name: 'Black abaya', nameAr: 'عباية سوداء', description: null, descriptionAr: null },
  categoryNames: ['ملابس حريمي'],
};

const reply = (text: string, usageMetadata: object = {}) => ({
  response: { text: () => text, usageMetadata },
});

describe('generateProductSearchTerms', () => {
  beforeEach(() => {
    generateContent.mockReset();
    recordUsage.mockClear();
    assertAiQuota.mockClear();
  });

  it('prompt asks for Egyptian dialect, Franco-Arabic and English and forbids brand invention', () => {
    const p = buildSearchTermsPrompt(input);
    expect(p).toMatch(/Egyptian/);
    expect(p).toMatch(/Franco/);
    expect(p).toMatch(/3abaya/);
    expect(p).toMatch(/Do not invent brand/);
  });

  it('prompt carries the product data in both languages and the categories', () => {
    const p = buildSearchTermsPrompt({
      ...input,
      product: { ...input.product, descriptionAr: 'عباية كاجوال قماش كريب' },
    });
    expect(p).toContain('Black abaya');
    expect(p).toContain('عباية سوداء');
    expect(p).toContain('ملابس حريمي');
    expect(p).toContain('عباية كاجوال قماش كريب');
    expect(p).toMatch(/phone|email/i); // tells the model never to emit contact details
  });

  it('checks bulk quota, records usage, returns cleaned comma list', async () => {
    generateContent.mockResolvedValue(
      reply('{"terms":["عبايه","3abaya","abaya","عباية","",  "خمار"]}', {
        promptTokenCount: 50,
        candidatesTokenCount: 20,
      })
    );
    const out = await generateProductSearchTerms(input, 'k', 'gemini-flash-lite-latest');
    expect(assertAiQuota).toHaveBeenCalledWith({ storeId: 's1', bulk: true });
    expect(recordUsage).toHaveBeenCalledWith('s1', 'search-terms', 50, 20, false, {
      model: 'gemini-flash-lite-latest',
    });
    expect(out).toBe('عبايه, 3abaya, abaya, خمار'); // عباية folds onto عبايه → deduped
  });

  it('checks the quota BEFORE calling the provider (a capped store spends nothing)', async () => {
    assertAiQuota.mockRejectedValueOnce(new Error('AI_QUOTA_STORE_DAILY_EXCEEDED'));
    await expect(generateProductSearchTerms(input, 'k', 'm')).rejects.toThrow(/QUOTA/);
    expect(generateContent).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('returns null on an unexpected shape', async () => {
    generateContent.mockResolvedValue({ response: { text: () => 'nope', usageMetadata: {} } });
    expect(await generateProductSearchTerms(input, 'k', 'm')).toBeNull();
  });

  it('returns null when terms is not an array, and still records the spent tokens', async () => {
    generateContent.mockResolvedValue(reply('{"terms":"gazma"}', { promptTokenCount: 9 }));
    expect(await generateProductSearchTerms(input, 'k', 'm')).toBeNull();
    expect(recordUsage).toHaveBeenCalledWith('s1', 'search-terms', 9, 0, false, { model: 'm' });
  });

  it('accepts a fenced reply with prose and keeps Franco digits-as-letters', async () => {
    generateContent.mockResolvedValue(
      reply(
        '```json\n{"terms":["جزمه","gazma","gezma","كوتشي","kotshy","shoes", 7]}\n```\nHope this helps'
      )
    );
    expect(await generateProductSearchTerms(input, 'k', 'm')).toBe(
      'جزمه, gazma, gezma, كوتشي, kotshy, shoes'
    );
  });

  it('never keeps personal-data-shaped terms (phone, email, link, order number)', async () => {
    generateContent.mockResolvedValue(
      reply(
        JSON.stringify({
          terms: [
            'شبشب',
            'shibshib',
            '01012345678',
            '٠١٠ ١٢٣ ٤٥٦٧٨',
            'sales@shop.com',
            'www.shop.com',
            'https://wa.me/201012345678',
            'ORD-LX3K9Q2',
            'shebsheb، 01198765432', // a separator inside one term: each piece is gated
          ],
        })
      )
    );
    expect(await generateProductSearchTerms(input, 'k', 'm')).toBe('شبشب, shibshib, shebsheb');
  });

  it('returns null when every term is dropped', async () => {
    generateContent.mockResolvedValue(reply('{"terms":["01012345678","  ", "a@b.co"]}'));
    expect(await generateProductSearchTerms(input, 'k', 'm')).toBeNull();
  });

  it('caps the stored value at the shared limits (30 terms, 500 characters)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `3abaya model ${'x'.repeat(i % 7)}${i}`);
    generateContent.mockResolvedValue(reply(JSON.stringify({ terms: many })));
    const out = await generateProductSearchTerms(input, 'k', 'm');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(500);
    expect(out!.split(', ').length).toBeLessThanOrEqual(30);
  });

  it('surfaces a provider failure as an AppError, without recording usage', async () => {
    generateContent.mockRejectedValue(Object.assign(new Error('boom'), { status: 429 }));
    await expect(generateProductSearchTerms(input, 'k', 'm')).rejects.toMatchObject({
      code: 'AI_QUOTA_EXCEEDED',
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
