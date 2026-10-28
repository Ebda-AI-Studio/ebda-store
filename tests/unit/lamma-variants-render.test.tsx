// @vitest-environment jsdom
/**
 * Phase B4 Task 3 (Rulings B4-1, B4-2): the `menu` layout, the `maker-profile` section and the
 * aisle-tinted category tiles. All three are platform pieces: they render on every skin, never on
 * one tenant. Fixtures carry every required field (C2 lesson), unknown values still fail, and each
 * control is a >= 44px target.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import {
  storeLayoutSchema,
  featuredCollectionSchema,
  makerProfileSchema,
  getSectionDefinition,
  contrastRatio,
  LOOK_DESIGN_KEYS,
  TEMPLATE_FAMILIES,
  getLook,
} from '@ebda/shared';
import { smallTargets } from '../helpers/target-size';
import { isOrangeFamily } from './helpers/orange-gate';
import { groupMenuProducts } from '../../apps/web/src/builder/sections/menu-groups';

const ctx = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch: _p,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, layout: undefined, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useStoreNumerals: () => undefined,
  useIsPlatform: () => false,
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

const { MenuSection } = await import('../../apps/web/src/builder/sections/MenuSection');
const { MakerProfileSection } =
  await import('../../apps/web/src/builder/sections/MakerProfileSection');
const { CategoryTiles, aisleTint } =
  await import('../../apps/web/src/templates/shared/CategoryTiles');

const cat = (slug: string, name: string, nameAr: string, id = slug) => ({
  id,
  slug,
  name,
  nameAr,
});
const CATS = [
  cat('tagines', 'Tagines', 'طواجن'),
  cat('sweets', 'Sweets', 'حلويات'),
  cat('pantry', 'Pantry', 'بقالة'),
];
const dish = (id: string, categorySlugs: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: `Dish ${id}`,
  nameAr: `طبق ${id}`,
  slug: `dish-${id}`,
  price: 12000,
  images: [{ id: `i-${id}`, url: `https://x/${id}.webp`, alt: id }],
  inventory: 5,
  categories: categorySlugs.map(slug => ({
    id: `pc-${id}-${slug}`,
    category: cat(slug, slug, slug),
  })),
  ...extra,
});
const POOL = [
  dish('a', ['tagines']),
  dish('b', ['sweets']),
  dish('c', ['tagines', 'sweets']),
  dish('d', ['pantry']),
  dish('e', []),
];
const setStore = (
  template = 'lamma',
  language: 'ar' | 'en' = 'ar',
  look: string | null = 'lamma.table'
) => {
  ctx.language = language;
  ctx.store = {
    id: 'store-l',
    name: 'L',
    template,
    look,
    currency: 'EGP',
    theme: {},
    enabledFeatures: [],
  };
};
beforeEach(() => {
  setStore();
  // the Dahab card reads a media query; jsdom has none
  if (!window.matchMedia)
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never;
});
afterEach(cleanup);

describe('schema: menu layout, maker profile, aisle tint', () => {
  it('featured-collection parses layout menu + tabs and refuses an unknown value or a limit over 24', () => {
    expect(
      featuredCollectionSchema.safeParse({ layout: 'menu', tabs: 'categories', limit: 24 }).success
    ).toBe(true);
    expect(featuredCollectionSchema.safeParse({ layout: 'grid', tabs: 'none' }).success).toBe(true);
    expect(featuredCollectionSchema.safeParse({}).success).toBe(true); // today's defaults
    expect(featuredCollectionSchema.safeParse({ layout: 'carousel' }).success).toBe(false);
    expect(featuredCollectionSchema.safeParse({ tabs: 'chips' }).success).toBe(false);
    expect(featuredCollectionSchema.safeParse({ limit: 25 }).success).toBe(false);
  });
  it('maker-profile is strict, every field optional, variants strip and lead only', () => {
    expect(makerProfileSchema.safeParse({}).success).toBe(true);
    expect(
      makerProfileSchema.safeParse({
        variant: 'lead',
        image: 'https://x/m.webp',
        name: 'Salma',
        nameAr: 'سلمى',
        role: 'Home cook',
        story: 'x',
        hygiene: 'Licensed kitchen',
        years: 12,
        storyLink: '/about',
      }).success
    ).toBe(true);
    expect(makerProfileSchema.safeParse({ variant: 'card' }).success).toBe(false);
    expect(makerProfileSchema.safeParse({ years: 99 }).success).toBe(false);
    expect(makerProfileSchema.safeParse({ storyLink: 'javascript:alert(1)' }).success).toBe(false);
    expect(makerProfileSchema.safeParse({ mystery: 1 }).success).toBe(false);
  });
  it('category-grid parses tint aisles and none and refuses an unknown tint', () => {
    const base = {
      enabled: true,
      layout: 'tiles',
      captionPosition: 'below',
      desktopColumns: 4,
      mobileColumns: 3,
    };
    const cats = storeLayoutSchema.shape.categories.unwrap();
    expect(cats.safeParse({ ...base, tint: 'aisles' }).success).toBe(true);
    expect(cats.safeParse({ ...base, tint: 'none' }).success).toBe(true);
    expect(cats.safeParse(base).success).toBe(true);
    expect(cats.safeParse({ ...base, tint: 'rainbow' }).success).toBe(false);
  });
  it('the registry declares the section and the new settings with Arabic labels', () => {
    const def = getSectionDefinition('maker-profile')!;
    expect(def.group).toBe('template');
    expect(def.legacyKey).toBeNull();
    expect(def.labelAr).toBe('ملف الطباخة');
    expect(def.settings.map(s => s.id)).toEqual(
      expect.arrayContaining(['variant', 'image', 'name', 'role', 'story', 'hygiene', 'years'])
    );
    const fc = getSectionDefinition('featured-collection')!;
    const layoutSetting = fc.settings.find(s => s.id === 'layout')!;
    expect(layoutSetting.options?.map(o => o.value)).toEqual(['grid', 'menu']);
    expect(layoutSetting.options?.find(o => o.value === 'menu')?.labelAr).toBe('قائمة بالأقسام');
    const tint = getSectionDefinition('category-grid')!.settings.find(s => s.id === 'tint')!;
    expect(tint.options?.find(o => o.value === 'aisles')?.labelAr).toBe('ألوان الممرات');
  });
  it('look design keys include the new design fields, so a look can set them', () => {
    for (const k of ['tint', 'tabs', 'variant', 'layout']) expect(LOOK_DESIGN_KEYS).toContain(k);
  });
  it('the Lamma family composes the new sections', () => {
    const f = TEMPLATE_FAMILIES.find(x => x.id === 'lamma')!;
    expect(f.sectionTypes).toEqual(
      expect.arrayContaining(['maker-profile', 'featured-collection'])
    );
  });
});

describe('groupMenuProducts (merchant category order)', () => {
  it('groups in the merchant order, lists a dish once under its first category, keeps strays', () => {
    const groups = groupMenuProducts(POOL as never, CATS);
    expect(groups.map(g => g.key)).toEqual(['tagines', 'sweets', 'pantry', 'other']);
    expect(groups[0].products.map(p => p.id)).toEqual(['a', 'c']);
    expect(groups[1].products.map(p => p.id)).toEqual(['b']);
    expect(groups[3].products.map(p => p.id)).toEqual(['e']);
    expect(groups.flatMap(g => g.products).length).toBe(POOL.length);
  });
  it('a different merchant order changes the groups, never an alphabetical sort', () => {
    const reversed = groupMenuProducts(POOL as never, [...CATS].reverse());
    expect(reversed.map(g => g.key)).toEqual(['pantry', 'sweets', 'tagines', 'other']);
    expect(reversed[1].products.map(p => p.id)).toEqual(['b', 'c']);
  });
  it('a category with no dish makes no group', () => {
    const groups = groupMenuProducts([POOL[0]] as never, CATS);
    expect(groups.map(g => g.key)).toEqual(['tagines']);
  });
});

const menu = (over: Record<string, unknown> = {}, products = POOL, cats = CATS) => (
  <MenuSection
    sectionId="sec1"
    settings={{ heading: 'Menu', headingAr: 'منيو النهاردة', ...over }}
    products={products as never}
    categories={cats}
    pack="lamma"
    onAddToCart={async () => {}}
  />
);

describe('MenuSection', () => {
  it('renders category tabs as anchor links, each a 44px target, and dish rows grouped under them', () => {
    const { container } = render(menu());
    const tabs = container.querySelectorAll('[data-part="menu-tabs"] a');
    expect(Array.from(tabs).map(a => a.textContent)).toEqual([
      'طواجن',
      'حلويات',
      'بقالة',
      'حاجات تانية',
    ]);
    for (const a of Array.from(tabs)) {
      const target = container.querySelector(a.getAttribute('href')!);
      expect(target, a.getAttribute('href') ?? '').not.toBeNull();
    }
    expect(smallTargets(container.querySelector('[data-part="menu-tabs"]')!, 44)).toEqual([]);
    expect(container.querySelectorAll('[data-menu-group]')).toHaveLength(4);
    expect(container.querySelectorAll('article')).toHaveLength(5);
    // the first tab is current until the page scrolls
    expect(tabs[0].getAttribute('aria-current')).toBe('true');
  });
  it('the tab strip is a navigation with a name, not a tablist, and is sticky below the header', () => {
    const { container } = render(menu());
    const nav = container.querySelector('[data-part="menu-tabs"]')!;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('أقسام المنيو');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(nav.className).toContain('sticky');
    expect(nav.className).toContain('--header-h');
    // one offset source: the strip publishes its height for html{scroll-padding-top} (2.4.11)
    expect(document.documentElement.style.getPropertyValue('--sticky-extra')).toMatch(/^\d+px$/);
    expect(container.querySelector('[data-menu-group]')!.className).not.toContain('scroll-mt-');
  });
  it('each dish is the shared card in row orientation: photo at the start, the same data and links', () => {
    const { container } = render(menu());
    const first = container.querySelector('article')!;
    expect(first.className).toContain('flex-row');
    const thumb = first.querySelector('[data-card-thumb]')!;
    expect(thumb.getAttribute('class')).toContain('w-32');
    expect(thumb.getAttribute('href')).toBe('/products/dish-a');
    expect(first.textContent).toContain('طبق a');
    // a menu is not a browsing grid: no wishlist heart on a row
    expect(first.querySelector('button[aria-pressed]')).toBeNull();
  });
  it('no tabs for one category, with tabs none, and a category with no dish makes no tab', () => {
    const one = render(menu({}, [POOL[0], POOL[2]], CATS));
    expect(one.container.querySelector('[data-part="menu-tabs"]')).toBeNull();
    cleanup();
    expect(
      render(menu({ tabs: 'none' })).container.querySelector('[data-part="menu-tabs"]')
    ).toBeNull();
    cleanup();
    const noPantry = render(
      menu(
        {},
        POOL.filter(p => p.id !== 'd')
      )
    );
    expect(
      Array.from(noPantry.container.querySelectorAll('[data-part="menu-tabs"] a')).map(
        a => a.textContent
      )
    ).not.toContain('بقالة');
  });
  it('a sold-out dish keeps its row, its link and the shared sold-out label', () => {
    const soldOut = [dish('x', ['tagines'], { inventory: 0 }), dish('y', ['sweets'])];
    const { container } = render(menu({}, soldOut as never));
    const row = container.querySelector('a[href="/products/dish-x"]');
    expect(row).not.toBeNull();
    expect(container.textContent).toContain('نفدت الكمية');
  });
  it('an empty pool renders nothing', () => {
    expect(render(menu({}, [])).container.innerHTML).toBe('');
  });
  it('speaks English with the same structure', () => {
    setStore('lamma', 'en');
    const { container } = render(menu({ heading: 'Menu' }));
    expect(
      Array.from(container.querySelectorAll('[data-part="menu-tabs"] a')).map(a => a.textContent)
    ).toEqual(['Tagines', 'Sweets', 'Pantry', 'More']);
  });
  it('renders sanely on every skin, never on one tenant', () => {
    for (const pack of ['qamar', 'souq', 'dahab', 'lamma', 'jasmine'] as const) {
      setStore(pack, 'ar', null);
      const { container } = render(
        <MenuSection
          sectionId="sec1"
          settings={{ headingAr: 'منيو' }}
          products={POOL as never}
          categories={CATS}
          pack={pack}
          onAddToCart={async () => {}}
        />
      );
      expect(container.querySelectorAll('article').length, pack).toBe(5);
      cleanup();
    }
  });
});

describe('MakerProfileSection', () => {
  const full = {
    image: 'https://x/m.webp',
    name: 'Salma',
    nameAr: 'سلمى',
    role: 'Home cook',
    roleAr: 'طباخة بيت',
    story: 'I cook for my family.',
    storyAr: 'بطبخ لأسرتي وجيراني.',
    hygiene: 'Licensed kitchen',
    hygieneAr: 'مطبخ مرخّص',
    years: 12,
    storyLink: '/about',
  };
  it('strip: avatar, name, one line and the hygiene line', () => {
    const { container } = render(<MakerProfileSection settings={{ ...full, variant: 'strip' }} />);
    const sec = container.querySelector('[data-section="maker-profile"]')!;
    expect(sec.getAttribute('data-variant')).toBe('strip');
    expect(sec.querySelector('img')!.getAttribute('class')).toContain('h-16');
    expect(sec.textContent).toContain('سلمى');
    expect(sec.textContent).toContain('طباخة بيت');
    expect(sec.textContent).toContain('مطبخ مرخّص');
  });
  it('lead: the photo comes first and large, the heading names the kitchen, the story is clamped, a link reads the story', () => {
    const { container } = render(<MakerProfileSection settings={{ ...full, variant: 'lead' }} />);
    const sec = container.querySelector('[data-section="maker-profile"]')!;
    expect(sec.getAttribute('data-variant')).toBe('lead');
    // the photo is the first element of the grid; text never sits over it (taste rule 7)
    const grid = sec.querySelector('.grid')!;
    expect(grid.firstElementChild!.tagName).toBe('IMG');
    expect(grid.firstElementChild!.getAttribute('class')).toContain('aspect-[4/3]');
    expect(sec.querySelector('h2')!.textContent).toBe('من مطبخ سلمى');
    expect(sec.querySelector('.line-clamp-5')!.textContent).toBe('بطبخ لأسرتي وجيراني.');
    const link = sec.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/about');
    expect(link.textContent).toBe('اقرأ الحكاية');
    expect(smallTargets(sec, 44)).toEqual([]);
  });
  it('every field is optional: a name alone or a photo alone renders; neither renders nothing', () => {
    expect(
      render(<MakerProfileSection settings={{ nameAr: 'سلمى' }} />).container.innerHTML
    ).not.toBe('');
    cleanup();
    expect(
      render(<MakerProfileSection settings={{ image: 'https://x/m.webp' }} />).container.innerHTML
    ).not.toBe('');
    cleanup();
    expect(
      render(<MakerProfileSection settings={{ variant: 'lead', story: 'x' }} />).container.innerHTML
    ).toBe('');
    cleanup();
    expect(render(<MakerProfileSection settings={{}} />).container.innerHTML).toBe('');
  });
  it('the editor canvas shows a hint for an empty profile so it can be selected; the storefront does not', () => {
    const { container } = render(<MakerProfileSection settings={{}} editorMode />);
    expect(container.querySelector('[data-empty-section="makerProfile"]')).not.toBeNull();
  });
  it('the active language wins and a blank twin falls back to the other, never to nothing', () => {
    setStore('lamma', 'ar');
    let r = render(<MakerProfileSection settings={{ name: 'Salma', nameAr: '   ' }} />);
    expect(r.container.textContent).toContain('Salma');
    cleanup();
    setStore('lamma', 'en');
    r = render(<MakerProfileSection settings={{ name: 'Salma', nameAr: 'سلمى' }} />);
    expect(r.container.textContent).toContain('Salma');
    expect(r.container.textContent).not.toContain('سلمى');
  });
  it('an unsafe story link is dropped, not rendered', () => {
    const { container } = render(
      <MakerProfileSection
        settings={{ ...full, variant: 'lead', storyLink: 'javascript:alert(1)' }}
      />
    );
    const href = container.querySelector('a')?.getAttribute('href') ?? '';
    expect(href).not.toMatch(/^javascript:/i);
  });
});

describe('aisle tiles (Ruling B4-2)', () => {
  const tiles = (extra: Record<string, unknown> = {}) => (
    <CategoryTiles
      categories={[
        { id: '1', name: 'Veg', nameAr: 'خضار', slug: 'veg', image: 'https://x/v.webp' },
        { id: '2', name: 'Dairy', nameAr: 'ألبان', slug: 'dairy' },
        { id: '3', name: 'Meat', nameAr: 'لحوم', slug: 'meat', image: 'https://x/m.webp' },
        { id: '4', name: 'Dry', nameAr: 'بقالة', slug: 'dry' },
        { id: '5', name: 'Bakery', nameAr: 'مخبوزات', slug: 'bakery' },
      ]}
      isRtl
      urlPrefix=""
      pack="lamma"
      mobileColumns={3}
      desktopColumns={4}
      {...extra}
    />
  );
  const AISLES = getLook('lamma.market')!.chrome!.aisles!;
  it('cycles the look aisle colours as washes; the name is always present', () => {
    const { container } = render(tiles({ tint: 'aisles', aisles: AISLES }));
    const t = Array.from(container.querySelectorAll('[data-part="tile"]')) as HTMLElement[];
    expect(t.map(x => x.getAttribute('data-aisle'))).toEqual(['0', '1', '2', '3', '0']);
    expect(t[0].style.backgroundColor).toContain('color-mix');
    for (const name of ['خضار', 'ألبان', 'لحوم', 'بقالة', 'مخبوزات'])
      expect(container.textContent).toContain(name);
  });
  it('is the plain card surface without a tint or without aisles', () => {
    for (const extra of [
      {},
      { tint: 'none', aisles: AISLES },
      { tint: 'aisles' },
      { tint: 'aisles', aisles: [] },
    ]) {
      const { container } = render(tiles(extra));
      for (const el of Array.from(container.querySelectorAll('[data-part="tile"]')))
        expect((el as HTMLElement).style.backgroundColor).toBe('');
      cleanup();
    }
  });
  it('tiles are 44px targets and a category without a photo is a typographic tile', () => {
    const { container } = render(tiles({ tint: 'aisles', aisles: AISLES }));
    expect(smallTargets(container, 44)).toEqual([]);
    expect(container.querySelectorAll('[data-part="typographic"]').length).toBe(3);
  });
  it('the aisles are not orange, and ink on every 20% wash clears 4.5:1 (and 10:1)', () => {
    expect(AISLES).toEqual(['#23744A', '#CC2F3F', '#5B2A6E', '#0F7F8C']);
    for (const hex of AISLES) {
      expect(isOrangeFamily(hex), hex).toBe(false);
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      const mix = (c: number) => Math.round(c * 0.2 + 255 * 0.8);
      const wash = `#${[r, g, b].map(c => mix(c).toString(16).padStart(2, '0')).join('')}`;
      expect(isOrangeFamily(wash), wash).toBe(false);
      expect(contrastRatio(wash, '#1B1B1B'), wash).toBeGreaterThanOrEqual(10);
    }
    expect(aisleTint('#23744A')).toBe('color-mix(in srgb, #23744A 20%, hsl(var(--background)))');
  });
});
