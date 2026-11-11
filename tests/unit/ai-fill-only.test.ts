/**
 * Ruling NEVER-OVERWRITE-1 (2026-11-11, QA store 1bb14d0e): an automated fill replaced a stored Arabic name
 * «خاتم الإشارة» (stamped 'ai') with a phonetic «سيجنال سيجنيت» after an unrelated save. The AI may only fill EMPTY fields.
 */
import { describe, expect, it, vi } from 'vitest';
import { aiMayWriteOver, generateFill, type FillPlan } from '@api/services/ai-autofill.service';
import { AIService } from '@api/services/ai.service';

const plan = (over: Partial<FillPlan> = {}): FillPlan => ({
  storeId: 's',
  productId: 'p',
  fillSet: ['nameAr', 'descriptionAr'],
  values: {
    name: 'Signal Signet',
    nameAr: 'خاتم الإشارة',
    description: 'A ring',
    descriptionAr: null,
  },
  sources: { nameAr: 'ai', name: 'human' },
  categoryNames: [],
  hasCategories: true,
  storeCategories: [],
  storeName: '',
  storeNameAr: null,
  ...over,
});

describe('fill-only AI writes', () => {
  it('aiMayWriteOver: empty yes, filled no, name===nameAr placeholder yes', () => {
    expect(aiMayWriteOver('nameAr', { nameAr: 'خاتم' })).toBe(false);
    expect(aiMayWriteOver('nameAr', { nameAr: '  ' })).toBe(true);
    expect(aiMayWriteOver('metaTitle', { metaTitle: null })).toBe(true);
    expect(aiMayWriteOver('name', { name: 'س', nameAr: 'س' })).toBe(true);
    expect(aiMayWriteOver('name', { name: 'Ring', nameAr: 'خاتم' })).toBe(false);
  });

  it('generateFill never retranslates an ai-stamped non-empty nameAr, still fills the empty sibling', async () => {
    const spy = vi
      .spyOn(AIService, 'translate')
      .mockResolvedValue({ translation: 'سيجنال سيجنيت', cached: true } as never);
    const gen = await generateFill(plan());
    expect(gen.writes.nameAr).toBeUndefined();
    expect(gen.writes.descriptionAr).toBe('سيجنال سيجنيت');
    spy.mockRestore();
  });

  it('a merchant-initiated hand-back (mayOverwrite) may refresh an ai-owned field', async () => {
    const spy = vi
      .spyOn(AIService, 'translate')
      .mockResolvedValue({ translation: 'جديد', cached: true } as never);
    const gen = await generateFill(plan({ mayOverwrite: true, fillSet: ['nameAr'] }));
    expect(gen.writes.nameAr).toBe('جديد');
    spy.mockRestore();
  });
});
