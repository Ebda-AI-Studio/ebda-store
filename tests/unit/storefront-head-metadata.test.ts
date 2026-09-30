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
};

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => (k === 'host' ? 'shop.example' : null) }),
  cookies: async () => ({
    get: (k: string) =>
      k === 'force-language' && state.cookieLang ? { value: state.cookieLang } : undefined,
  }),
}));
vi.mock('next/font/google', () => {
  const font = () => ({ className: 'f', variable: '--f', style: { fontFamily: 'f' } });
  return { Plus_Jakarta_Sans: font, IBM_Plex_Sans_Arabic: font };
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
});

describe('root layout generateMetadata', () => {
  it('#1844: a suspended store is noindex in the head', async () => {
    state.store = { ...BASE, status: 'suspended' };
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
    expect((meta.openGraph as { locale?: string }).locale).toBe('ar_KW');
    expect(String(meta.description)).toMatch(/[؀-ۿ]/);
  });

  it('#1856: no cookie keeps the store default', async () => {
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect((meta.openGraph as { locale?: string }).locale).toBe('en_KW');
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
