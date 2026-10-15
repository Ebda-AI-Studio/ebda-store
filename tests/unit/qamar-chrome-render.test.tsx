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

// W2a T-01 + decision (a): the look sizes the wordmark (composed theme `wordmarkSize`), the nav is
// 14px untracked, and the checkout/success chrome shows the SAME wordmark.
const { composeStoreTheme } = await import('@ebda/shared');
const { WORDMARK_NAV_LINK_CLASS, wordmarkClass } =
  await import('../../apps/web/src/templates/shared/wordmark');
const { MinimalChrome } = await import('../../apps/web/src/components/MinimalChrome');
const globalsCss = (await import('node:fs')).readFileSync(
  path.resolve(__dirname, '../../apps/web/src/styles/globals.css'),
  'utf8'
);

describe('look-sized wordmark (W2a T-01)', () => {
  const withTheme = (look: string, theme: Record<string, unknown> = {}) => {
    ctx.store = {
      ...ctx.store,
      template: 'qamar',
      look,
      theme: composeStoreTheme({ template: 'qamar', look, theme }),
    };
    ctx.language = 'en';
  };

  it('Atelier: 24px display wordmark, never tracked or uppercased; nav 14px untracked', () => {
    withTheme('qamar.atelier');
    const html = renderToStaticMarkup(<QamarHeader branding={branding} navigation={nav} />);
    const mark = html.match(/<span[^>]*data-zone="storeName"[^>]*>/)![0];
    expect(mark).toContain(wordmarkClass('lg'));
    expect(mark).toContain('text-2xl');
    expect(mark).not.toMatch(/tracking-\[|ui-caps-toggle|uppercase/);
    const link = html.match(/<a[^>]*href="\/shop"[^>]*>/)![0];
    expect(link).toContain(WORDMARK_NAV_LINK_CLASS);
    expect(link).toContain('text-sm');
    expect(link).not.toMatch(/text-\[11px\]|tracking-\[/);
  });
  it('the wordmark is >= 1.25x the largest other header text (24px vs nav 14px)', () => {
    // text-2xl = 1.5rem = 24px, text-sm = 0.875rem = 14px
    expect(24 / 14).toBeGreaterThanOrEqual(1.25);
    expect(wordmarkClass('lg')).toMatch(/(^| )text-2xl( |$)/);
    expect(WORDMARK_NAV_LINK_CLASS).toMatch(/(^| )text-sm( |$)/);
  });
  it('Vitrine keeps its centred 24/30px wordmark through the token', () => {
    withTheme('qamar.vitrine');
    const html = renderToStaticMarkup(<QamarHeader branding={branding} />);
    expect(html).toContain(wordmarkClass('xl'));
    expect(html).toContain('text-2xl sm:text-3xl');
  });
  it('a merchant value beats the look (merchant > look)', () => {
    withTheme('qamar.atelier', { wordmarkSize: 'xl' });
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain(
      wordmarkClass('xl')
    );
  });
  it('the plain minimal header (no prop) keeps its tracked wordmark and nav', () => {
    ctx.store = { ...ctx.store, template: 'minimal', look: null, theme: {} };
    const html = renderToStaticMarkup(<MinimalHeader branding={branding} navigation={nav} />);
    expect(html).toContain('text-xs tracking-[0.3em] ui-caps-toggle font-light text-foreground');
    expect(html).toContain('text-[11px] tracking-[0.18em] ui-caps-toggle');
  });
  it('checkout/success chrome renders the same wordmark on a look store, the old one otherwise', () => {
    withTheme('qamar.atelier');
    ctx.store = { ...ctx.store, name: 'Qamar Demo', logo: null };
    const look = renderToStaticMarkup(<MinimalChrome>x</MinimalChrome>);
    expect(look).toContain(wordmarkClass('lg'));
    ctx.store = { ...ctx.store, template: 'minimal', look: null, theme: {} };
    const legacy = renderToStaticMarkup(<MinimalChrome>x</MinimalChrome>);
    expect(legacy).toContain('text-2xl font-bold text-primary sm:text-3xl');
    expect(legacy).not.toContain('data-zone="storeName"');
  });
});

describe('qamar type rules in globals.css (decision (a), T-02)', () => {
  const css = globalsCss;
  it('no letter-spaced or uppercased chrome under the qamar skin', () => {
    const at = css.indexOf("[data-pack='qamar']\n  :is(\n    .ui-caps-toggle,");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    for (const sel of ['.uppercase', '.tracking-widest', "[class*='tracking-[0.']"])
      expect(block).toContain(sel);
    expect(block).toContain('letter-spacing: normal;');
    expect(block).toContain('text-transform: none;');
  });
  it('filter group headings take the body face on qamar stores', () => {
    expect(css).toMatch(
      /html\[lang\] \[data-pack='qamar'\] \[data-zone='filters'\] :is\(h2, h3, h4, legend\) \{\s*font-family: var\(--font-body, inherit\);/
    );
  });
});
