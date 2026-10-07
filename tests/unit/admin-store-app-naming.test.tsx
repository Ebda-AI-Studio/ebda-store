// @vitest-environment jsdom
/**
 * Merchant app naming + language toggle (Ahmad 2026-10-07): every surface reads the
 * PRODUCT name ("Ebda Store" / «ابدأ ستور») from BRAND.product, and the AR/EN
 * toggle switches + persists the locale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BRAND } from '@force/shared';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

// Node's experimental localStorage throws without a file; use an in-memory one.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const m = vi.hoisted(() => ({ locale: 'ar' as 'ar' | 'en' }));
type Msgs = { [k: string]: string | Msgs };
const MSGS: Record<string, Msgs> = { en: en as Msgs, ar: ar as Msgs };
const lookup = (ns: string, key: string): string => {
  const path = `${ns}.${key}`.split('.');
  let cur: string | Msgs = MSGS[m.locale];
  for (const p of path) cur = (cur as Msgs)[p];
  return cur as string;
};

vi.mock('next-intl', () => ({
  useLocale: () => m.locale,
  useTranslations: (ns: string) => (key: string) => lookup(ns, key),
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => m.locale,
  getTranslations: async (ns: string) => (key: string) => lookup(ns, key),
}));

vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'f' }),
  IBM_Plex_Sans_Arabic: () => ({ variable: 'f' }),
}));
vi.mock('../../apps/admin/src/app/providers', () => ({ Providers: () => null }));
vi.mock('../../apps/admin/src/styles/globals.css', () => ({}));

import { productName, pageTitle } from '../../apps/admin/src/lib/product-name';
import { DocumentTitle } from '../../apps/admin/src/components/DocumentTitle';
import AdminLanguageSwitcher from '../../apps/admin/src/components/AdminLanguageSwitcher';
import manifest from '../../apps/admin/src/app/manifest';
import { generateMetadata } from '../../apps/admin/src/app/layout';

const LOCALES = ['en', 'ar'] as const;
const NAME = { en: 'Ebda Store', ar: 'ابدأ ستور' } as const;

beforeEach(() => {
  m.locale = 'ar';
  document.cookie = 'admin-lang=; max-age=0; path=/';
  localStorage.clear();
});
afterEach(cleanup);

describe('product name', () => {
  it.each(LOCALES)('%s reads BRAND.product', loc => {
    expect(productName(loc)).toBe(NAME[loc]);
    expect(BRAND.product[loc === 'ar' ? 'nameAr' : 'nameEn']).toBe(NAME[loc]);
  });
  it.each(LOCALES)('%s page title pattern + default', loc => {
    expect(pageTitle('X', loc)).toBe(`X · ${NAME[loc]}`);
    expect(pageTitle('', loc)).toBe(NAME[loc]);
    expect(pageTitle(undefined, loc)).toBe(NAME[loc]);
  });
});

describe.each(LOCALES)('%s surfaces', loc => {
  beforeEach(() => {
    m.locale = loc;
  });

  it('root metadata: title default/template, app title', async () => {
    const md = await generateMetadata();
    expect(md.title).toEqual({ default: NAME[loc], template: `%s · ${NAME[loc]}` });
    expect(md.applicationName).toBe(NAME[loc]);
    expect(md.appleWebApp).toMatchObject({ title: NAME[loc] });
  });

  it('manifest name/short_name/description never say Admin', async () => {
    const mf = await manifest();
    expect(mf.name).toBe(NAME[loc]);
    expect(mf.short_name).toBe(NAME[loc]);
    expect(mf.description).toContain(NAME[loc]);
    expect(JSON.stringify([mf.name, mf.short_name, mf.description])).not.toMatch(/admin/i);
    expect(mf.lang).toBe(loc);
  });

  it('DocumentTitle sets "<page> · name"', () => {
    render(<DocumentTitle title="Orders" />);
    expect(document.title).toBe(`Orders · ${NAME[loc]}`);
  });

  it('sidebar product label (prefix + brand) spells the product name', () => {
    const c = (loc === 'en' ? en : ar).components.adminLayout;
    expect(`${c.forceBrandPrefix} ${c.forceAdminBrand}`).toBe(NAME[loc]);
  });

  it('product-naming copy carries no "Admin"', () => {
    const msgs = (loc === 'en' ? en : ar) as unknown as Msgs;
    const keys = [
      'pwa.installHint.title',
      'pwa.installHint.step3',
      'auth.login.title',
      'auth.login.footer',
      'auth.login.subtitle',
      'common.errors.global.title',
      'common.errors.global.message',
    ];
    for (const k of keys) {
      let cur: string | Msgs = msgs;
      for (const p of k.split('.')) cur = (cur as Msgs)[p];
      expect(cur, k).not.toMatch(/admin|أدمن/i);
    }
  });
});

describe('language toggle', () => {
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  it('Arabic UI shows «English»; click persists en (cookie + localStorage) and reloads', () => {
    m.locale = 'ar';
    render(<AdminLanguageSwitcher />);
    const btn = screen.getByTestId('language-toggle');
    expect(btn.textContent).toContain('English');
    expect(btn.getAttribute('lang')).toBe('en');
    fireEvent.click(btn);
    expect(document.cookie).toContain('admin-lang=en');
    expect(localStorage.getItem('admin-lang')).toBe('en');
    expect(reload).toHaveBeenCalled();
  });

  it('English UI shows «العربية»; click persists ar with rtl button', () => {
    m.locale = 'en';
    render(<AdminLanguageSwitcher />);
    const btn = screen.getByTestId('language-toggle');
    expect(btn.textContent).toContain('العربية');
    expect(btn.getAttribute('dir')).toBe('rtl');
    fireEvent.click(btn);
    expect(document.cookie).toContain('admin-lang=ar');
    expect(localStorage.getItem('admin-lang')).toBe('ar');
  });

  it('restores a saved choice when the cookie was purged', () => {
    m.locale = 'ar';
    localStorage.setItem('admin-lang', 'en');
    render(<AdminLanguageSwitcher />);
    expect(document.cookie).toContain('admin-lang=en');
    expect(reload).toHaveBeenCalled();
  });
});

describe('i18n parity for touched namespaces (enum-driven)', () => {
  const flat = (o: Msgs, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === 'string' ? [`${p}${k}`] : flat(v, `${p}${k}.`)
    );
  const pick = (o: Msgs, path: string) => path.split('.').reduce<Msgs>((a, k) => a[k] as Msgs, o);
  const NAMESPACES = [
    'components.languageSwitcher',
    'components.adminLayout',
    'components.brand',
    'pwa',
    'auth.login',
    'onboarding.signup',
    'onboarding.shell',
    'common.errors',
  ];
  it.each(NAMESPACES)('%s has identical keys in en and ar', ns => {
    expect(flat(pick(ar as Msgs, ns)).sort()).toEqual(flat(pick(en as Msgs, ns)).sort());
  });
});
