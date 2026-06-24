/**
 * AI Description Balancer — Unit Tests
 *
 * Covers:
 *  1. `richerSide` null → no write (both descriptions empty)
 *  2. Rich AR / empty EN → translates AR→EN, stamps both sources 'ai', saves backup
 *  3. Rich EN / empty AR → translates EN→AR, stamps both sources 'ai', saves backup
 *  4. Already balanced (within 10%) → skips unless force:true
 *  5. revertProductBalance → restores from backup and clears it
 *  6. revertProductBalance with no backup → returns reverted:false
 *  7. Second balance call doesn't overwrite existing backup (preserves TRUE original)
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
vi.mock('@force/database', () => ({
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
  balanceProductDescription,
  revertProductBalance,
} from '../../apps/api/src/services/ai-autofill.service';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('balanceProductDescription', () => {
  it('returns balanced:false, side:null when both descriptions are empty', async () => {
    mockFindFirst.mockResolvedValue(makeProduct());

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(false);
    expect(result.side).toBe(null);
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns balanced:false when product is not found', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(false);
    expect(result.side).toBe(null);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('translates AR→EN when Arabic is rich and English is empty', async () => {
    const arText = 'وصف المنتج باللغة العربية وهو نص طويل نسبياً';
    mockFindFirst.mockResolvedValue(
      makeProduct({
        description: null,
        descriptionAr: arText,
        aiFieldSources: {},
        aiBalanceBackup: {},
      })
    );
    mockTranslate.mockResolvedValue({ translation: 'Arabic product description', cached: false });

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(result.side).toBe('ar');
    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE_ID,
        text: arText,
        from: 'ar',
        to: 'en',
        kind: 'product-description',
      })
    );

    // Should write the translated EN, stamp BOTH sources 'ai', and save backup
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRODUCT_ID, storeId: STORE_ID },
        data: expect.objectContaining({
          description: 'Arabic product description',
          aiFieldSources: expect.objectContaining({ description: 'ai', descriptionAr: 'ai' }),
          aiBalanceBackup: expect.objectContaining({
            description: null,
            descriptionAr: arText,
          }),
        }),
      })
    );
  });

  it('translates EN→AR when English is rich and Arabic is empty', async () => {
    const enText = 'This is a rich English product description with plenty of content.';
    mockFindFirst.mockResolvedValue(
      makeProduct({
        description: enText,
        descriptionAr: null,
        aiFieldSources: {},
        aiBalanceBackup: {},
      })
    );
    mockTranslate.mockResolvedValue({ translation: 'وصف المنتج المترجم', cached: false });

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(true);
    expect(result.side).toBe('en');
    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'en',
        to: 'ar',
        kind: 'product-description',
      })
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          descriptionAr: 'وصف المنتج المترجم',
          aiFieldSources: expect.objectContaining({ description: 'ai', descriptionAr: 'ai' }),
          aiBalanceBackup: expect.objectContaining({
            description: enText,
            descriptionAr: null,
          }),
        }),
      })
    );
  });

  it('skips when both sides are present and within 10% richness gap', async () => {
    // Same-length strings → gap = 0% → skip (well under the 10% threshold)
    const enText = 'English product description here ok.';
    const arText = 'وصف المنتج باللغة العربية هنا جيد';
    mockFindFirst.mockResolvedValue(
      makeProduct({
        description: enText,
        descriptionAr: arText,
        aiFieldSources: {},
        aiBalanceBackup: {},
      })
    );

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID);

    expect(result.balanced).toBe(false);
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('translates when force:true even if already balanced', async () => {
    const enText = 'English product description here.';
    const arText = 'وصف المنتج باللغة العربية.';
    mockFindFirst.mockResolvedValue(
      makeProduct({
        description: enText,
        descriptionAr: arText,
        aiFieldSources: {},
        aiBalanceBackup: {},
      })
    );
    mockTranslate.mockResolvedValue({ translation: 'forced translation', cached: false });

    const result = await balanceProductDescription(STORE_ID, PRODUCT_ID, { force: true });

    expect(result.balanced).toBe(true);
    expect(mockTranslate).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('does NOT overwrite existing backup on second balance call', async () => {
    const originalDescription = 'original English text before any AI';
    const existingBackup = {
      description: originalDescription,
      descriptionAr: null,
      aiFieldSources: {},
    };
    const enText = 'AI-translated English (already balanced once)';
    const arText = 'نص عربي غني جداً وطويل ومفصل يحتوي على معلومات كثيرة عن المنتج';

    mockFindFirst.mockResolvedValue(
      makeProduct({
        description: enText,
        descriptionAr: arText,
        aiFieldSources: { description: 'ai', descriptionAr: 'ai' },
        aiBalanceBackup: existingBackup,
      })
    );
    mockTranslate.mockResolvedValue({ translation: 're-translated', cached: false });

    await balanceProductDescription(STORE_ID, PRODUCT_ID, { force: true });

    const updateCall = mockUpdate.mock.calls[0][0];
    // The backup passed to update must be the EXISTING backup, not a new snapshot
    expect(updateCall.data.aiBalanceBackup).toEqual(existingBackup);
    // The backup must NOT contain the AI-translated text (which would lose the true original)
    expect(updateCall.data.aiBalanceBackup.description).toBe(originalDescription);
  });
});

describe('revertProductBalance', () => {
  it('restores description fields from backup and clears aiBalanceBackup', async () => {
    const backup = {
      description: 'original English',
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
          description: 'original English',
          descriptionAr: null,
          aiFieldSources: { name: 'human' },
          aiBalanceBackup: {},
        }),
      })
    );
  });

  it('returns reverted:false when no backup exists', async () => {
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
