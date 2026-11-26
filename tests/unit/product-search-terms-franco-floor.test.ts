/**
 * G72: "eswera" found only 1 of 2 bracelets because the model wrote the Franco spelling for one
 * product and not the other. The Franco spellings of the product's own Arabic words are now
 * computed in code and always stored, whatever the model returns. Fails on the old generator
 * (it stored only what the model sent, and null for an unusable reply).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
vi.mock('../../apps/api/src/lib/ai/gemini-keys', () => ({
  GeminiFailoverClient: vi.fn(function () {
    return { getGenerativeModel: () => ({ generateContent }) };
  }),
}));
vi.mock('../../apps/api/src/services/ai.service', () => ({
  recordUsage: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/lib/ai-quota', () => ({
  assertAiQuota: vi.fn(async () => undefined),
  isAiQuotaCapError: () => false,
}));

const { generateProductSearchTerms, buildSearchTermsPrompt } =
  await import('../../apps/api/src/lib/ai/product-search-terms-generator');

const bracelet = (nameAr: string) => ({
  storeId: 's1',
  storeName: 'متجر',
  product: { name: '', nameAr, description: null, descriptionAr: null },
  categoryNames: [],
});
const reply = (text: string) => ({ response: { text: () => text, usageMetadata: {} } });

describe('Franco floor on AI search words (G72)', () => {
  beforeEach(() => generateContent.mockReset());

  it('both bracelets get "eswera" even when the model sent it for only one', async () => {
    generateContent.mockResolvedValueOnce(reply('{"terms":["eswera","bracelet","اسوره"]}'));
    const a = await generateProductSearchTerms(bracelet('إسورة الشط'), 'k', 'm');
    generateContent.mockResolvedValueOnce(reply('{"terms":["bracelet","اسوره"]}'));
    const b = await generateProductSearchTerms(bracelet('إسورة فضة'), 'k', 'm');
    expect(a).toContain('eswera');
    expect(b).toContain('eswera');
  });

  it('an unusable model reply still stores the spellings (was null)', async () => {
    generateContent.mockResolvedValueOnce(reply('sorry I cannot'));
    expect(await generateProductSearchTerms(bracelet('إسورة'), 'k', 'm')).toContain('eswera');
  });

  it('the stored list stays inside the 30-term / 500-char limits with the spellings first', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`);
    generateContent.mockResolvedValueOnce(reply(JSON.stringify({ terms: many })));
    const out = (await generateProductSearchTerms(bracelet('إسورة'), 'k', 'm'))!;
    expect(out.split(', ').length).toBeLessThanOrEqual(30);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.split(', ')[0]).toMatch(/^[a-z0-9]+$/);
    expect(out).toContain('eswera');
  });

  it('the prompt asks for Franco spellings of every Arabic word of the name', () => {
    expect(buildSearchTermsPrompt(bracelet('إسورة'))).toMatch(/EVERY Arabic word/);
  });
});
