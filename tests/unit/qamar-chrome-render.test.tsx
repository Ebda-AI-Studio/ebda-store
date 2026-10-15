/**
 * Qamar chrome (Phase B1, Task 5): the header wrapper reads the look's wordmark
 * placement; the plain MinimalHeader is byte-identical to before (C16).
 * Same mocking as dahab-template-render (store / language contexts, next/navigation).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';

const ctx = vi.hoisted(() => ({
  store: { id: 'store-q', name: 'Qamar Demo', template: 'qamar', look: null } as Record<
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

const { default: QamarHeader } = await import('../../apps/web/src/templates/qamar/Header');
const { default: MinimalHeader } = await import('../../apps/web/src/templates/minimal/Header');

const branding = { name: 'Qamar Demo', nameAr: 'قمر', logo: null };
const nav = [
  { href: '/shop', label: 'Shop', labelAr: 'تسوّق' },
  { href: '/about', label: 'About', labelAr: 'عنّا' },
];
const SNAP_DIR = path.join(__dirname, '..', 'fixtures', 'builder', '__snapshots__');

function setLook(look: string | null, lang: 'en' | 'ar' = 'ar') {
  ctx.store = { ...ctx.store, template: 'qamar', look };
  ctx.language = lang;
}

describe('qamar header', () => {
  it('centres the wordmark when the look says centre', () => {
    setLook('qamar.vitrine');
    const html = renderToStaticMarkup(<QamarHeader branding={branding} navigation={nav} />);
    expect(html).toContain('data-logo-placement="centre"');
    expect(html).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    expect(html).toContain('قمر');
  });
  it('keeps the wordmark at the start for Atelier', () => {
    setLook('qamar.atelier');
    const html = renderToStaticMarkup(<QamarHeader branding={branding} />);
    expect(html).toContain('data-logo-placement="start"');
    expect(html).not.toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
  });
  it('an unknown or absent look falls back to start, never throws', () => {
    setLook('qamar.gone');
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain(
      'data-logo-placement="start"'
    );
    setLook(null);
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain(
      'data-logo-placement="start"'
    );
  });
  it('a missing logo still shows the store name in both locales', () => {
    setLook('qamar.atelier', 'ar');
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain('قمر');
    setLook('qamar.atelier', 'en');
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain('Qamar Demo');
  });
  it('caps and truncates a very long Arabic name so it cannot reach the actions', () => {
    setLook('qamar.vitrine', 'ar');
    const longName = 'متجر قمر للأزياء والمناسبات الراقية والأنيقة جدا';
    const html = renderToStaticMarkup(<QamarHeader branding={{ ...branding, nameAr: longName }} />);
    expect(html).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    expect(html).toContain('max-w-[calc(100%-13rem)]');
    expect(html).toContain('min-w-0');
    expect(html).toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*title="/);
    expect(html).toContain(`title="${longName}"`);
  });
  it('keeps cart, search and menu accessible in centre mode', () => {
    setLook('qamar.vitrine', 'en');
    const html = renderToStaticMarkup(<QamarHeader branding={branding} />);
    expect(html).toContain('aria-label="Cart (0 items)"');
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain('aria-label="Menu"');
  });
});

describe('minimal header is unchanged for every non-Qamar caller (C16)', () => {
  it('has no placement attribute without the prop', () => {
    ctx.store = { ...ctx.store, template: 'minimal', look: null };
    expect(renderToStaticMarkup(<MinimalHeader branding={branding} />)).not.toContain(
      'data-logo-placement'
    );
  });
  for (const lang of ['ar', 'en'] as const) {
    it(`markup matches the pre-change snapshot (${lang})`, async () => {
      ctx.store = { ...ctx.store, template: 'minimal', look: null };
      ctx.language = lang;
      const html = renderToStaticMarkup(
        <MinimalHeader branding={branding} navigation={nav} cartItemCount={2} />
      );
      await expect(html).toMatchFileSnapshot(path.join(SNAP_DIR, `minimal-header-${lang}.html`));
    });
  }
});
