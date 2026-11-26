/**
 * LOCALE-PATHS-1: on a page of a store with language-in-the-URL ON (`/ar|/en`), no internal link may point at an
 * unprefixed indexable URL (it would cost a 301 on every click). Two guards:
 *  1. static: every storefront component imports `Link` from `components/StoreLink`, never from `next/link`
 *     (a type-only import is fine), so a new template cannot opt out;
 *  2. rendered: the real header and footer of every template pack, in a `/ar` and an `/en` page, carry zero
 *     unprefixed links to an indexable route (the home, products, categories, blog, about, faq, ...).
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  LOCALE_PATH_ROOTS,
  decideLocalePath,
  isLocalePathRoute,
  splitLocalePrefix,
} from '../../apps/web/src/lib/locale-paths';
import { LocalePathProvider } from '../../apps/web/src/contexts/LocalePathContext';

const ctx = vi.hoisted(() => ({
  store: { id: 'store-1', name: 'Demo', template: 'qamar', look: null } as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('../../apps/web/src/contexts/StoreContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  // the real `useStoreUrl` (it localizes); everything else a minimal stand-in
  const { useLocalePath } = await import('../../apps/web/src/contexts/LocalePathContext');
  const { localizeHref } = await import('../../apps/web/src/lib/locale-paths');
  return {
    ...real,
    useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
    useStoreUrl: () => {
      const locale = useLocalePath();
      return (p: string) => localizeHref(p, locale);
    },
    useStoreTheme: () => ({}),
    useStoreTemplate: () => ctx.store.template,
    useIsPlatform: () => false,
    useStoreBranding: () => ({ name: ctx.store.name }),
    useStoreContact: () => ({}),
  };
});
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
  usePathname: () => '/ar',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const SRC = path.resolve(__dirname, '../../apps/web/src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('every storefront component uses StoreLink, never next/link directly', () => {
  const files = walk(SRC).filter(
    f => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !f.includes('__tests__')
  );
  it('finds the source', () => expect(files.length).toBeGreaterThan(300));
  it('has no value import from next/link outside StoreLink.tsx', () => {
    const offenders = files.filter(f => {
      if (f.endsWith(path.join('components', 'StoreLink.tsx'))) return false;
      return /^import\s+(?!type\b)[^;]*from\s+'next\/link'/m.test(readFileSync(f, 'utf8'));
    });
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([]);
  });
});

const PACKS = ['dahab', 'qamar', 'souq', 'jasmine', 'lamma'];
const branding = { name: 'Demo', nameAr: 'ديمو', logo: null };
const navigation = [
  { href: '/', label: 'Home', labelAr: 'الرئيسية' },
  { href: '/products', label: 'Products', labelAr: 'المنتجات' },
  { href: '/categories', label: 'Categories', labelAr: 'الأقسام' },
  { href: '/about', label: 'About', labelAr: 'عنّا' },
  { href: '/faq', label: 'FAQ', labelAr: 'أسئلة' },
  { href: '/blog', label: 'Blog', labelAr: 'المدونة' },
  { href: '/cart', label: 'Cart', labelAr: 'السلة' },
];

/** Every internal href in the HTML: starts with `/` (not `//`), not a hash, not a file. */
const internalHrefs = (html: string) =>
  [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)]
    .map(m => m[1].replace(/&amp;/g, '&'))
    .filter(h => h.startsWith('/') && !h.startsWith('//'));

/** Served under a language prefix (the middleware rewrites `/en<path>` instead of redirecting it away). */
const servedUnderPrefix = (p: string) =>
  decideLocalePath({ pathname: `/en${p}`, search: '', method: 'GET' }).kind === 'rewrite';

/** An indexable-route link without the language prefix: the thing this guard forbids. */
const unprefixedIndexable = (hrefs: string[]) =>
  hrefs.filter(
    h => !splitLocalePrefix(h.split(/[?#]/)[0]) && servedUnderPrefix(h.split(/[?#]/)[0])
  );

describe('rendered chrome carries zero unprefixed internal links on a locale-path page', () => {
  it('knows the indexable roots', () => expect(LOCALE_PATH_ROOTS).toContain('products'));

  for (const lang of ['ar', 'en'] as const) {
    for (const pack of PACKS) {
      for (const part of ['Header', 'Footer'] as const) {
        const file = path.join(SRC, 'templates', pack, `${part}.tsx`);
        if (!existsSync(file)) continue;
        it(`${pack} ${part} on /${lang}`, async () => {
          ctx.language = lang;
          ctx.store = { ...ctx.store, template: pack };
          const mod = await import(file);
          const Comp = mod.default ?? mod[part];
          const html = renderToStaticMarkup(
            <LocalePathProvider locale={lang}>
              <Comp
                branding={branding}
                navigation={navigation}
                contact={{}}
                socials={{}}
                isRtl={lang === 'ar'}
              />
            </LocalePathProvider>
          );
          const hrefs = internalHrefs(html);
          expect(hrefs.length, 'the pack renders some internal links').toBeGreaterThan(0);
          expect(unprefixedIndexable(hrefs), `${pack} ${part}`).toEqual([]);
          // and the prefix is the PAGE's language
          for (const h of hrefs) {
            const s = splitLocalePrefix(h.split(/[?#]/)[0]);
            if (s) expect(s.locale, h).toBe(lang);
          }
        });
        it(`${pack} ${part} on an ordinary page is untouched`, async () => {
          ctx.language = lang;
          const mod = await import(file);
          const Comp = mod.default ?? mod[part];
          const html = renderToStaticMarkup(
            <LocalePathProvider locale={null}>
              <Comp
                branding={branding}
                navigation={navigation}
                contact={{}}
                socials={{}}
                isRtl={lang === 'ar'}
              />
            </LocalePathProvider>
          );
          expect(internalHrefs(html).filter(h => splitLocalePrefix(h.split(/[?#]/)[0]))).toEqual(
            []
          );
        });
      }
    }
  }
});
