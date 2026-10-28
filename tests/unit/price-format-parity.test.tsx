// @vitest-environment jsdom
/**
 * Ruling B1-28 (Ahmad, STOP 1): ONE price format on every storefront render path.
 * Arabic "1,490 ج.م", English "EGP 1,490", Western digits by default (NUMERALS-1).
 * Renders the REAL card paths (shared card, carousel, the 5 template cards, Dahab, the PLP list
 * item), the PDP main price, the PDP sticky bar and every theme's cart table + order summary with
 * the real `useLocalePrice`, and asserts the identical string everywhere. A static sweep fails on
 * any storefront file that glues a currency code to a number itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup, act } from '@testing-library/react';
import { STORES } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  lang: 'en' as 'en' | 'ar',
  store: {} as Record<string, unknown>,
  all: [] as Array<(e: unknown[]) => void>,
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, layout: null, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => (ctx.store as { theme?: unknown }).theme,
  useStoreTemplate: () => (ctx.store as { template?: string }).template,
  useIsPlatform: () => false,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.lang,
      direction: ctx.lang === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.lang === 'ar',
      setLanguage: () => {},
      t: (en: string, ar?: string) => (ctx.lang === 'ar' ? (ar ?? en) : en),
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], itemCount: 0, total: 0, addItem: vi.fn(async () => true) }),
}));
vi.mock('../../apps/web/src/contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => false }),
}));
vi.mock('../../apps/web/src/hooks/useTemplateComponents', () => ({
  useTemplateComponents: () => ({ isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'linen-abaya' }),
  usePathname: () => '/products/linen-abaya',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) =>
    React.createElement('img', { src, alt }),
}));
vi.mock('@ebda/ui', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, useToast: () => ({ success: vi.fn(), error: vi.fn() }) };
});
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../../apps/web/src/components', () => ({
  ShopChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SectionErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../apps/web/src/components/MarketingPixels', () => ({
  trackViewContent: () => {},
  trackAddToCart: () => {},
}));
vi.mock('../../apps/web/src/components/PostHogProvider', () => ({ captureEvent: () => {} }));
vi.mock('../../apps/web/src/components/ProductModel3d', () => ({
  Model3dToggle: () => null,
  ProductModel3dPanel: () => null,
}));
vi.mock('../../apps/web/src/components/commerce/DeliveryChip', () => ({
  DeliveryChip: () => null,
}));
vi.mock('../../apps/web/src/templates/shared/ShareProductRow', () => ({
  ShareProductRow: () => null,
}));
vi.mock('@/lib/api', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    api: {
      beaconProductView: () => {},
      get: vi.fn(async () => ({ data: [] })),
      getProducts: vi.fn(async () => ({ data: [] })),
    },
  };
});

class IO {
  constructor(cb: (e: unknown[]) => void) {
    ctx.all.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The one space is a NO-BREAK space (STOP-2 re-audit: a price never splits from its currency).
const EXPECTED = { ar: '1,490\u00A0ج.م', en: 'EGP\u00A01,490' } as const;
const LANGS = ['ar', 'en'] as const;

const cardProduct = {
  id: 'p1',
  name: 'Linen abaya',
  nameAr: 'عباية كتان',
  slug: 'linen-abaya',
  price: 149000,
  images: [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }],
  inStock: true,
};
const pdpProduct = {
  ...cardProduct,
  images: [],
  inventory: 5,
  variants: [],
  options: [],
  categories: [],
};

function setStore(lang: 'en' | 'ar', template = 'qamar') {
  ctx.lang = lang;
  ctx.store = { ...STORES.A, template, currency: 'EGP', theme: {} };
}

/** The price text node(s) a rendered tree carries. */
function priceTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-zone="productPrice"]')].map(e =>
    (e.textContent ?? '').replace(/[ \t\r\n]+/g, ' ').trim()
  );
}

const CARD_MODULES: [string, () => Promise<React.ComponentType<Record<string, unknown>>>][] = [
  [
    'shared/StorefrontProductCard',
    async () =>
      (await import('../../apps/web/src/templates/shared/StorefrontProductCard'))
        .StorefrontProductCard as never,
  ],
  [
    'base/ProductCard',
    async () => (await import('../../apps/web/src/templates/base/ProductCard')).default as never,
  ],
  [
    'dahab/ProductCard',
    async () => (await import('../../apps/web/src/templates/dahab/ProductCard')).default as never,
  ],
  [
    'products/ProductListItem',
    async () =>
      (await import('../../apps/web/src/app/products/ProductListItem')).ProductListItem as never,
  ],
];

describe('one price format on every card path (B1-28)', () => {
  for (const lang of LANGS)
    for (const [name, load] of CARD_MODULES)
      it(`${name} (${lang}) prints "${EXPECTED[lang]}"`, async () => {
        vi.stubGlobal('matchMedia', () => ({
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }));
        setStore(lang, name.startsWith('dahab') ? 'dahab' : 'qamar');
        const Card = await load();
        const { container } = render(
          <Card product={cardProduct} isRtl={lang === 'ar'} currency="EGP" />
        );
        const text = container.textContent ?? '';
        expect(text).toContain(EXPECTED[lang]);
        // never the old mixes: a code after the number, or the other locale's label
        expect(text).not.toMatch(lang === 'ar' ? /EGP/ : /ج\.م/);
        expect(text).not.toMatch(/[٠-٩]/);
      });

  for (const lang of LANGS)
    it(`shared/ProductCarousel (${lang}) prints "${EXPECTED[lang]}"`, async () => {
      setStore(lang);
      const { ProductCarousel } =
        await import('../../apps/web/src/templates/shared/ProductCarousel');
      const { container } = render(
        <ProductCarousel
          products={[cardProduct] as never}
          title="T"
          isRtl={lang === 'ar'}
          currency="EGP"
        />
      );
      expect(priceTexts(container)).toContain(EXPECTED[lang]);
    });
});

describe('PDP main price + sticky bar print the card string (B1-28)', () => {
  for (const lang of LANGS)
    it(`PDP (${lang})`, async () => {
      vi.stubGlobal('IntersectionObserver', IO);
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      });
      setStore(lang);
      const { default: ProductDetailClient } =
        await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
      ctx.all.length = 0;
      const { container } = render(<ProductDetailClient initialProduct={pdpProduct as never} />);
      act(() =>
        ctx.all.forEach(cb => cb([{ isIntersecting: false, boundingClientRect: { top: -10 } }]))
      );
      expect(priceTexts(container)[0]).toBe(EXPECTED[lang]);
      const sticky = screen.getByTestId('sticky-atc');
      expect(sticky.textContent).toContain(EXPECTED[lang]);
    });
});

describe('every theme cart table + order summary prints the same string (B1-28)', () => {
  const THEMES = ['base', 'dahab'] as const;
  const line = {
    id: 'l1',
    productId: 'p1',
    name: 'Linen abaya',
    nameAr: 'عباية كتان',
    slug: 'linen-abaya',
    price: 149000,
    quantity: 1,
    image: null,
  };
  for (const lang of LANGS)
    for (const theme of THEMES)
      it(`${theme} CartTable + OrderSummary (${lang})`, async () => {
        setStore(lang, theme === 'base' ? 'qamar' : theme);
        const CartTable = (await import(`../../apps/web/src/templates/${theme}/CartTable.tsx`))
          .default as React.ComponentType<Record<string, unknown>>;
        const Summary = (await import(`../../apps/web/src/templates/${theme}/OrderSummary.tsx`))
          .default as React.ComponentType<Record<string, unknown>>;
        const a = render(
          <CartTable
            items={[line]}
            isRtl={lang === 'ar'}
            currency="EGP"
            onUpdateQuantity={() => {}}
            onRemove={() => {}}
          />
        );
        expect(a.container.textContent).toContain(EXPECTED[lang]);
        cleanup();
        const b = render(
          <Summary subtotal={149000} total={149000} currency="EGP" isRtl={lang === 'ar'} />
        );
        expect(b.container.textContent).toContain(EXPECTED[lang]);
        expect(b.container.textContent).not.toMatch(lang === 'ar' ? /EGP/ : /ج\.م/);
      });
});

describe('no storefront file formats a price itself (B1-28)', () => {
  const root = path.resolve(__dirname, '../../apps/web/src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
    }
  };
  walk(root);
  it('no `${money(x)} ${currency}` / `{money(x)} {currency}` / "<amount> EGP" glue left', () => {
    const offenders = files.filter(f => {
      const s = readFileSync(f, 'utf8');
      return (
        /money\([^)]*\)\}?\s*\{?\$?\{?currency\}/.test(s) ||
        /\}\s*EGP\s*</.test(s) ||
        /\{priceMajor\} EGP/.test(s)
      );
    });
    expect(offenders.map(f => path.relative(root, f))).toEqual([]);
  });
});

describe('digits default to Western: no preset turns on Arabic-Indic (NUMERALS-1, B1-28)', () => {
  it('no look, skin theme or the demo seed sets arabicNumerals', async () => {
    const shared = await import('@ebda/shared');
    for (const l of shared.LOOKS) {
      const theme = shared.composeStoreTheme({ template: l.skin, look: l.id, theme: {} }) as {
        arabicNumerals?: unknown;
      };
      expect(theme.arabicNumerals, l.id).not.toBe(true);
    }
    for (const t of shared.TEMPLATES) {
      const theme = shared.getTemplateTheme(t.id) as { arabicNumerals?: unknown };
      expect(theme.arabicNumerals, t.id).not.toBe(true);
    }
    const seed = readFileSync(path.resolve(__dirname, '../../scripts/storedemo/seed.mjs'), 'utf8');
    expect(seed).not.toMatch(/arabicNumerals\s*:\s*true/);
  });
});
