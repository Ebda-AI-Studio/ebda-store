// @vitest-environment jsdom
/**
 * W1c carry (W1a review): the "جديد / New" badge never rendered on any card.
 * The adapters in `templates/adapters.ts` never passed `createdAt` (and the
 * recommendation payload never selected it), and four skin cards read the raw
 * `product.isNew`, which no payload sets. Every card path now decides with the
 * one rule, `isProductNew` (an explicit isNew, or created within 14 days), and
 * every mapper carries `createdAt`.
 *
 * Behavioural: a fresh product goes through each mapper and each card render
 * path (5 skin cards, the shared card and carousel under all 6 packs incl.
 * Dahab) and the badge must show; a 60-day-old product must not show it.
 *
 * Ahmad 2026-10-16 (Ruling D1016-NEW-1): the badge is the MERCHANT'S choice — a store setting,
 * `theme.showNewBadge`, default OFF. With it off no card path shows the badge, not even for an
 * explicit `isNew` product.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/react';

const state: { template: string; theme: Record<string, unknown> } = {
  template: 'minimal',
  theme: { showNewBadge: true },
};

// The Dahab carousel reads prefers-reduced-motion; jsdom has no matchMedia.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

vi.mock('../contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's1', name: 'S', slug: 's', currency: 'EGP', theme: state.theme },
    layout: undefined,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTemplate: () => state.template,
}));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'ar',
    isRtl: true,
    t: (en: string, ar?: string) => ar ?? en,
    setLanguage: () => {},
  }),
  translations: {} as Record<string, string>,
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) =>
    React.createElement('img', { src, alt }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) =>
    React.createElement('a', { href, ...rest }, children),
}));

const adapters = await import('./adapters');
const { isProductNew } = await import('./shared/ProductCardCta');
const { RenderClockProvider } = await import('../contexts/RenderClockContext');
const { PecannbeeProductCard } = await import('./shared/PecannbeeProductCard');
const { default: ModernProductCard } = await import('./modern/ProductCard');
const { default: ElegantProductCard } = await import('./elegant/ProductCard');
const { default: ClassicProductCard } = await import('./classic/ProductCard');
const { default: BoldProductCard } = await import('./bold/ProductCard');
const { default: MinimalProductCard } = await import('./minimal/ProductCard');
const { ProductCarousel } = await import('./shared/ProductCarousel');

type Tpl = import('./types').TemplateProduct;

const DAY = 24 * 60 * 60 * 1000;
const img = [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }];
const fresh = new Date(Date.now() - 2 * DAY).toISOString();
const old = new Date(Date.now() - 60 * DAY).toISOString();
const base = (createdAt: string) => ({
  id: 'p1',
  name: 'Ring',
  nameAr: 'خاتم',
  slug: 'ring',
  price: 5000,
  inStock: true,
  acceptsBackorder: false,
  inventory: 5,
  createdAt,
});

const MAPPERS: Array<[string, (createdAt: string) => Tpl]> = [
  [
    'toTemplateProduct (PLP, search, home rows, PDP related)',
    c =>
      adapters.toTemplateProduct({
        ...base(c),
        status: 'active',
        images: img,
        variants: [],
      } as never),
  ],
  [
    'recommendedToTemplateProduct (YouMightAlsoLike, FBT, CartRecommendations)',
    c => adapters.recommendedToTemplateProduct({ ...base(c), images: img, variants: [] } as never),
  ],
  [
    'wishlistToTemplateProduct (WishlistClient)',
    c =>
      adapters.wishlistToTemplateProduct('w1', {
        ...base(c),
        images: ['https://example.test/a.jpg'],
        status: 'active',
        variants: [],
      } as never),
  ],
];

// ── Card render paths ────────────────────────────────────────────────────────
const PACKS = ['modern', 'elegant', 'classic', 'minimal', 'bold', 'dahab'] as const;
type Path = [string, (p: Tpl, onAdd: (id: string) => void) => React.ReactElement];
function direct(Card: unknown): Path[1] {
  return function renderDirect(product, onAdd) {
    return React.createElement(
      Card as never,
      {
        product,
        isRtl: true,
        currency: 'EGP',
        onAddToCart: onAdd,
      } as never
    );
  };
}
const PATHS: Path[] = [
  ['modern/ProductCard', direct(ModernProductCard)],
  ['elegant/ProductCard', direct(ElegantProductCard)],
  ['classic/ProductCard', direct(ClassicProductCard)],
  ['minimal/ProductCard', direct(MinimalProductCard)],
  ['bold/ProductCard', direct(BoldProductCard)],
  ...PACKS.map(
    (pack): Path => [
      `PecannbeeProductCard, ${pack} pack`,
      (product, onAdd) => {
        state.template = pack;
        return React.createElement(
          PecannbeeProductCard as never,
          {
            product,
            isRtl: true,
            currency: 'EGP',
            pack,
            onAddToCart: onAdd,
          } as never
        );
      },
    ]
  ),
  ...PACKS.map(
    (pack): Path => [
      `ProductCarousel, ${pack} pack`,
      (product, onAdd) => {
        state.template = pack;
        return React.createElement(
          ProductCarousel as never,
          {
            products: [product],
            isRtl: true,
            currency: 'EGP',
            pack,
            onAddToCart: onAdd,
          } as never
        );
      },
    ]
  ),
];

afterEach(() => {
  cleanup();
  state.template = 'minimal';
  state.theme = { showNewBadge: true };
});

const NEW = /جديد/;

describe.each(MAPPERS)('%s', (_m, map) => {
  it('carries createdAt', () => {
    expect(map(fresh).createdAt).toBe(fresh);
  });
  it.each(PATHS)('%s: a product created 2 days ago shows the New badge', (_p, path) => {
    const { container } = render(path(map(fresh), () => {}));
    expect(container.textContent).toMatch(NEW);
  });
  it.each(PATHS)('%s: a 60-day-old product shows no New badge', (_p, path) => {
    const { container } = render(path(map(old), () => {}));
    expect(container.textContent).not.toMatch(NEW);
  });
});

describe('the store setting decides (default OFF, Ruling D1016-NEW-1)', () => {
  const fresh2 = () =>
    adapters.toTemplateProduct({
      ...base(fresh),
      status: 'active',
      images: img,
      variants: [],
    } as never);
  it.each(PATHS)('%s: setting unset → no New badge on a fresh product', (_p, path) => {
    state.theme = {};
    const { container } = render(path(fresh2(), () => {}));
    expect(container.textContent).not.toMatch(NEW);
  });
  it.each(PATHS)('%s: setting off → no New badge even with an explicit isNew', (_p, path) => {
    state.theme = { showNewBadge: false };
    const { container } = render(path({ ...fresh2(), isNew: true }, () => {}));
    expect(container.textContent).not.toMatch(NEW);
  });
  it('isProductNew is false without the setting, whatever the product says', () => {
    const now = Date.now();
    expect(isProductNew({ isNew: true, createdAt: fresh }, now, undefined)).toBe(false);
    expect(isProductNew({ isNew: true, createdAt: fresh }, now, {})).toBe(false);
    expect(isProductNew({ isNew: true }, now, { showNewBadge: true })).toBe(true);
  });
  it('DEFAULT_THEME ships the badge off', async () => {
    const { DEFAULT_THEME } = await import('@ebda/shared');
    expect(DEFAULT_THEME.showNewBadge).toBe(false);
  });
});

describe('one New rule on every card path', () => {
  it('no card reads the raw product.isNew; each decides with isProductNew', () => {
    const files = [
      'modern/ProductCard.tsx',
      'elegant/ProductCard.tsx',
      'classic/ProductCard.tsx',
      'minimal/ProductCard.tsx',
      'bold/ProductCard.tsx',
      'dahab/ProductCard.tsx',
      'shared/PecannbeeProductCard.tsx',
      'shared/ProductCarousel.tsx',
    ];
    for (const f of files) {
      const s = readFileSync(resolve(__dirname, f), 'utf8');
      expect(s, f).not.toMatch(/product\.isNew\b/);
      expect(s, f).toMatch(/isProductNew\(product, renderNow, store\.theme\)/);
      expect(s, f).toMatch(/const renderNow = useRenderNow\(\);/);
    }
  });

  // Review M9: the 14-day rule is decided on the render's clock, never a fresh
  // Date.now() during render, so the server HTML and hydration agree.
  it('isProductNew reads the clock it is given, not Date.now()', () => {
    const cta = readFileSync(resolve(__dirname, 'shared/ProductCardCta.tsx'), 'utf8');
    const fn = cta.slice(cta.indexOf('export function isProductNew'));
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toMatch(/Date\.now\(\)/);
    const created = '2026-10-01T00:00:00Z';
    const t = Date.parse(created);
    const on = { showNewBadge: true };
    expect(isProductNew({ createdAt: created }, t + 13 * DAY, on)).toBe(true);
    expect(isProductNew({ createdAt: created }, t + 15 * DAY, on)).toBe(false);
  });

  it('the root layout hands one server clock to the client', () => {
    const layout = readFileSync(resolve(__dirname, '../app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/const renderNow = Date\.now\(\);/);
    expect(layout).toMatch(/<RenderClockProvider now=\{renderNow\}>/);
  });

  it('a card decides on the provided clock (a fresh product reads "old" at a later render clock)', () => {
    const p = adapters.toTemplateProduct({
      ...base(fresh),
      status: 'active',
      images: img,
      variants: [],
    } as never);
    const later = Date.now() + 30 * DAY;
    const { container } = render(
      React.createElement(
        RenderClockProvider,
        { now: later } as never,
        React.createElement(
          MinimalProductCard as never,
          {
            product: p,
            isRtl: true,
            currency: 'EGP',
          } as never
        )
      )
    );
    expect(container.textContent).not.toMatch(/جديد/);
  });
  it('the recommendation payload selects createdAt and the wishlist projection ships it', () => {
    const rec = readFileSync(
      resolve(__dirname, '../../../api/src/services/recommendation.service.ts'),
      'utf8'
    );
    expect(rec.slice(0, rec.indexOf('class RecommendationService'))).toMatch(/createdAt: true/);
    const wl = readFileSync(resolve(__dirname, '../../../api/src/lib/wishlist-card.ts'), 'utf8');
    expect(wl).toMatch(/createdAt: p\.createdAt/);
  });
});
