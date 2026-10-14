/**
 * AI Language Balancer — Unit Tests
 *
 * Tests the LANGUAGE-AWARE algorithm (Arabic-authoritative):
 *  1. Both descriptions empty → skip
 *  2. Both-Arabic name  → keeps AR, translates AR→EN into name
 *  3. Both-English description → keeps EN, translates EN→AR
 *  4. EN-slot holds Arabic + good AR slot → Arabic authoritative, translates AR→EN
 *  5. Both already correct (EN in name, AR in nameAr) → skip (no-op guard)
 *  6. force:true → retranslates even when both already correct
 *  7. Backup snapshots ALL FOUR original fields + aiFieldSources on first balance
 *  8. Second balance does NOT overwrite existing backup (preserves true original)
 *  9. revertProductBalance → restores all 4 fields + clears aiBalanceBackup
 * 10. revertProductBalance with no backup → returns reverted:false
 * 11. back-compat alias `balanceProductDescription` → delegates correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted) ───────────────────────────────────────────────────────

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock AIService.translate — controls translation output per test
const mockTranslate = vi.fn();
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: { translate: (...args: unknown[]) => mockTranslate(...args) },
}));

// Mock prisma product operations
const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: {
    product: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
  runInTenantContext: vi.fn((_, fn: () => unknown) => fn()),
}));

// ── Subject under test ────────────────────────────────────────────────────

import {
  balanceProductLanguages,
  balanceProductDescription,
  revertProductBalance,
} from '../../apps/api/src/services/ai-autofill.service';

// ── Helpers ───────────────────────────────────────────────────────────────

// Sample Arabic text (contains Arabic Unicode chars → containsArabic returns true)
const AR_NAME = 'اسم المنتج بالعربية';
const AR_DESC = 'وصف المنتج باللغة العربية وهو نص مفصل';
const EN_NAME = 'Product Name in English';
const EN_DESC = 'A detailed English product description with content.';

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    name: null as string | null,
    nameAr: null as string | null,
    description: null as string | null,
    descriptionAr: null as string | null,
    aiFieldSources: {} as Record<string, string>,
    aiBalanceBackup: {} as Record<string, unknown>,
    ...overrides,
  };
}

const STORE_ID = 'store-1';
const PRODUCT_ID = 'prod-1';

beforeEach(() => {
  mockTranslate.mockReset();
  mockFindFirst.mockReset();
  mockUpdate.mockReset();
  mockTranslate.mockResolvedValue({ translation: 'translated text', cached: false });
});

// ── balanceProductLanguages ───────────────────────────────────────────────

describe('balanceProductLanguages', () => {
  it('returns balanced:false when both name AND description are empty', async () => {
    mockFindFirst.mockResolvedValue(makeProduct());

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(false);
    expect(result.changed).toEqual({});
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns balanced:false when product is not found', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Case: both-Arabic name ────────────────────────────────────────────

  it('both-Arabic name: keeps nameAr, translates AR→EN into name', async () => {
    // name slot has Arabic text, nameAr slot also has Arabic text
    // Arabic is authoritative → keep nameAr, translate nameAr→EN into name
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: AR_NAME, // wrong language in EN slot
        nameAr: AR_NAME, // correct Arabic in AR slot
        description: null,
        descriptionAr: null,
      })
    );
    mockTranslate.mockResolvedValue({ translation: EN_NAME, cached: false });

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(result.changed.name).toBe(true);
    expect(result.changed.description).toBeUndefined(); // description pair unchanged

    // Should translate AR→EN for the name pair
    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE_ID,
        text: AR_NAME,
        from: 'ar',
        to: 'en',
        kind: 'product-name',
      })
    );

    // name gets the EN translation, nameAr stays as-is
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRODUCT_ID, storeId: STORE_ID },
        data: expect.objectContaining({
          name: EN_NAME,
          aiFieldSources: expect.objectContaining({ name: 'ai' }),
          // backup snapshots originals
          aiBalanceBackup: expect.objectContaining({
            name: AR_NAME,
            nameAr: AR_NAME,
          }),
        }),
      })
    );
    // nameAr should NOT be in data (it didn't change)
    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('nameAr');
  });

  // ── Case: both-English description ───────────────────────────────────

  it('both-English description: keeps description, translates EN→AR', async () => {
    // description slot has English, descriptionAr slot also has English
    // no Arabic found → use English, translate EN→AR
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: null,
        nameAr: null,
        description: EN_DESC, // English in EN slot (correct)
        descriptionAr: EN_DESC, // English in AR slot (wrong)
      })
    );
    mockTranslate.mockResolvedValue({ translation: AR_DESC, cached: false });

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(result.changed.description).toBe(true);
    expect(result.changed.name).toBeUndefined(); // name pair unchanged

    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE_ID,
        text: EN_DESC,
        from: 'en',
        to: 'ar',
        kind: 'product-description',
      })
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          descriptionAr: AR_DESC,
          aiFieldSources: expect.objectContaining({ descriptionAr: 'ai' }),
          aiBalanceBackup: expect.objectContaining({
            description: EN_DESC,
            descriptionAr: EN_DESC,
          }),
        }),
      })
    );
  });

  // ── Case: EN slot has Arabic text, AR slot has good Arabic ──────────

  it('EN-slot holds Arabic + AR-slot holds same Arabic: Arabic authoritative, translates AR→EN', async () => {
    // name slot has Arabic (wrong), nameAr slot has Arabic (right)
    // → Arabic is authoritative; no English found → translate Arabic→English
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: AR_NAME, // Arabic in EN slot
        nameAr: AR_NAME, // Arabic in AR slot
      })
    );
    mockTranslate.mockResolvedValue({ translation: EN_NAME, cached: false });

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'ar', to: 'en', kind: 'product-name' })
    );
    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData.name).toBe(EN_NAME);
    expect(updateData).not.toHaveProperty('nameAr'); // nameAr unchanged
  });

  // ── Case: swapped slots (EN in AR slot, AR in EN slot) ───────────────

  it('swapped slots: moves Arabic to AR slot and English to EN slot without translation', async () => {
    // name slot has AR text, nameAr slot has EN text → swap, no translation needed
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: AR_NAME, // Arabic in EN slot (wrong)
        nameAr: EN_NAME, // English in AR slot (wrong)
      })
    );

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(mockTranslate).not.toHaveBeenCalled(); // no translation needed

    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData.name).toBe(EN_NAME); // EN slot gets EN text
    expect(updateData.nameAr).toBe(AR_NAME); // AR slot gets AR text
  });

  // ── Case: already correct → skip ─────────────────────────────────────

  it('skips when name and description pairs are already correct', async () => {
    // EN slot has English, AR slot has Arabic → correct, no change needed
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: EN_NAME,
        nameAr: AR_NAME,
        description: EN_DESC,
        descriptionAr: AR_DESC,
      })
    );

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(false);
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Case: force:true → retranslates even when correct ────────────────

  it('force:true → retranslates both pairs even when already correct', async () => {
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: EN_NAME,
        nameAr: AR_NAME,
        description: EN_DESC,
        descriptionAr: AR_DESC,
      })
    );
    mockTranslate.mockResolvedValue({ translation: 'forced translation', cached: false });

    const result = await balanceProductLanguages(STORE_ID, PRODUCT_ID, { force: true });

    expect(result.balanced).toBe(true);
    // Both pairs should be retranslated → translate called twice
    expect(mockTranslate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalled();
  });

  // ── Backup: all 4 fields snaphotted on first balance ─────────────────

  it('snapshots ALL FOUR original fields + aiFieldSources on first balance', async () => {
    const origSources = { name: 'human', description: 'ai' };
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: AR_NAME, // wrong language (will be fixed)
        nameAr: AR_NAME,
        description: EN_DESC,
        descriptionAr: null,
        aiFieldSources: origSources,
        aiBalanceBackup: {},
      })
    );
    mockTranslate.mockResolvedValue({ translation: 'translated', cached: false });

    await balanceProductLanguages(STORE_ID, PRODUCT_ID);

    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData.aiBalanceBackup).toEqual({
      name: AR_NAME,
      nameAr: AR_NAME,
      description: EN_DESC,
      descriptionAr: null,
      aiFieldSources: origSources,
    });
  });

  // ── Backup: second balance does NOT overwrite ─────────────────────────

  it('does NOT overwrite existing backup on second balance call', async () => {
    // Simulate a product that has been balanced once: has backup, is now "correct"
    const originalBackup = {
      name: AR_NAME,
      nameAr: null,
      description: null,
      descriptionAr: null,
      aiFieldSources: {},
    };
    mockFindFirst.mockResolvedValue(
      makeProduct({
        name: EN_NAME, // correct EN (was AR before first balance)
        nameAr: AR_NAME,
        description: null,
        descriptionAr: null,
        aiFieldSources: { name: 'ai', nameAr: 'ai' },
        aiBalanceBackup: originalBackup, // already has a backup
      })
    );
    // With force:true so the balance actually runs and calls update
    mockTranslate.mockResolvedValue({ translation: 'retranslated', cached: false });

    await balanceProductLanguages(STORE_ID, PRODUCT_ID, { force: true });

    const updateData = mockUpdate.mock.calls[0][0].data;
    // Must use the EXISTING backup, not create a new one
    expect(updateData.aiBalanceBackup).toEqual(originalBackup);
    // The backup must NOT contain the post-balance EN name (that would lose the original)
    expect(updateData.aiBalanceBackup.name).toBe(AR_NAME);
  });
});

// ── revertProductBalance ──────────────────────────────────────────────────

describe('revertProductBalance', () => {
  it('restores ALL FOUR fields from backup and clears aiBalanceBackup', async () => {
    const backup = {
      name: AR_NAME,
      nameAr: null,
      description: 'original English desc',
      descriptionAr: null,
      aiFieldSources: { name: 'human' },
    };
    mockFindFirst.mockResolvedValue(
      makeProduct({
        aiBalanceBackup: backup,
      })
    );

    const result = await revertProductBalance(STORE_ID, PRODUCT_ID);

    expect(result.reverted).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRODUCT_ID, storeId: STORE_ID },
        data: expect.objectContaining({
          name: AR_NAME,
          nameAr: null, // nullable field reverts to null (clears a balance-filled value)
          description: 'original English desc',
          descriptionAr: null,
          aiFieldSources: { name: 'human' },
          aiBalanceBackup: {}, // cleared
        }),
      })
    );
  });

  it('returns reverted:false when no backup exists (empty object)', async () => {
    mockFindFirst.mockResolvedValue(
      makeProduct({
        aiBalanceBackup: {},
      })
    );

    const result = await revertProductBalance(STORE_ID, PRODUCT_ID);

    expect(result.reverted).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns reverted:false when product is not found', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await revertProductBalance(STORE_ID, PRODUCT_ID);

    expect(result.reverted).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ── back-compat alias ─────────────────────────────────────────────────────

describe('balanceProductDescription (back-compat alias)', () => {
  it('delegates to balanceProductLanguages and returns { balanced, side }', async () => {
    // Both descriptions empty → balanced:false, side:null
    mockFindFirst.mockResolvedValue(makeProduct());

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result).toHaveProperty('balanced', false);
    expect(result).toHaveProperty('side', null);
  });

  it('returns side:ar when Arabic description was the source', async () => {
    // descriptionAr has Arabic, description is empty → translates AR→EN → side='ar'
    mockFindFirst.mockResolvedValue(
      makeProduct({
        description: null,
        descriptionAr: AR_DESC,
      })
    );
    mockTranslate.mockResolvedValue({ translation: EN_DESC, cached: false });

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(result.side).toBe('ar');
  });
});
