/**
 * PWAService.generateManifest unit tests (B5 plan tasks 1+4).
 *
 * The binding requirement (task 4 + the B5 PR): a store that has ONLY ever
 * set icon192/icon512 (the pre-B5 shape) must get back the EXACT SAME
 * manifest.icons array it did before this feature shipped — same two
 * entries, same order, same keys (no stray `purpose`). This file locks that
 * down with an exact `toEqual`, then separately proves the new full-size-set
 * path actually emits every plan-listed size.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueMock = vi.fn();
const isFeatureEnabledMock = vi.fn();

vi.mock('@force/database', () => ({
  prisma: { store: { findUnique: findUniqueMock, update: vi.fn() } },
  Prisma: {},
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: isFeatureEnabledMock },
}));
vi.mock('@api/services/storage.service', () => ({ StorageService: { upload: vi.fn() } }));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const STORE_ID = '22222222-2222-2222-2222-222222222222';

describe('PWAService.generateManifest', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    isFeatureEnabledMock.mockReset();
    isFeatureEnabledMock.mockResolvedValue(true);
  });

  it('LEGACY: a store with only icon192 + icon512 gets EXACTLY the pre-B5 manifest.icons', async () => {
    findUniqueMock.mockResolvedValue({
      name: 'Legacy Store',
      pwaSettings: {
        appName: 'Legacy Store',
        shortName: 'Legacy',
        icon192: 'https://cdn.example.com/legacy-192.png',
        icon512: 'https://cdn.example.com/legacy-512.png',
      },
    });

    const { PWAService } = await import('@api/services/pwa.service');
    const manifest = (await PWAService.generateManifest(STORE_ID)) as { icons: unknown };

    // Exact byte-shape match — this is the contract, not an approximation.
    expect(manifest.icons).toEqual([
      { src: 'https://cdn.example.com/legacy-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'https://cdn.example.com/legacy-512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('LEGACY + maskable: preserves the pre-B5 3-entry shape with purpose on maskable only', async () => {
    findUniqueMock.mockResolvedValue({
      name: 'Legacy Store',
      pwaSettings: {
        icon192: 'https://cdn.example.com/192.png',
        icon512: 'https://cdn.example.com/512.png',
        maskableIcon: 'https://cdn.example.com/maskable.png',
      },
    });

    const { PWAService } = await import('@api/services/pwa.service');
    const manifest = (await PWAService.generateManifest(STORE_ID)) as { icons: unknown };

    expect(manifest.icons).toEqual([
      { src: 'https://cdn.example.com/192.png', sizes: '192x192', type: 'image/png' },
      { src: 'https://cdn.example.com/512.png', sizes: '512x512', type: 'image/png' },
      {
        src: 'https://cdn.example.com/maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]);
  });

  it('FULL SET: emits every plan-listed size once a merchant has uploaded via the icon generator', async () => {
    findUniqueMock.mockResolvedValue({
      name: 'Full Store',
      pwaSettings: {
        icon192: 'https://cdn.example.com/icon192.png',
        icon384: 'https://cdn.example.com/icon384.png',
        icon512: 'https://cdn.example.com/icon512.png',
        iconAppleTouch: 'https://cdn.example.com/iconAppleTouch.png',
        favicon32: 'https://cdn.example.com/favicon32.png',
        favicon16: 'https://cdn.example.com/favicon16.png',
        maskableIcon: 'https://cdn.example.com/maskableIcon.png',
      },
    });

    const { PWAService } = await import('@api/services/pwa.service');
    const manifest = (await PWAService.generateManifest(STORE_ID)) as {
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    expect(manifest.icons.map(i => i.sizes)).toEqual([
      '16x16',
      '32x32',
      '180x180',
      '192x192',
      '384x384',
      '512x512',
      '512x512',
    ]);
    expect(manifest.icons.at(-1)).toMatchObject({ purpose: 'maskable' });
    // Every OTHER entry has no `purpose` key at all.
    for (const icon of manifest.icons.slice(0, -1)) {
      expect(icon).not.toHaveProperty('purpose');
    }
  });

  it('PARTIAL: a store with only the new apple-touch icon slots it in without disturbing the rest', async () => {
    findUniqueMock.mockResolvedValue({
      name: 'Partial Store',
      pwaSettings: {
        icon192: 'https://cdn.example.com/192.png',
        icon512: 'https://cdn.example.com/512.png',
        iconAppleTouch: 'https://cdn.example.com/apple.png',
      },
    });

    const { PWAService } = await import('@api/services/pwa.service');
    const manifest = (await PWAService.generateManifest(STORE_ID)) as { icons: unknown };

    expect(manifest.icons).toEqual([
      { src: 'https://cdn.example.com/apple.png', sizes: '180x180', type: 'image/png' },
      { src: 'https://cdn.example.com/192.png', sizes: '192x192', type: 'image/png' },
      { src: 'https://cdn.example.com/512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('returns null when the pwa feature is disabled', async () => {
    findUniqueMock.mockResolvedValue({ name: 'X', pwaSettings: {} });
    isFeatureEnabledMock.mockResolvedValue(false);

    const { PWAService } = await import('@api/services/pwa.service');
    expect(await PWAService.generateManifest(STORE_ID)).toBeNull();
  });

  it('falls back to platform default icons when NOTHING has been set', async () => {
    findUniqueMock.mockResolvedValue({ name: 'Bare Store', pwaSettings: {} });

    const { PWAService } = await import('@api/services/pwa.service');
    const manifest = (await PWAService.generateManifest(STORE_ID)) as { icons: unknown };

    expect(manifest.icons).toEqual([
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });
});
