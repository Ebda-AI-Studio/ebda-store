/**
 * Phase B2 Task 2 (C16 pattern): the plain MinimalHeader is byte-identical for every caller that
 * does not pass the Souq-only `searchPlacement`. The stored files are the same pre-change
 * snapshots tests/unit/qamar-chrome-render.test.tsx pins (generated before B1 touched the header).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';

const ctx = vi.hoisted(() => ({
  store: { id: 'store-m', name: 'Demo', template: 'qamar', look: null, theme: {} } as Record<
    string,
    unknown
  >,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ({}),
  useStoreTemplate: () => ctx.store.template,
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: ctx.store.name }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.language,
      direction: ctx.language === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.language === 'ar',
      setLanguage: () => {},
      t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], bundles: [], itemCount: 0, total: 0 }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: MinimalHeader } = await import('../../apps/web/src/templates/base/Header');

const branding = { name: 'Qamar Demo', nameAr: 'قمر', logo: null };
const nav = [
  { href: '/shop', label: 'Shop', labelAr: 'تسوّق' },
  { href: '/about', label: 'About', labelAr: 'عنّا' },
];
const SNAP_DIR = path.join(__dirname, '..', 'fixtures', 'builder', '__snapshots__');

describe('minimal header is unchanged without searchPlacement', () => {
  for (const lang of ['ar', 'en'] as const) {
    it(`markup matches the pre-change snapshot (${lang})`, async () => {
      ctx.language = lang;
      const html = renderToStaticMarkup(
        <MinimalHeader branding={branding} navigation={nav} cartItemCount={2} />
      );
      await expect(html).toMatchFileSnapshot(path.join(SNAP_DIR, `minimal-header-${lang}.html`));
    });
    it(`searchPlacement="icon" is the same markup as no prop (${lang})`, () => {
      ctx.language = lang;
      const plain = renderToStaticMarkup(
        <MinimalHeader branding={branding} navigation={nav} cartItemCount={2} />
      );
      const icon = renderToStaticMarkup(
        <MinimalHeader
          branding={branding}
          navigation={nav}
          cartItemCount={2}
          searchPlacement="icon"
        />
      );
      expect(icon).toBe(plain);
    });
  }
  it('only "prominent" changes anything: it removes the hidden search rows and adds the field', () => {
    ctx.language = 'en';
    const html = renderToStaticMarkup(
      <MinimalHeader branding={branding} navigation={nav} searchPlacement="prominent" />
    );
    expect(html).toContain('role="search"');
    expect(html).not.toContain('data-zone="mobile-search"');
  });
});
