// @vitest-environment jsdom
/**
 * Phase B2 Task 3: the four platform variants every skin renders: category-grid `rail` and
 * `tiles`, product-spotlight `stage`, and the `on_sale` product source. Schema acceptance (every
 * required field present, an unknown layout still fails), render contracts, the same variants on
 * minimal / dahab / qamar / souq, and the on_sale resolution rules.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  storeLayoutSchema,
  productSpotlightSchema,
  featuredCollectionSchema,
  getTemplateTheme,
  getSectionDefinition,
  DEFAULT_LAYOUT_SETTINGS,
} from '@ebda/shared';
import { smallTargets } from '../helpers/target-size';
import { STORES } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  language: 'en' as 'en' | 'ar',
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
  useStoreNumerals: () => 'latn',
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
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { CategoryRail } = await import('../../apps/web/src/templates/shared/CategoryRail');
const { CategoryTiles } = await import('../../apps/web/src/templates/shared/CategoryTiles');
const { ProductSpotlightSection } =
  await import('../../apps/web/src/builder/sections/ProductSpotlightSection');
const { resolveSectionProducts, saleDiscount, onSaleProducts } =
  await import('../../apps/web/src/builder/sections/section-products');

const SKINS = ['minimal', 'dahab', 'qamar', 'souq'] as const;
const useSkin = (skin: (typeof SKINS)[number], lang: 'en' | 'ar' = 'en') => {
  ctx.store = { ...STORES.A, template: skin, look: null, theme: getTemplateTheme(skin) };
  ctx.language = lang;
};
afterEach(cleanup);
// jsdom under this Node has no usable localStorage: a Map-backed stand-in (compare.ts reads the global).
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});
beforeEach(() => {
  store.clear();
});

const CATS = [
  { id: 'c1', name: 'Phones', nameAr: 'موبايلات', slug: 'phones', image: 'https://x/p.webp' },
  { id: 'c2', name: 'Fridges', nameAr: 'تلاجات', slug: 'fridges', image: 'https://x/f.webp' },
  { id: 'c3', name: 'Cables', nameAr: 'كابلات', slug: 'cables' }, // no photo
];

describe('schema: the variants are accepted, an unknown one still fails', () => {
  const base = {
    enabled: true,
    captionPosition: 'below',
    desktopColumns: 4,
    mobileColumns: 2,
  };
  const cat = storeLayoutSchema.shape.categories.unwrap();
  it.each(['rail', 'tiles'])('category-grid layout %s (desktop and mobile)', layout => {
    expect(cat.safeParse({ ...base, layout, layoutMobile: layout }).success).toBe(true);
  });
  it('an unknown category layout fails', () => {
    expect(cat.safeParse({ ...base, layout: 'carousel3d' }).success).toBe(false);
    expect(cat.safeParse({ ...base, layout: 'rail', layoutMobile: 'nope' }).success).toBe(false);
  });
  it('product-spotlight layout stage / list, an unknown one fails', () => {
    expect(productSpotlightSchema.safeParse({ layout: 'stage', limit: 1 }).success).toBe(true);
    expect(productSpotlightSchema.safeParse({ layout: 'list' }).success).toBe(true);
    expect(productSpotlightSchema.safeParse({ layout: 'hero' }).success).toBe(false);
  });
  it('productSource on_sale on featured-collection and product-spotlight', () => {
    expect(featuredCollectionSchema.safeParse({ productSource: 'on_sale', limit: 4 }).success).toBe(
      true
    );
    expect(productSpotlightSchema.safeParse({ productSource: 'on_sale' }).success).toBe(true);
    expect(featuredCollectionSchema.safeParse({ productSource: 'discounted' }).success).toBe(false);
  });
  it('productSource on_sale on a product carousel (extraCarousels entry)', () => {
    const doc = (productSource: string) => ({
      ...DEFAULT_LAYOUT_SETTINGS,
      extraCarousels: [{ id: 'deals', productSource, limit: 8 }],
    });
    expect(storeLayoutSchema.safeParse(doc('on_sale')).success).toBe(true);
    expect(storeLayoutSchema.safeParse(doc('sale')).success).toBe(false);
  });
  it('the registry lists the new options (the editor renders them from here)', () => {
    const opts = (type: string, id: string) =>
      (
        getSectionDefinition(type)!.settings.find(s => s.id === id) as {
          options?: Array<{ value: unknown }>;
        }
      ).options!.map(o => o.value);
    expect(opts('category-grid', 'layout')).toEqual(expect.arrayContaining(['rail', 'tiles']));
    expect(opts('product-spotlight', 'layout')).toEqual(['list', 'stage']);
    for (const t of ['product-carousel', 'featured-collection', 'product-spotlight'])
      expect(opts(t, 'productSource')).toContain('on_sale');
  });
});

describe.each(SKINS)('category rail and tiles on %s', skin => {
  it('rail: a horizontal snap row of cut-out tiles, 44px targets, no page scroll', () => {
    useSkin(skin);
    const { container } = render(<CategoryRail categories={CATS} urlPrefix="" isRtl={false} />);
    const row = container.querySelector('[data-part="rail-row"]')!;
    expect(row.className).toMatch(/\boverflow-x-auto\b/);
    expect(row.className).toMatch(/\bsnap-x\b/);
    expect(row.className).toContain('scroll-padding-inline');
    expect(row.className).toContain('scrollbar-width:thin'); // the cue that it scrolls
    expect(container.querySelector('[data-section="category-rail"] > div')!.className).toContain(
      'min-w-0'
    );
    expect(container.querySelectorAll('a')).toHaveLength(CATS.length);
    expect(container.querySelectorAll('img')[0].className).toContain('object-contain');
    expect(container.querySelector('li a')!.className).toContain('min-h-11');
    expect(smallTargets(container, 44)).toEqual([]);
  });
  it('rail: Arabic names in an Arabic row, logical properties only', () => {
    useSkin(skin, 'ar');
    const { container } = render(<CategoryRail categories={CATS} urlPrefix="" isRtl />);
    expect(container.textContent).toContain('موبايلات');
    expect(container.querySelector('section')!.getAttribute('dir')).toBe('rtl');
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr)-\d/);
  });
  it('rail: a category with no photo shows its NAME in the tile (not a lone letter), once', () => {
    useSkin(skin);
    const { container } = render(<CategoryRail categories={CATS} urlPrefix="" isRtl={false} />);
    const typo = container.querySelector('[data-part="typographic"]')!;
    expect(typo.textContent).toBe('Cables');
    expect(container.textContent!.match(/Cables/g)).toHaveLength(1);
  });
  it('tiles: square tiles, a category with no photo is a typographic tile, not blank', () => {
    useSkin(skin);
    const { container } = render(<CategoryTiles categories={CATS} urlPrefix="" isRtl={false} />);
    const tiles = container.querySelectorAll('[data-part="tile"]');
    expect(tiles).toHaveLength(3);
    for (const t of Array.from(tiles)) expect(t.className).toContain('aspect-square');
    const typo = container.querySelector('[data-part="typographic"]')!;
    expect(typo.textContent).toBe('Cables');
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(smallTargets(container, 44)).toEqual([]);
  });
  it('tiles: captionPosition is honoured (below = under the tile, overlay = on the tile)', () => {
    useSkin(skin);
    const below = render(<CategoryTiles categories={CATS} urlPrefix="" captionPosition="below" />);
    expect(below.container.querySelector('[data-part="tile"] .absolute.inset-x-0')).toBeNull();
    expect(below.container.querySelectorAll('a > span.line-clamp-2')).toHaveLength(2);
    cleanup();
    const over = render(<CategoryTiles categories={CATS} urlPrefix="" captionPosition="overlay" />);
    expect(over.container.querySelectorAll('[data-part="tile"] .absolute.inset-x-0')).toHaveLength(
      2
    );
    expect(over.container.querySelectorAll('a > span.line-clamp-2')).toHaveLength(0);
  });
  it('renders nothing for no categories', () => {
    useSkin(skin);
    expect(render(<CategoryRail categories={[]} />).container.innerHTML).toBe('');
    expect(render(<CategoryTiles categories={[]} />).container.innerHTML).toBe('');
  });
});

const PRODUCT = {
  id: 'p1',
  name: 'Galaxy S25',
  nameAr: 'جالاكسي إس 25',
  slug: 'galaxy-s25',
  price: 4500000,
  compareAtPrice: 5000000,
  images: [{ id: 'i1', url: 'https://x/phone.webp' }],
  inStock: true,
  facts: [
    { key: 'Storage', keyAr: 'التخزين', value: '256GB', valueAr: '256 جيجا', onCard: true },
    { key: 'RAM', keyAr: 'الرام', value: '8GB RAM', valueAr: '8 جيجا رام', onCard: true },
    { key: 'Warranty', keyAr: 'الضمان', value: '2 years', valueAr: 'سنتين', onCard: false },
  ],
} as never;

describe.each(SKINS)('product-spotlight stage on %s', skin => {
  it('shows ONE product: image object-contain on the surface, name, two fact chips, price', () => {
    useSkin(skin);
    const { container, getByText } = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[PRODUCT, { ...(PRODUCT as object), id: 'p2', name: 'Other' } as never]}
        onAddToCart={async () => {}}
      />
    );
    expect(container.querySelector('[data-layout="stage"]')).not.toBeNull();
    expect(container.querySelectorAll('h2')).toHaveLength(1);
    expect(container.textContent).not.toContain('Other');
    const img = container.querySelector('img')!;
    expect(img.className).toContain('object-contain');
    expect(img.parentElement!.className).toContain('bg-card');
    getByText('Galaxy S25');
    // at most two onCard facts, value only, 12px+ (FactChips = text-xs)
    const chips = container.querySelectorAll('[data-testid="fact-chip"]');
    expect(Array.from(chips).map(c => c.textContent)).toEqual(['256GB', '8GB RAM']);
    // price once through the shared helper, compare-at struck
    expect(container.querySelector('s')).not.toBeNull();
    // the height cap min(78svh, 680px) is on the photo tile (asserted in the clipping test below)
    expect(container.querySelector('a[data-part="card-image"]')!.className).toContain(
      'max-h-[min(78svh,680px)]'
    );
  });
  it('every stage control names its product and starts with its visible text; one tab stop per destination (a11y P2-1, P2-4)', () => {
    useSkin(skin);
    const { container } = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[PRODUCT]}
        onAddToCart={async () => {}}
      />
    );
    const byText = (t: string) =>
      Array.from(container.querySelectorAll('button, a')).find(e => e.textContent?.trim() === t)!;
    expect(byText('Add to cart').getAttribute('aria-label')).toBe('Add to cart: Galaxy S25');
    expect(byText('Compare').getAttribute('aria-label')).toBe('Compare: Galaxy S25');
    // aria-pressed carries the state; the name does not flip, so it is not a double toggle
    expect(byText('Compare').getAttribute('aria-pressed')).toBe('false');
    // the photo link is the pointer's; the name link is the one keyboard stop to the PDP
    const photo = container.querySelector('a[data-part="card-image"]')!;
    expect(photo.getAttribute('tabindex')).toBe('-1');
    expect(photo.getAttribute('aria-hidden')).toBe('true');
    const stops = Array.from(container.querySelectorAll('a[href="/products/galaxy-s25"]')).filter(
      a => a.getAttribute('tabindex') !== '-1'
    );
    // the name (h2) link and the variant/view link: both labelled, none duplicated unlabelled
    for (const a of stops)
      expect(a.textContent!.trim() || a.getAttribute('aria-label')).toBeTruthy();
  });
  it('add control reads canBuyNow: add for a simple in-stock product, a PDP link otherwise', () => {
    useSkin(skin);
    const add = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[PRODUCT]}
        onAddToCart={async () => {}}
      />
    );
    expect(add.getByText('Add to cart').tagName).toBe('BUTTON');
    cleanup();
    // a variant product routes to the PDP for options (the card-CTA rule)
    const variant = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[
          { ...(PRODUCT as object), variants: [{ price: 1, compareAtPrice: null }] } as never,
        ]}
        onAddToCart={async () => {}}
      />
    );
    expect(variant.queryByText('Add to cart')).toBeNull();
    expect(variant.getByText('Choose options').closest('a')!.getAttribute('href')).toBe(
      '/products/galaxy-s25'
    );
    cleanup();
    // sold out: the shared label, still linkable, no add button
    const out = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[{ ...(PRODUCT as object), inStock: false } as never]}
        onAddToCart={async () => {}}
      />
    );
    expect(out.getByText('Sold Out')).toBeTruthy();
    expect(out.queryByText('Add to cart')).toBeNull();
    expect(out.container.querySelector('a[href="/products/galaxy-s25"]')).not.toBeNull();
    cleanup();
    // sold out but accepting backorders is still buyable
    const back = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[{ ...(PRODUCT as object), inStock: false, acceptsBackorder: true } as never]}
        onAddToCart={async () => {}}
      />
    );
    expect(back.getByText('Add to cart')).toBeTruthy();
  });
  it('compare toggle: a 44px control that flips the stored compare list', () => {
    useSkin(skin);
    const { getByText, container } = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[PRODUCT]}
        onAddToCart={async () => {}}
      />
    );
    expect(smallTargets(container, 44)).toEqual([]);
    const btn = getByText('Compare');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse([...store.values()][0])[0].id).toBe('p1');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
  it('the height cap is on the IMAGE only: the Add / Compare row is never inside a clipping region', () => {
    useSkin(skin);
    const { container, getByText } = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[PRODUCT]}
        onAddToCart={async () => {}}
      />
    );
    const section = container.querySelector('[data-layout="stage"]')!;
    for (const control of [getByText('Add to cart'), getByText('Compare')]) {
      let el: Element | null = control;
      while (el && el !== section) {
        expect(el.className, el.outerHTML.slice(0, 80)).not.toMatch(/overflow-hidden|max-h-/);
        el = el.parentElement;
      }
    }
    // the grid itself is not height-capped; the photo tile is, and keeps its square
    expect(section.querySelector(':scope > div')!.className).not.toContain('max-h-');
    const tile = container.querySelector('a[data-part="card-image"]')!;
    expect(tile.className).toContain('max-h-[min(78svh,680px)]');
    expect(tile.className).toContain('aspect-square');
  });
  it('only a stage marked priority preloads its image', () => {
    useSkin(skin);
    const first = render(
      <ProductSpotlightSection settings={{ layout: 'stage' }} products={[PRODUCT]} priority />
    );
    expect(first.container.querySelector('img')!.getAttribute('loading')).not.toBe('lazy');
    cleanup();
    const later = render(
      <ProductSpotlightSection settings={{ layout: 'stage' }} products={[PRODUCT]} />
    );
    expect(later.container.querySelector('img')!.getAttribute('loading')).toBe('lazy');
  });
  it('no product for the ref renders nothing', () => {
    useSkin(skin);
    expect(
      render(<ProductSpotlightSection settings={{ layout: 'stage' }} products={[]} />).container
        .innerHTML
    ).toBe('');
  });
  it('the default list layout is unchanged (no stage marker)', () => {
    useSkin(skin);
    const { container } = render(
      <ProductSpotlightSection
        settings={{ heading: 'Gifts', image: 'https://x/a.webp' }}
        products={[PRODUCT]}
      />
    );
    expect(container.querySelector('[data-layout="stage"]')).toBeNull();
    expect(container.querySelector('ul')).not.toBeNull();
  });
});

describe('on_sale source (resolution, price-drop order)', () => {
  const p = (id: string, price: number, compareAtPrice?: number, variants?: unknown[]) =>
    ({
      id,
      name: id,
      slug: id,
      price,
      compareAtPrice,
      variants,
      images: [],
      categories: [],
    }) as never;
  const pools = (list: unknown[]) =>
    ({ newArrivals: list, bestSellers: [], featured: [], extra: [] }) as never;
  it('keeps only products on sale, biggest relative drop first, limited', () => {
    const list = [
      p('full', 100),
      p('small', 90, 100), // 10%
      p('big', 50, 100), // 50%
      p('equal', 100, 100), // not a sale
      p('mid', 75, 100), // 25%
    ];
    const out = resolveSectionProducts({ productSource: 'on_sale', limit: 2 }, pools(list), 8);
    expect(out.map(x => x.id)).toEqual(['big', 'mid']);
  });
  it('no empty-match fallback: a deals row with no deals is empty, not full-price products', () => {
    expect(
      resolveSectionProducts({ productSource: 'on_sale' }, pools([p('a', 10), p('b', 20)]), 8)
    ).toEqual([]);
  });
  it('an unfilled stage renders nothing: manual with no ids gives no products, never the newest', () => {
    const list = [p('n1', 10), p('n2', 20)];
    expect(
      resolveSectionProducts({ productSource: 'manual', layout: 'stage', limit: 1 }, pools(list), 3)
    ).toEqual([]);
    expect(
      resolveSectionProducts(
        { productSource: 'manual', layout: 'stage', manualProductIds: ['n2'], limit: 1 },
        pools(list),
        3
      ).map(x => x.id)
    ).toEqual(['n2']);
    // the list layout keeps its newest fallback (unchanged behaviour)
    expect(
      resolveSectionProducts({ productSource: 'manual', limit: 2 }, pools(list), 3)
    ).toHaveLength(2);
  });
  it('a variant product is on sale only through a variant; the stale parent compare-at is ignored', () => {
    expect(
      saleDiscount({
        id: 'x',
        price: 10,
        compareAtPrice: 100,
        variants: [{ price: 10, compareAtPrice: null }],
      })
    ).toBe(0);
    expect(
      saleDiscount({
        id: 'x',
        price: 10,
        variants: [
          { price: 8, compareAtPrice: 10 },
          { price: 9, compareAtPrice: 9 },
        ],
      })
    ).toBeCloseTo(0.2);
    expect(
      saleDiscount({
        id: 'x',
        price: 10,
        variants: [{ price: 8, compareAtPrice: 10, isActive: false }],
      })
    ).toBe(0);
    expect(
      onSaleProducts([p('v', 10, 100, [{ price: 8, compareAtPrice: 10 }])]).map(x => x.id)
    ).toEqual(['v']);
  });
});

describe('STOP-2 re-audit: stage and tiles', () => {
  it('a stage whose product has no photo renders nothing (no empty matte)', () => {
    useSkin('souq');
    const noPhoto = { ...(PRODUCT as object), images: [] } as never;
    const { container } = render(
      <ProductSpotlightSection settings={{ layout: 'stage' }} products={[noPhoto]} />
    );
    expect(container.innerHTML).toBe('');
  });
  it('category tiles wrap in a centred row, so seven categories never leave a left-hugging orphan', () => {
    useSkin('souq');
    const { container } = render(<CategoryTiles categories={CATS} urlPrefix="" isRtl={false} />);
    const ul = container.querySelector('ul')!;
    expect(ul.className).toContain('flex-wrap');
    expect(ul.className).toContain('justify-center');
    expect(container.querySelector('li')!.className).toContain('md:w-[calc(25%-0.5625rem)]');
  });
});

describe('final review: deals pool and the price switch', () => {
  it('the deals row reads the API pool as-is; the client derivation is only the fallback', async () => {
    const { resolveSectionProducts } =
      await import('../../apps/web/src/builder/sections/section-products');
    const mk = (id: string, extra: object = {}) =>
      ({ id, name: id, price: 100, categories: [], ...extra }) as never;
    // a full-price product whose only discounted variant is DISABLED: the listing payload does not
    // carry isActive, so the client derivation would call it a sale; the API pool never lists it
    const fakeSale = mk('fake', {
      variants: [
        { price: 50, compareAtPrice: 90 },
        { price: 100, compareAtPrice: null },
      ],
    });
    const real = mk('real', { compareAtPrice: 200 });
    const pools = { newArrivals: [fakeSale, real], bestSellers: [], featured: [], extra: [] };
    const derived = resolveSectionProducts({ productSource: 'on_sale' }, pools, 12);
    expect(derived.map(p => p.id)).toContain('fake'); // the dead-guard defect the pool fixes
    const fromApi = resolveSectionProducts(
      { productSource: 'on_sale' },
      { ...pools, onSale: [real] },
      12
    );
    expect(fromApi.map(p => p.id)).toEqual(['real']);
    // an API pool that is empty is an empty row (never newest, never the derivation)
    expect(
      resolveSectionProducts({ productSource: 'on_sale' }, { ...pools, onSale: [] }, 12)
    ).toEqual([]);
  });
  it('the stage and the list honour the card-price switch (showPrice=false prints no price)', () => {
    useSkin('souq');
    const stage = render(
      <ProductSpotlightSection
        settings={{ layout: 'stage' }}
        products={[PRODUCT]}
        showPrice={false}
        onAddToCart={async () => {}}
      />
    );
    expect(stage.container.textContent).not.toMatch(/EGP|ج\.م/);
    expect(stage.container.querySelector('s')).toBeNull();
    cleanup();
    const list = render(
      <ProductSpotlightSection settings={{}} products={[PRODUCT]} showPrice={false} />
    );
    expect(list.container.textContent).not.toMatch(/EGP|ج\.م/);
    cleanup();
    const shown = render(
      <ProductSpotlightSection settings={{ layout: 'stage' }} products={[PRODUCT]} />
    );
    expect(shown.container.textContent).toMatch(/EGP|ج\.م/);
  });
});
