// @vitest-environment jsdom
/**
 * TEMPLATES-MOCK-2/-3 (P1): the designed wordmark lockup is the default for a store with no logo, and the
 * merchant can opt out of it (`theme.headerWordmark = 'plain'`) from the visual editor's Header group.
 * A merchant logo always wins; the key is a validated, resettable draft override.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import {
  DRAFT_THEME_KEYS,
  HEADER_WORDMARKS,
  LOOK_OWNED_THEME_KEYS,
  THEME_SETTINGS_SCHEMA,
  applyThemePatch,
  draftThemeSchema,
  getLook,
  isShown,
  overriddenLookKeys,
  resolveLockup,
  traitDefault,
} from '@ebda/shared';
import { themeSchema } from '../../apps/api/src/lib/theme-schema';

const ctx = vi.hoisted(() => ({
  store: { id: 's', name: 'Demo', template: 'qamar', look: 'qamar.atelier', theme: {} } as Record<
    string,
    unknown
  >,
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
      language: 'ar',
      direction: 'rtl',
      isRtl: true,
      setLanguage: () => {},
      t: (_en: string, ar: string) => ar,
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
  dahab: (await import('../../apps/web/src/templates/dahab/Header')).default,
};
const nav = [{ href: '/products', label: 'Products', labelAr: 'المنتجات' }];

function lockupShown(
  template: keyof typeof headers,
  look: string,
  theme: Record<string, unknown>,
  logo: string | null = null
) {
  ctx.store = { ...ctx.store, template, look, theme };
  const Header = headers[template];
  const { container } = render(
    <Header
      branding={{ name: 'Demo', nameAr: 'تجربة', logo }}
      nav={nav}
      urlPrefix=""
      isRtl
      /* eslint-disable-line */
    />
  );
  const has = container.querySelector('[data-lockup]') !== null;
  cleanup();
  return has;
}
afterEach(cleanup);

const CASES = [
  ['qamar', 'qamar.atelier'],
  ['souq', 'souq.catalogue'],
  ['jasmine', 'jasmine.bloom'],
  ['lamma', 'lamma.table'],
  ['dahab', 'dahab.worn'],
] as const;

describe('headerWordmark (P1)', () => {
  for (const [template, look] of CASES) {
    it(`${look}: lockup by default, plain when the merchant picks it, never over a logo`, () => {
      expect(lockupShown(template, look, {})).toBe(true);
      expect(lockupShown(template, look, { headerWordmark: 'lockup' })).toBe(true);
      expect(lockupShown(template, look, { headerWordmark: 'plain' })).toBe(false);
      expect(lockupShown(template, look, {}, 'https://media.ebda.app/x/logo.png')).toBe(false);
    });
  }

  it('resolveLockup: merchant plain beats the look; unset and clearing give the lockup back', () => {
    expect(resolveLockup({}, 'qamar.atelier', 'qamar')).not.toBeNull();
    expect(resolveLockup({ headerWordmark: 'plain' }, 'qamar.atelier', 'qamar')).toBeNull();
    const cleared = applyThemePatch({ headerWordmark: 'plain' }, { headerWordmark: null });
    expect(resolveLockup(cleared, 'qamar.atelier', 'qamar')).not.toBeNull();
    expect(resolveLockup(undefined, null, 'dahab')).not.toBeNull(); // look-less store: its template's lockup
  });

  it('is a validated, resettable draft override owned by the look reset', () => {
    expect(DRAFT_THEME_KEYS).toContain('headerWordmark');
    expect(draftThemeSchema.safeParse({ headerWordmark: 'plain' }).success).toBe(true);
    expect(draftThemeSchema.safeParse({ headerWordmark: null }).success).toBe(true);
    expect(themeSchema.safeParse({ headerWordmark: 'plain' }).success).toBe(true);
    expect(themeSchema.safeParse({ headerWordmark: null }).success).toBe(true);
    expect(themeSchema.safeParse({ headerWordmark: 'huge' }).success).toBe(false);
    expect(themeSchema.safeParse({ headerWordmark: '<script>' }).success).toBe(false);
    for (const v of HEADER_WORDMARKS)
      expect(themeSchema.safeParse({ headerWordmark: v }).success).toBe(true);
    expect(LOOK_OWNED_THEME_KEYS).toContain('headerWordmark');
    expect(overriddenLookKeys({ headerWordmark: 'plain' }, getLook('qamar.atelier')!)).toContain(
      'headerWordmark'
    );
  });

  it('the editor control sits in the Header group, on every built skin, and shows the look value when unset', () => {
    const group = THEME_SETTINGS_SCHEMA.find(g => g.id === 'header')!;
    const c = group.settings.find(s => s.id === 'headerWordmark')!;
    expect(c.trait).toBe(true);
    for (const t of ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'])
      expect(isShown(c, { template: t })).toBe(true);
    expect(c.labelAr.length).toBeGreaterThan(2);
    expect(c.hintAr?.length).toBeGreaterThan(10);
    expect(traitDefault('headerWordmark', 'qamar.atelier')).toBe('lockup');
  });
});
