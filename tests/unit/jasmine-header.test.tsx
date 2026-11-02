// @vitest-environment jsdom
/**
 * Phase B3 Task 2 (Ruling B3-1): the Jasmine header. Logo-forward (the sized, untracked display
 * wordmark leads), the skin's own icon search, one banner, named navs, >= 44px targets, an opaque
 * focus ring, and a 30+ character store name that cannot reach the actions.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({
  store: {
    id: 'store-j',
    name: 'Jasmine Demo',
    template: 'jasmine',
    look: 'jasmine.bloom',
    theme: {},
  } as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
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

const { default: JasmineHeader } = await import('../../apps/web/src/templates/jasmine/Header');

const branding = { name: 'Jasmine Demo', nameAr: 'ياسمين التجربة', logo: null };
const nav = [
  { href: '/products', label: 'Products', labelAr: 'المنتجات' },
  { href: '/about', label: 'About', labelAr: 'عنّا' },
];
function setLook(look: string | null, lang: 'en' | 'ar' = 'ar') {
  ctx.store = { ...ctx.store, template: 'jasmine', look, theme: {} };
  ctx.language = lang;
}
afterEach(cleanup);

const LOOKS = ['jasmine.apothecary', 'jasmine.bloom', 'jasmine.clinic'];

describe('jasmine header', () => {
  for (const look of LOOKS) {
    it(`${look}: icon search (no prominent field), every control is a >= 44px target`, () => {
      setLook(look, 'ar');
      const { container } = render(
        <JasmineHeader branding={branding} navigation={nav} isLoggedIn />
      );
      expect(container.querySelector('form[role="search"]')).toBeNull();
      expect(
        container.querySelector('button[aria-label="بحث"], button[aria-label="Search"]')
      ).not.toBeNull();
      expect(smallTargets(container, 44)).toEqual([]);
    });
  }
  it('an unknown or absent look falls back to the icon search and never throws', () => {
    setLook('jasmine.gone');
    expect(
      render(<JasmineHeader branding={branding} />).container.querySelector('form[role="search"]')
    ).toBeNull();
    cleanup();
    setLook(null);
    expect(
      render(<JasmineHeader branding={branding} />).container.querySelector('form[role="search"]')
    ).toBeNull();
  });
  it('one banner, every nav named (landmarks gate)', () => {
    setLook('jasmine.clinic');
    const { container } = render(<JasmineHeader branding={branding} navigation={nav} />);
    expect(container.querySelectorAll('header, [role="banner"]')).toHaveLength(1);
    for (const n of Array.from(container.querySelectorAll('nav')))
      expect(n.getAttribute('aria-label'), n.outerHTML.slice(0, 60)).toBeTruthy();
  });
  it('logo-forward: the wordmark is the sized, untracked display one and out-ranks the 14px nav', () => {
    setLook('jasmine.apothecary', 'en');
    const { container } = render(<JasmineHeader branding={branding} navigation={nav} />);
    // G1 (template-match): a store with no logo gets the look's lockup; its name is far bigger than the 14px nav.
    const lockup = container.querySelector('[data-zone="storeName"]')!;
    expect(lockup.getAttribute('data-lockup')).toBeTruthy();
    expect(
      Number.parseInt((lockup.firstElementChild as HTMLElement).style.fontSize, 10)
    ).toBeGreaterThanOrEqual(28);
    expect(lockup.outerHTML).not.toMatch(/ui-caps-toggle/);
    expect(container.querySelector('a[href="/products"]')!.getAttribute('class')).toContain(
      'text-sm'
    );
    expect(
      container.querySelector('[data-logo-placement]')!.getAttribute('data-logo-placement')
    ).toBe('start');
  });
  it('a 30+ character store name is truncated in a capped slot (full name in the title) and cannot reach the actions', () => {
    setLook('jasmine.bloom', 'ar');
    const longName = 'متجر ياسمين للعناية بالبشرة والجمال والمكياج الطبيعي';
    const { container } = render(
      <JasmineHeader branding={{ ...branding, nameAr: longName }} navigation={nav} />
    );
    const logo = container.querySelector('a[href="/"]')!;
    // the logo slot is capped at 65% of the row on a phone, so the actions always keep their room
    expect(logo.getAttribute('class')).toContain('max-w-[calc(100%-13rem)]');
    const mark = container.querySelector('[data-zone="storeName"]')!;
    expect(mark.firstElementChild!.getAttribute('class')).toMatch(/\bline-clamp-2\b/);
    expect(mark.getAttribute('title')).toBe(longName);
  });
  it('the look data, not the component, decides the placement (chrome on every Jasmine look)', async () => {
    const { getLook } = await import('@ebda/shared');
    for (const id of LOOKS) {
      expect(getLook(id)?.chrome?.header, id).toEqual({ logoPlacement: 'start', search: 'icon' });
    }
  });
});
