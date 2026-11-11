/**
 * Ruling NAME-PAIR-1 (2026-11-10): an Arabic-only name was stored in the English `name` (quick create), and the
 * onboarding name came back swapped (Arabic in `name`, the English "Sign Ring" in `nameAr`). The API now takes the name
 * in either language, the autofill translates INTO the missing field only, and a one-time repair finds the bad pairs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveNamePair, isNamePlaceholder } from '../../apps/api/src/lib/product-name-pair';

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  isStoreAiEnabled: async () => true,
  assertStoreAiEnabled: async () => undefined,
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => ({}),
  storeWriter: async () => ({}),
  storeRepo: async () => ({ backend: 'do' }),
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
vi.mock('../../apps/api/src/config', () => ({ config: { googleAiKey: 'k' } }));

const { generateFill } = await import('../../apps/api/src/services/ai-autofill.service');
const { diagnoseName } = await import('../../apps/api/src/services/product-name-repair.service');

describe('resolveNamePair', () => {
  it('an Arabic name typed alone (onboarding, sourceLang ar) is the Arabic name; name is its placeholder', () => {
    expect(resolveNamePair({ name: 'خاتم ذهب', sourceLang: 'ar' })).toEqual({
      name: 'خاتم ذهب',
      nameAr: 'خاتم ذهب',
      namePlaceholder: true,
    });
  });
  it('Arabic script in the English field with no Arabic name moves to nameAr even without sourceLang', () => {
    expect(resolveNamePair({ name: 'حلق لولي' }).nameAr).toBe('حلق لولي');
  });
  it('an Arabic-only create keeps the Arabic and marks name a placeholder', () => {
    expect(resolveNamePair({ nameAr: 'سلسلة فضة' })).toMatchObject({
      name: 'سلسلة فضة',
      nameAr: 'سلسلة فضة',
      namePlaceholder: true,
    });
  });
  it('a swapped pair is put right', () => {
    expect(resolveNamePair({ name: 'خاتم', nameAr: 'Sign Ring' })).toMatchObject({
      name: 'Sign Ring',
      nameAr: 'خاتم',
      namePlaceholder: false,
    });
  });
  it('English alone (nameEn alias) stays English; both stay as typed', () => {
    expect(resolveNamePair({ nameEn: 'Silver chain', sourceLang: 'en' })).toEqual({
      name: 'Silver chain',
      namePlaceholder: false,
    });
    expect(resolveNamePair({ name: 'Pearl ring', nameAr: 'خاتم لولي' })).toMatchObject({
      name: 'Pearl ring',
      nameAr: 'خاتم لولي',
    });
  });
  it('an update that sends only nameAr never invents an English name', () => {
    expect(resolveNamePair({ nameAr: 'خاتم' }, 'update')).toEqual({
      nameAr: 'خاتم',
      namePlaceholder: false,
    });
  });
  it('isNamePlaceholder', () => {
    expect(isNamePlaceholder({ name: 'خاتم', nameAr: 'خاتم' })).toBe(true);
    expect(isNamePlaceholder({ name: 'Ring', nameAr: 'خاتم' })).toBe(false);
  });
});

describe('diagnoseName (one-time repair)', () => {
  it('finds the three bad shapes and leaves a good pair alone', () => {
    expect(diagnoseName({ name: 'خاتم', nameAr: 'Sign Ring' })).toEqual({
      problem: 'swapped',
      name: 'Sign Ring',
      nameAr: 'خاتم',
    });
    expect(diagnoseName({ name: 'سلسلة', nameAr: null })?.problem).toBe('arabic-in-en');
    expect(diagnoseName({ name: 'سلسلة', nameAr: 'سلسلة' })?.problem).toBe('placeholder');
    expect(diagnoseName({ name: 'Ring', nameAr: 'خاتم' })).toBeNull();
  });
});

describe('the autofill translates INTO the missing field only', () => {
  beforeEach(() => {
    translate.mockReset();
    translate.mockImplementation(async ({ to }: { to: string }) => ({
      translation: to === 'en' ? 'Gold ring' : 'خاتم',
      cached: false,
    }));
  });
  const plan = (
    values: Record<string, string | null>,
    sources: Record<string, 'ai' | 'human'> = {}
  ) => ({
    storeId: 's1',
    productId: 'p1',
    fillSet: ['name', 'nameAr'],
    values,
    sources,
    categoryNames: [],
    hasCategories: true,
    storeCategories: [],
    storeName: 'Shop',
    storeNameAr: null,
  });

  it('a placeholder name is filled from the Arabic; the typed Arabic is never rewritten', async () => {
    const g = await generateFill(
      plan({ name: 'خاتم ذهب', nameAr: 'خاتم ذهب' }, { nameAr: 'human' })
    );
    expect(g.writes.name).toBe('Gold ring');
    expect(g.writes.nameAr).toBeUndefined();
  });
  it('Arabic in the English field is never "translated" EN -> AR into nameAr (the swapped-pair defect)', async () => {
    const g = await generateFill(plan({ name: 'خاتم ذهب', nameAr: null }, { name: 'human' }));
    expect(g.writes.nameAr).toBeUndefined();
    expect(translate).not.toHaveBeenCalledWith(
      expect.objectContaining({ from: 'en', text: 'خاتم ذهب' })
    );
  });
  it('a merchant-owned name equal to nameAr is not overwritten', async () => {
    const g = await generateFill(
      plan({ name: 'خاتم', nameAr: 'خاتم' }, { name: 'human', nameAr: 'human' })
    );
    expect(g.writes.name).toBeUndefined();
  });
});
