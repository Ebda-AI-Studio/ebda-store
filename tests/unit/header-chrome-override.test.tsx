// @vitest-environment jsdom
/**
 * Task 10 / Ruling EP-4: the merchant's header chrome override reaches the four headers built on
 * the minimal header, and a store with no override draws exactly what its look says.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

const ctx = vi.hoisted(() => ({
  store: {
    id: 'store-j',
    name: 'Jasmine Demo',
    template: 'qamar',
    look: 'qamar.atelier',
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

const headers = {
  qamar: (await import('../../apps/web/src/templates/qamar/Header')).default,
  souq: (await import('../../apps/web/src/templates/souq/Header')).default,
  jasmine: (await import('../../apps/web/src/templates/jasmine/Header')).default,
  lamma: (await import('../../apps/web/src/templates/lamma/Header')).default,
};
const branding = { name: 'Demo', nameAr: 'تجربة', logo: null };
const nav = [{ href: '/products', label: 'Products', labelAr: 'المنتجات' }];

function placement(template: keyof typeof headers, look: string, theme: Record<string, unknown>) {
  ctx.store = { ...ctx.store, template, look, theme };
  ctx.language = 'en';
  const Header = headers[template];
  const { container } = render(
    <Header branding={branding} nav={nav} urlPrefix="" isRtl={false} /* eslint-disable-line */ />
  );
  const el = container.querySelector('[data-logo-placement]');
  cleanup();
  return el?.getAttribute('data-logo-placement');
}
afterEach(cleanup);

const CASES = [
  ['qamar', 'qamar.atelier', 'start'],
  ['qamar', 'qamar.vitrine', 'centre'],
  ['souq', 'souq.catalogue', 'start'],
  ['jasmine', 'jasmine.bloom', 'start'],
  ['lamma', 'lamma.table', 'start'],
] as const;

describe('header chrome override', () => {
  for (const [template, look, lookValue] of CASES) {
    it(`${look}: no override = the look (${lookValue}); the merchant's pick wins; clearing restores`, () => {
      expect(placement(template, look, {})).toBe(lookValue);
      const other = lookValue === 'start' ? 'centre' : 'start';
      expect(placement(template, look, { headerLogoPlacement: other })).toBe(other);
      expect(placement(template, look, {})).toBe(lookValue);
    });
  }
});
