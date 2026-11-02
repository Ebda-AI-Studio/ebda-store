// @vitest-environment jsdom
/**
 * Phase B4 Task 2 (Ruling B4-1): the Lamma header. The look's logo placement drives the minimal
 * header; one banner landmark, named navs, >= 44px targets, a 30+ character store name that cannot
 * reach the actions, and the chrome keys other skins ignore.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({
  store: {
    id: 'store-l',
    name: 'Lamma Demo',
    template: 'lamma',
    look: 'lamma.table',
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

const { default: LammaHeader } = await import('../../apps/web/src/templates/lamma/Header');

const branding = { name: 'Lamma Demo', nameAr: 'لمّة التجريبي', logo: null };
const nav = [
  { href: '/products', label: 'Products', labelAr: 'المنتجات' },
  { href: '/about', label: 'About', labelAr: 'عنّا' },
];
function setLook(look: string | null, lang: 'en' | 'ar' = 'ar') {
  ctx.store = { ...ctx.store, template: 'lamma', look, theme: {} };
  ctx.language = lang;
}
afterEach(cleanup);

const PLACEMENT = {
  'lamma.table': 'start',
  'lamma.notebook': 'centre',
  'lamma.market': 'start',
} as const;

describe('lamma header', () => {
  for (const [look, placement] of Object.entries(PLACEMENT)) {
    it(`${look}: logo ${placement}, icon search, every control a >= 44px target`, () => {
      setLook(look, 'ar');
      const { container } = render(<LammaHeader branding={branding} navigation={nav} isLoggedIn />);
      expect(
        container.querySelector('[data-logo-placement]')!.getAttribute('data-logo-placement')
      ).toBe(placement);
      expect(container.querySelector('form[role="search"]')).toBeNull();
      expect(smallTargets(container, 44)).toEqual([]);
    });
  }
  it('an unknown or absent look falls back to start and never throws', () => {
    for (const look of ['lamma.gone', null]) {
      setLook(look);
      const { container } = render(<LammaHeader branding={branding} />);
      expect(
        container.querySelector('[data-logo-placement]')!.getAttribute('data-logo-placement')
      ).toBe('start');
      cleanup();
    }
  });
  it('one banner, every nav named (landmarks gate)', () => {
    setLook('lamma.market');
    const { container } = render(<LammaHeader branding={branding} navigation={nav} />);
    expect(container.querySelectorAll('header, [role="banner"]')).toHaveLength(1);
    for (const n of Array.from(container.querySelectorAll('nav')))
      expect(n.getAttribute('aria-label'), n.outerHTML.slice(0, 60)).toBeTruthy();
  });
  it('a 30+ character store name is truncated in a capped slot and cannot reach the actions', () => {
    setLook('lamma.table', 'ar');
    const longName = 'مطبخ أم سلمى للأكل البيتي والمحاشي والطواجن والحلويات الشرقية';
    const { container } = render(
      <LammaHeader branding={{ ...branding, nameAr: longName }} navigation={nav} />
    );
    expect(container.querySelector('a[href="/"]')!.getAttribute('class')).toContain(
      'max-w-[calc(100%-13rem)]'
    );
    const mark = container.querySelector('[data-zone="storeName"]')!;
    expect(mark.firstElementChild!.getAttribute('class')).toMatch(/\bline-clamp-2\b/);
    expect(mark.getAttribute('title')).toBe(longName);
  });
  it('the cart bar, stepper and aisles chrome keys exist on the Lamma looks and nowhere else', async () => {
    const { LOOKS } = await import('@ebda/shared');
    for (const l of LOOKS) {
      const isLamma = l.template === 'lamma';
      expect(l.chrome?.cartBar === 'total', `${l.id} cartBar`).toBe(isLamma);
      expect(l.chrome?.cardStepper === 'inline', `${l.id} cardStepper`).toBe(isLamma);
    }
    expect(LOOKS.find(l => l.id === 'lamma.market')!.chrome?.aisles).toEqual([
      '#23744A',
      '#CC2F3F',
      '#5B2A6E',
      '#0F7F8C',
    ]);
  });
});
