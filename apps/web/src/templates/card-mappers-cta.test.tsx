// @vitest-environment jsdom
/**
 * C-01 (P0, Qamar taste audit 2026-10-15): every card derives its CTA from REAL
 * variants and REAL stock, whichever mapper built it.
 *
 * The recommendation strips, the FBT grid, cart recommendations and the
 * wishlist each hand-built their own TemplateProduct with no `variants` and a
 * hard-coded `inStock: true`, so a sized product offered a one-tap add (a
 * sizeless cart line) and a sold-out product looked buyable. They now go
 * through the shared mappers in `templates/adapters.ts`.
 *
 * This is behavioural, not a class-name check: each product is rendered through
 * every card render path (5 skin cards, the shared card and carousel under all
 * 6 packs — dahab included, where they hand over to the Dahab skin — and the
 * PLP list row), every button in the card is clicked, and the test observes
 * whether an add-to-cart fired. A sized product and a sold-out product must
 * never fire one; a plain in-stock product and a backorderable one must (which
 * proves the click reaches the add control at all).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const state = { template: 'minimal' };

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
    store: { id: 's1', name: 'S', slug: 's', currency: 'EGP', theme: {} },
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
const { PecannbeeProductCard } = await import('./shared/PecannbeeProductCard');
const { default: ModernProductCard } = await import('./modern/ProductCard');
const { default: ElegantProductCard } = await import('./elegant/ProductCard');
const { default: ClassicProductCard } = await import('./classic/ProductCard');
const { default: BoldProductCard } = await import('./bold/ProductCard');
const { default: MinimalProductCard } = await import('./minimal/ProductCard');
const { ProductCarousel } = await import('./shared/ProductCarousel');
const { ProductListItem } = await import('../app/products/ProductListItem');

type Tpl = import('./types').TemplateProduct;

// ── Raw payloads, one per data hop, in each hop's real shape ─────────────────
const img = [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }];
type Kind = 'sized' | 'soldOut' | 'backorder' | 'plain';
const stock: Record<Kind, { inStock: boolean; acceptsBackorder: boolean; inventory: number }> = {
  sized: { inStock: true, acceptsBackorder: false, inventory: 7 },
  soldOut: { inStock: false, acceptsBackorder: false, inventory: 0 },
  backorder: { inStock: false, acceptsBackorder: true, inventory: 0 },
  plain: { inStock: true, acceptsBackorder: false, inventory: 5 },
};
const base = (k: Kind) => ({
  id: `p-${k}`,
  name: `Product ${k}`,
  nameAr: `منتج ${k}`,
  slug: `product-${k}`,
  price: 5000,
  ...stock[k],
});

/** Listing / PDP-related shape (`Product`, enrichStockFlags output). */
const listing = (k: Kind) =>
  ({
    ...base(k),
    status: 'active',
    images: img,
    variants:
      k === 'sized'
        ? [{ id: 'v1', price: 5000, inventory: 7, options: { Size: 'M' }, acceptsBackorder: false }]
        : [],
  }) as never;
/** Recommendation payload (recommendation.service productSelect + enrichStockFlags). */
const recommended = (k: Kind) =>
  ({
    ...base(k),
    images: img,
    variants: k === 'sized' ? [{ id: 'v1', price: 5000 }] : [],
  }) as never;
/** Wishlist payload (lib/wishlist-card.ts). */
const wishlisted = (k: Kind) =>
  ({
    ...base(k),
    images: ['https://example.test/a.jpg'],
    status: 'active',
    variants: k === 'sized' ? [{ id: 'v1', price: 50 }] : [],
  }) as never;

const MAPPERS: Array<[string, (k: Kind) => Tpl]> = [
  [
    'toTemplateProduct (PLP, search, home, PDP related)',
    k => adapters.toTemplateProduct(listing(k)),
  ],
  [
    'recommendedToTemplateProduct (YouMightAlsoLike, FBT, CartRecommendations)',
    k => adapters.recommendedToTemplateProduct(recommended(k)),
  ],
  [
    'wishlistToTemplateProduct (WishlistClient)',
    k => adapters.wishlistToTemplateProduct('w1', wishlisted(k)),
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

/** Render, click every button in the card, report whether an add fired. */
async function addsWhenEveryButtonIsClicked(
  el: React.ReactElement,
  onAdd: ReturnType<typeof vi.fn>
) {
  const { container } = render(el);
  for (const b of Array.from(container.querySelectorAll('button'))) {
    // The wishlist heart / compare toggles are not purchase controls.
    const label = `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`;
    if (/wish|مفضل|compare|قارن|previous|next|السابق|التالي/i.test(label)) continue;
    await act(async () => {
      fireEvent.click(b);
    });
  }
  return onAdd.mock.calls.length > 0;
}

afterEach(() => {
  cleanup();
  state.template = 'minimal';
});

describe.each(MAPPERS)('%s', (_m, map) => {
  it.each(PATHS)('%s: a SIZED product never fires a one-tap add', async (_p, path) => {
    const onAdd = vi.fn();
    expect(await addsWhenEveryButtonIsClicked(path(map('sized'), onAdd), onAdd)).toBe(false);
  });
  it.each(PATHS)('%s: a SOLD-OUT product never fires an add', async (_p, path) => {
    const onAdd = vi.fn();
    expect(await addsWhenEveryButtonIsClicked(path(map('soldOut'), onAdd), onAdd)).toBe(false);
  });
  it.each(PATHS)(
    '%s: a plain in-stock product does add (the click reaches the CTA)',
    async (_p, path) => {
      const onAdd = vi.fn();
      expect(await addsWhenEveryButtonIsClicked(path(map('plain'), onAdd), onAdd)).toBe(true);
    }
  );
  it.each(PATHS)(
    '%s: a backorderable sold-out product adds (acceptsBackorder carried)',
    async (_p, path) => {
      const onAdd = vi.fn();
      expect(await addsWhenEveryButtonIsClicked(path(map('backorder'), onAdd), onAdd)).toBe(true);
    }
  );
});

describe('app/products/ProductListItem (the 8th path, fed the listing Product directly)', () => {
  const row = (k: Kind, onAdd: ReturnType<typeof vi.fn>) =>
    React.createElement(
      ProductListItem as never,
      {
        product: listing(k),
        isInCompare: false,
        onToggleCompare: () => {},
        onAddToCart: onAdd,
      } as never
    );
  it.each(['sized', 'soldOut'] as const)('%s: no add', async k => {
    const onAdd = vi.fn();
    expect(await addsWhenEveryButtonIsClicked(row(k, onAdd), onAdd)).toBe(false);
  });
  it.each(['plain', 'backorder'] as const)('%s: adds', async k => {
    const onAdd = vi.fn();
    expect(await addsWhenEveryButtonIsClicked(row(k, onAdd), onAdd)).toBe(true);
  });
});

describe('the shared mappers keep every field the CTA reads', () => {
  it.each(MAPPERS)('%s keeps variants, inStock and acceptsBackorder', (_m, map) => {
    expect(map('sized').variants).toHaveLength(1);
    expect(map('soldOut').inStock).toBe(false);
    expect(map('backorder')).toMatchObject({ inStock: false, acceptsBackorder: true });
    expect(map('plain')).toMatchObject({ inStock: true, acceptsBackorder: false });
  });
  it('toTemplateProduct prefers the server inStock over the raw inventory column', () => {
    // A variant product's parent column is 0 by the inventory model; the
    // server's aggregate says in stock.
    const p = adapters.toTemplateProduct({
      ...(listing('sized') as object),
      inventory: 0,
    } as never);
    expect(p.inStock).toBe(true);
  });
  it('an unpublished wishlist product is not in stock whatever its stock says', () => {
    const p = adapters.wishlistToTemplateProduct('w1', {
      ...(wishlisted('plain') as object),
      status: 'draft',
    } as never);
    expect(p.inStock).toBe(false);
  });
});

describe('gate: the hand-built card mappers route through templates/adapters.ts', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
  it.each([
    ['components/YouMightAlsoLike.tsx', 'recommendedToTemplateProduct'],
    ['components/CartRecommendations.tsx', 'recommendedToTemplateProduct'],
    ['components/FrequentlyBoughtTogether.tsx', 'recommendedToTemplateProduct'],
    ['app/wishlist/WishlistClient.tsx', 'wishlistToTemplateProduct'],
  ])('%s uses %s and hard-codes no stock', (file, mapper) => {
    const src = read(file);
    expect(src).toContain(mapper);
    expect(src).not.toMatch(/inStock:\s*true/);
    expect(src).not.toMatch(/inStock:\s*[^,\n]*status\s*===\s*'active'/);
  });
  it('no storefront card mapper hard-codes inStock: true', () => {
    for (const f of ['templates/adapters.ts', 'app/products/[slug]/ProductDetailClient.tsx']) {
      expect(read(f)).not.toMatch(/inStock:\s*true/);
    }
  });
});
