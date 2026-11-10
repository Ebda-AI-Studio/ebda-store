/**
 * Root-layout head metadata for the storefront.
 *
 * #1844 — a suspended store's maintenance page is a 200, so its noindex must
 *         be in <head> (generateMetadata), not an inert body <meta>.
 * #1856 — the fallback <meta name="description"> / og:locale follow the SAME
 *         cookie-then-default locale as <html lang>.
 * #1855 — home/categories never emit a canonical for an unresolved store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  store: {} as Record<string, unknown>,
  cookieLang: undefined as string | undefined,
  urlLang: undefined as string | undefined,
};

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) =>
      k === 'host' ? 'shop.example' : k === 'x-locale-path' ? (state.urlLang ?? null) : null,
  }),
  cookies: async () => ({
    get: (k: string) =>
      k === 'force-language' && state.cookieLang ? { value: state.cookieLang } : undefined,
  }),
}));
vi.mock('next/font/google', () => {
  const font = () => ({ className: 'f', variable: '--f', style: { fontFamily: 'f' } });
  return { Plus_Jakarta_Sans: font, IBM_Plex_Sans_Arabic: font, Amiri: font, Marcellus: font };
});
vi.mock('../../apps/web/src/lib/store-resolver', async importOriginal => {
  const real = await importOriginal<typeof import('../../apps/web/src/lib/store-resolver')>();
  return {
    ...real,
    getStore: async () => state.store,
    getStoreOrNotFound: async () => state.store,
  };
});

const BASE = {
  id: 'store-1',
  slug: 'shop',
  name: 'Shop',
  nameAr: 'المتجر',
  domain: 'shop.example',
  status: 'active',
  settings: { defaultLanguage: 'en' },
  description: 'An English description',
  descriptionAr: 'وصف عربي',
};

beforeEach(() => {
  state.store = { ...BASE };
  state.cookieLang = undefined;
  state.urlLang = undefined;
});

describe('root layout generateMetadata', () => {
  it('#1844: a suspended store is noindex in the head', async () => {
    state.store = { ...BASE, status: 'suspended' };
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('B1-14: the demo showroom (isDemo) is noindex, nofollow in the head', async () => {
    state.store = { ...BASE, isDemo: true };
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('#1844: an active store is not noindexed', async () => {
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect(meta.robots).not.toEqual({ index: false, follow: false });
  });

  it('#1856: an Arabic cookie on an English-default store gives Arabic head copy', async () => {
    state.cookieLang = 'ar';
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect((meta.openGraph as { locale?: string }).locale).toBe('ar_EG');
    expect(String(meta.description)).toMatch(/[؀-ۿ]/);
  });

  it('#1856: no cookie keeps the store default', async () => {
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect((meta.openGraph as { locale?: string }).locale).toBe('en_US');
  });
});

describe('the manifest link follows the language in the URL (Ruling PWA-MANIFEST-2)', () => {
  const meta = async () =>
    (await import('../../apps/web/src/app/layout')).generateMetadata() as Promise<{
      manifest?: unknown;
    }>;

  it('a /en page links the English manifest, a /ar page the Arabic one, whatever the cookie says', async () => {
    state.urlLang = 'en';
    state.cookieLang = 'ar';
    expect((await meta()).manifest).toBe('/en/manifest.webmanifest');
    state.urlLang = 'ar';
    state.cookieLang = 'en';
    expect((await meta()).manifest).toBe('/ar/manifest.webmanifest');
  });

  it('a page with no language in its URL links the shared manifest', async () => {
    expect((await meta()).manifest).toBe('/manifest.webmanifest');
    state.cookieLang = 'ar';
    expect((await meta()).manifest).toBe('/manifest.webmanifest');
  });

  it('every branch keeps a manifest link: an unreachable store and the platform 404 too', async () => {
    state.urlLang = 'en';
    state.store = { ...BASE, transientResolveFailure: true };
    expect((await meta()).manifest).toBe('/en/manifest.webmanifest');
    state.store = { ...BASE, id: 'demo', slug: 'demo', domain: undefined };
    expect((await meta()).manifest).toBe('/en/manifest.webmanifest');
    state.urlLang = undefined;
    expect((await meta()).manifest).toBe('/manifest.webmanifest');
  });
});

describe('#1855: canonical only for a resolved store', () => {
  const transient = {
    ...BASE,
    id: 'demo',
    slug: 'demo',
    domain: undefined,
    transientResolveFailure: true,
  };

  it('home: no canonical during a transient resolve failure', async () => {
    state.store = transient;
    const { generateMetadata } = await import('../../apps/web/src/app/page');
    expect((await generateMetadata()).alternates).toBeUndefined();
  });

  it('categories: no canonical during a transient resolve failure', async () => {
    state.store = transient;
    const { generateMetadata } = await import('../../apps/web/src/app/categories/page');
    expect((await generateMetadata()).alternates).toBeUndefined();
  });

  it('home + categories keep their canonical for a resolved store', async () => {
    const home = await (await import('../../apps/web/src/app/page')).generateMetadata();
    const cats = await (await import('../../apps/web/src/app/categories/page')).generateMetadata();
    expect(home.alternates?.canonical).toBe('https://shop.example');
    expect(cats.alternates?.canonical).toBe('https://shop.example/categories');
  });
});
