/**
 * Unit test — StoreService.updateTheme shallow-merge PATCH
 *
 * The `theme` JSON column is written by more than one admin surface (Branding
 * ThemeTab writes fonts/preset/footer-logo; the Page Builder Smart Palette
 * writes the brand color tokens). Each surface PUTs only the keys it owns;
 * updateTheme must shallow-merge those into the stored theme so keys absent
 * from the payload are preserved (no whole-object clobber).
 *
 * Strategy: mock @force/database + the side-effect deps so the test is pure.
 * Setting TEST_DATABASE_URL to a non-prod placeholder keeps the global
 * tests/setup-e2e.ts from reading the real DATABASE_URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────
// vi.hoisted so these are initialised before the hoisted vi.mock factory runs.
const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: {
    store: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
  // Re-export Prisma namespace shape used for typing only.
  Prisma: {},
  withMoneyTx: vi.fn(),
}));

vi.mock('@force/shared', () => ({
  slugify: (s: string) => s,
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));

vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { StoreService } from '../../apps/api/src/services/store.service';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StoreService.updateTheme — shallow-merge PATCH', () => {
  it('preserves keys absent from the incoming payload', async () => {
    // Existing theme carries Branding-owned keys (fonts/preset) AND
    // Page-Builder-owned color tokens.
    findUniqueMock.mockResolvedValue({
      id: STORE_ID,
      slug: 'demo',
      domain: null,
      theme: {
        primaryColor: '#111111',
        accentColor: '#222222',
        fontFamily: 'Cairo',
        backgroundPreset: 'warmSand',
      },
    });
    updateMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: STORE_ID, slug: 'demo', ...data })
    );

    // Page Builder Smart Palette saves ONLY the color tokens.
    await StoreService.updateTheme(STORE_ID, {
      primaryColor: '#ff6e01',
      accentColor: '#00aaff',
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const merged = updateMock.mock.calls[0][0].data.theme;
    // Touched keys take the new value...
    expect(merged.primaryColor).toBe('#ff6e01');
    expect(merged.accentColor).toBe('#00aaff');
    // ...untouched keys (owned by the Branding surface) are preserved.
    expect(merged.fontFamily).toBe('Cairo');
    expect(merged.backgroundPreset).toBe('warmSand');
  });

  it('adds new keys without dropping existing ones', async () => {
    findUniqueMock.mockResolvedValue({
      id: STORE_ID,
      slug: 'demo',
      domain: null,
      theme: { primaryColor: '#111111' },
    });
    updateMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: STORE_ID, slug: 'demo', ...data })
    );

    await StoreService.updateTheme(STORE_ID, { headingFontFamily: 'Tajawal' });

    const merged = updateMock.mock.calls[0][0].data.theme;
    expect(merged.primaryColor).toBe('#111111');
    expect(merged.headingFontFamily).toBe('Tajawal');
  });

  it('treats an empty/undefined existing theme as {}', async () => {
    findUniqueMock.mockResolvedValue({
      id: STORE_ID,
      slug: 'demo',
      domain: null,
      theme: null,
    });
    updateMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: STORE_ID, slug: 'demo', ...data })
    );

    await StoreService.updateTheme(STORE_ID, { primaryColor: '#ff6e01' });

    const merged = updateMock.mock.calls[0][0].data.theme;
    expect(merged).toEqual({ primaryColor: '#ff6e01' });
  });
});
