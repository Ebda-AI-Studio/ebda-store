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
const storeUpdateMock = vi.fn();

vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    prisma: { store: { findUnique: findUniqueMock, update: vi.fn() } },
    Prisma: {},
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: isFeatureEnabledMock },
}));
vi.mock('@api/services/storage.service', () => ({ StorageService: { upload: vi.fn() } }));
// Only the settings WRITE goes through these two; the reads keep the real factory.
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeWritesToDo: async () => false,
  storeUpdate: (_db: unknown, args: unknown) => storeUpdateMock(args),
}));
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

  // The API used to name `/icons/icon-192x192.png` + `/icons/icon-512x512.png` here, which no app ships (both 404 on the
  // live storefront, 2026-11-10). The storefront owns the fallback icons, so the API names none.
  it('names NO icon when nothing has been set (the storefront serves its own)', async () => {
    findUniqueMock.mockResolvedValue({ pwaSettings: { appName: 'Bare Store' } });

    const { PWAService } = await import('@api/services/pwa.service');
    const manifest = (await PWAService.generateManifest(STORE_ID)) as Record<string, unknown>;

    expect(manifest).toEqual({ name: 'Bare Store' });
    expect(manifest).not.toHaveProperty('icons');
  });
});

// Ruling PWA-MANIFEST-1 (the alternative, taken 2026-11-10): the public manifest carries ONLY what the merchant saved.
// The storefront (apps/web/src/lib/pwa/store-manifest.ts) fills every other member with the value its generic manifest uses, so
// a store that never saved PWA settings keeps the manifest it had. Anything invented here (a store name, `Shop at X`,
// `تسوق في X`, a default colour, display, orientation, start URL or scope) would override the storefront's better
// value: the store's theme colour and its own description.
describe('PWAService.generateManifest — only what the merchant saved', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    isFeatureEnabledMock.mockReset();
    isFeatureEnabledMock.mockResolvedValue(true);
  });
  const generate = async () => {
    const { PWAService } = await import('@api/services/pwa.service');
    return (await PWAService.generateManifest(STORE_ID)) as Record<string, unknown>;
  };

  it.each([
    ['an empty settings object', {}],
    ['no settings row value at all', null],
  ])('%s: the manifest is {} (not null: the store exists and the plan has PWA)', async (_l, v) => {
    findUniqueMock.mockResolvedValue({ pwaSettings: v });
    expect(await generate()).toEqual({});
  });

  it('the store is read for its saved settings only: no name to build a default from', async () => {
    findUniqueMock.mockResolvedValue({ pwaSettings: {} });
    await generate();
    expect(findUniqueMock.mock.calls[0][0].select).toEqual({ pwaSettings: true });
  });

  it('every saved member is emitted under its manifest name, trimmed, and nothing else', async () => {
    findUniqueMock.mockResolvedValue({
      pwaSettings: {
        appName: ' Merchant App ',
        shortName: 'Merchant',
        description: 'Fresh bread, every day',
        appNameAr: 'تطبيق التاجر',
        shortNameAr: 'التاجر',
        descriptionAr: 'عيش طازة كل يوم',
        themeColor: '#123456',
        backgroundColor: '#fefefe',
        display: 'minimal-ui',
        orientation: 'portrait',
        startUrl: '/offers',
      },
    });
    expect(await generate()).toEqual({
      name: 'Merchant App',
      short_name: 'Merchant',
      description: 'Fresh bread, every day',
      name_ar: 'تطبيق التاجر',
      short_name_ar: 'التاجر',
      description_ar: 'عيش طازة كل يوم',
      theme_color: '#123456',
      background_color: '#fefefe',
      display: 'minimal-ui',
      orientation: 'portrait',
      start_url: '/offers',
    });
  });

  it.each([
    ['theme colour only', { themeColor: '#123456' }, { theme_color: '#123456' }],
    ['Arabic app name only', { appNameAr: 'تطبيق' }, { name_ar: 'تطبيق' }],
    ['description only', { description: 'Our own words' }, { description: 'Our own words' }],
    ['start URL only', { startUrl: '/offers' }, { start_url: '/offers' }],
  ])('partly saved, %s: exactly that member', async (_label, saved, expected) => {
    findUniqueMock.mockResolvedValue({ pwaSettings: saved });
    expect(await generate()).toEqual(expected);
  });

  it('a blank or non-string saved value is absent, never an empty string or a placeholder', async () => {
    findUniqueMock.mockResolvedValue({
      pwaSettings: { appName: '', shortName: '   ', description: null, themeColor: 7 },
    });
    expect(await generate()).toEqual({});
  });

  it('invents nothing: no "Shop at", no "تسوق في", no default colour, display, orientation, start URL or scope', async () => {
    // even a store row that carries names (an older select shape) must not leak them into the manifest
    findUniqueMock.mockResolvedValue({
      name: 'Demo Shop',
      nameAr: 'وادي الجوز',
      pwaSettings: { icon192: 'https://cdn.example.com/192.png' },
    });
    const manifest = await generate();
    expect(Object.keys(manifest)).toEqual(['icons']);
    const text = JSON.stringify(manifest);
    for (const invented of [
      'Shop at',
      'تسوق في',
      'Demo Shop',
      'وادي الجوز',
      '#0A0B0C',
      '#ffffff',
    ]) {
      expect(text, invented).not.toContain(invented);
    }
  });
});

// #2194 — the Arabic identity the admin PWA tab authors reaches the manifest.
describe('PWAService.generateManifest — Arabic identity members', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    isFeatureEnabledMock.mockReset();
    isFeatureEnabledMock.mockResolvedValue(true);
  });
  type M = { name_ar?: string; short_name_ar?: string; description_ar?: string; name?: string };

  it('emits the merchant-authored appNameAr / shortNameAr / descriptionAr', async () => {
    findUniqueMock.mockResolvedValue({
      pwaSettings: { appNameAr: 'تطبيق وادي', shortNameAr: 'وادي', descriptionAr: 'تسوق الآن' },
    });
    const { PWAService } = await import('@api/services/pwa.service');
    const m = (await PWAService.generateManifest(STORE_ID)) as M;
    expect(m.name_ar).toBe('تطبيق وادي');
    expect(m.short_name_ar).toBe('وادي');
    expect(m.description_ar).toBe('تسوق الآن');
    // the English name was never saved, so it is absent: the storefront uses the store's own name
    expect(m.name).toBeUndefined();
  });

  // The store's Arabic name used to be copied in here, with `تسوق في <name>` as the Arabic description. The storefront
  // already has both (its generic manifest), and its description prefers the store's own Arabic description.
  it('Arabic fields left blank: no Arabic member at all (the storefront has the store Arabic name)', async () => {
    findUniqueMock.mockResolvedValue({ name: 'Demo Shop', nameAr: 'وادي الجوز', pwaSettings: {} });
    const { PWAService } = await import('@api/services/pwa.service');
    const m = (await PWAService.generateManifest(STORE_ID)) as M;
    expect(m.name_ar).toBeUndefined();
    expect(m.short_name_ar).toBeUndefined();
    expect(m.description_ar).toBeUndefined();
  });

  it('an Arabic app name without a short name: the short name is not derived from it', async () => {
    findUniqueMock.mockResolvedValue({ pwaSettings: { appNameAr: 'تطبيق وادي الجوز الجديد' } });
    const { PWAService } = await import('@api/services/pwa.service');
    const m = (await PWAService.generateManifest(STORE_ID)) as M;
    expect(m).toEqual({ name_ar: 'تطبيق وادي الجوز الجديد' });
  });
});

// The public manifest can only tell "saved" from "never saved" if a settings write stores what was SENT. It used to
// merge the defaults, the store name and `Shop at <name>` into the row on every write, including the enable toggle
// (which sends no settings at all) and an icon upload (which sends only the icon URLs).
describe('PWAService.updateSettings — stores only what was sent', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    storeUpdateMock.mockReset();
    storeUpdateMock.mockImplementation(
      async (args: { data: { pwaEnabled?: boolean; pwaSettings?: unknown } }) => ({
        pwaEnabled: args.data.pwaEnabled ?? false,
        pwaSettings: 'pwaSettings' in args.data ? args.data.pwaSettings : STORED.current,
      })
    );
  });
  const STORED: { current: unknown } = { current: null };
  const update = async (
    stored: unknown,
    data: { pwaEnabled?: boolean; settings?: Record<string, unknown> }
  ) => {
    STORED.current = stored;
    findUniqueMock.mockResolvedValue({ name: 'Demo Shop', pwaSettings: stored });
    const { PWAService } = await import('@api/services/pwa.service');
    const result = await PWAService.updateSettings(STORE_ID, data as never);
    return { result, written: storeUpdateMock.mock.calls[0][0].data as Record<string, unknown> };
  };

  it('the enable toggle alone writes the flag and leaves the settings column untouched', async () => {
    const { written } = await update(null, { pwaEnabled: true });
    expect(written).toEqual({ pwaEnabled: true });
    expect(written).not.toHaveProperty('pwaSettings');
  });

  it('an icon write on a store with no settings stores the icons and nothing invented', async () => {
    const icons = {
      icon192: 'https://cdn.example.com/192.png',
      icon512: 'https://cdn.example.com/512.png',
    };
    const { written } = await update(null, { settings: icons });
    expect(written.pwaSettings).toEqual(icons);
  });

  it('a partial write merges over what was stored, and only that', async () => {
    const { written } = await update(
      { appName: 'Merchant App', themeColor: '#123456' },
      { settings: { themeColor: '#654321', descriptionAr: 'عيش طازة' } }
    );
    expect(written.pwaSettings).toEqual({
      appName: 'Merchant App',
      themeColor: '#654321',
      descriptionAr: 'عيش طازة',
    });
  });

  it('the RESPONSE still carries a default for every unset field (the admin form reads it)', async () => {
    const { result } = await update(null, { settings: { themeColor: '#123456' } });
    expect(result.settings).toMatchObject({
      appName: 'Demo Shop',
      shortName: 'Demo Shop',
      description: 'Shop at Demo Shop',
      themeColor: '#123456',
      backgroundColor: '#ffffff',
      display: 'standalone',
      startUrl: '/',
    });
  });

  it('the settings READ is unchanged: stored values over the defaults', async () => {
    findUniqueMock.mockResolvedValue({
      name: 'Demo Shop',
      pwaEnabled: false,
      pwaSettings: { appName: 'Merchant App' },
    });
    const { PWAService } = await import('@api/services/pwa.service');
    const read = await PWAService.getSettings(STORE_ID);
    expect(read.pwaEnabled).toBe(false);
    expect(read.settings).toMatchObject({
      appName: 'Merchant App',
      shortName: 'Demo Shop',
      description: 'Shop at Demo Shop',
      backgroundColor: '#ffffff',
    });
  });
});
