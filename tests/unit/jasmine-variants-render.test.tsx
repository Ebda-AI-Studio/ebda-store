// @vitest-environment jsdom
/**
 * Phase B3 Task 3 (Rulings B3-5, B3-6): the tag-chips source and the routine `steps` section.
 * Both are platform sections: they render on every skin, never on one tenant. Fixtures carry every
 * required field (C2 lesson), unknown values still fail, and each control is a >= 44px target.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  storeLayoutSchema,
  stepsSchema,
  stepsBlockSchema,
  getSectionDefinition,
  sectionFromPreset,
  validateDefinitionSync,
  collectRefs,
  definitionToLayout,
  PAGE_DEFINITION_SCHEMA_VERSION,
  LOOK_DESIGN_KEYS,
  TEMPLATE_FAMILIES,
  type PageDefinition,
} from '@ebda/shared';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
  cart: [] as Array<{ productId: string }>,
  cartBundles: [] as Array<{ bundleId: string }>,
  addItem: vi.fn(async () => true),
  addBundle: vi.fn(async () => true),
  savings: [] as unknown[],
  getSavings: vi.fn(),
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
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: ctx.cart,
    bundles: ctx.cartBundles,
    addItem: ctx.addItem,
    addBundle: ctx.addBundle,
  }),
}));
vi.mock('../../apps/web/src/lib/api', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    api: { getBundleSavings: (...a: unknown[]) => ctx.getSavings(...a) },
  };
});

const { StepsSection } = await import('../../apps/web/src/builder/sections/StepsSection');
const { TagChips } = await import('../../apps/web/src/templates/shared/TagChips');

const product = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Product ${id}`,
  nameAr: `منتج ${id}`,
  slug: `p-${id}`,
  price: 10000,
  images: [{ id: `i-${id}`, url: `https://x/${id}.webp`, alt: id }],
  inventory: 5,
  categories: [],
  ...extra,
});
const POOL = [product('a'), product('b'), product('c')];
const step = (
  id: string,
  title: string,
  productId?: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  type: 'step',
  settings: { title, titleAr: title, ...(productId ? { productIds: [productId] } : {}), ...extra },
});
const THREE = [step('s1', 'تنظيف', 'a'), step('s2', 'علاج', 'b'), step('s3', 'حماية', 'c')];
const setStore = (template: string, language: 'ar' | 'en' = 'ar', features: string[] = []) => {
  ctx.language = language;
  ctx.store = {
    id: 'store-j',
    name: 'J',
    template,
    look: null,
    currency: 'EGP',
    theme: {},
    enabledFeatures: features,
  };
};
beforeEach(() => {
  ctx.cart = [];
  ctx.cartBundles = [];
  ctx.addItem.mockClear();
  ctx.addBundle.mockClear();
  ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [] } }));
  setStore('jasmine');
});
afterEach(cleanup);

describe('schema: tag source and steps', () => {
  const categories = {
    enabled: true,
    layout: 'chips',
    captionPosition: 'below',
    desktopColumns: 3,
    mobileColumns: 2,
  };
  it('category-grid parses source:tags and refuses an unknown source', () => {
    const cat = storeLayoutSchema.shape.categories.unwrap();
    const ok = cat.safeParse({ ...categories, source: 'tags' });
    expect(ok.success && ok.data.source).toBe('tags');
    expect(cat.safeParse({ ...categories, source: 'brands' }).success).toBe(false);
    expect(cat.safeParse(categories).success).toBe(true);
  });
  it('the registry offers the source setting and a look may set it (look-owned design key)', () => {
    const sel = getSectionDefinition('category-grid')!.settings.find(s => s.id === 'source')!;
    expect(sel).toBeTruthy();
    expect((sel as { options: Array<{ value: unknown }> }).options.map(o => o.value)).toEqual([
      'categories',
      'tags',
    ]);
    expect(LOOK_DESIGN_KEYS as readonly string[]).toContain('source');
  });
  it('the source survives the document -> layout projection', () => {
    const node = sectionFromPreset('category-grid', 0, 'categories');
    const def = {
      schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
      pageKey: 'home',
      sectionGroups: { header: [], footer: [] },
      siteSettings: {},
      sections: [{ ...node, settings: { ...node.settings, source: 'tags', layout: 'chips' } }],
    } as unknown as PageDefinition;
    expect(definitionToLayout(def).categories.source).toBe('tags');
  });
  it('steps: 2-5 step blocks parse, unknown keys and unsafe links fail', () => {
    expect(stepsSchema.safeParse({ heading: 'روتينك', buttonText: 'x' }).success).toBe(true);
    expect(stepsSchema.safeParse({ heading: 'x', nope: 1 }).success).toBe(false);
    expect(
      stepsBlockSchema.safeParse({
        title: 'Cleanse',
        titleAr: 'تنظيف',
        body: 'x',
        bodyAr: 'y',
        link: '/products',
        productIds: ['a'],
      }).success
    ).toBe(true);
    expect(stepsBlockSchema.safeParse({ title: 'x', link: 'javascript:alert(1)' }).success).toBe(
      false
    );
    expect(stepsBlockSchema.safeParse({ title: 'x', productIds: ['a', 'b'] }).success).toBe(false);
    expect(stepsBlockSchema.safeParse({ title: 'x', price: 5 }).success).toBe(false);
  });
  it('steps is a registered document-only section with a 5-step cap, in the jasmine family', () => {
    const d = getSectionDefinition('steps')!;
    expect(d.legacyKey).toBeNull();
    expect(d.blocks[0]).toMatchObject({ type: 'step', maxCount: 5 });
    expect(TEMPLATE_FAMILIES.find(f => f.id === 'jasmine')!.sectionTypes).toContain('steps');
  });
  it('a preset instantiates and validates; step product refs are collected for the store check', () => {
    const node = sectionFromPreset('steps', 0, 'routine');
    expect(node.blocks?.length).toBe(3);
    const withRef = {
      ...node,
      blocks: node.blocks!.map((b, i) =>
        i === 0 ? { ...b, settings: { ...b.settings, productIds: ['p-uuid-1'] } } : b
      ),
    };
    const def = {
      schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
      pageKey: 'home',
      sectionGroups: { header: [], footer: [] },
      siteSettings: {},
      sections: [withRef],
    } as unknown as PageDefinition;
    const res = validateDefinitionSync(def);
    expect(res.errors).toEqual([]);
    expect(collectRefs(def).productIds).toEqual(['p-uuid-1']);
  });
});

describe('TagChips', () => {
  const tags = [
    { id: 't1', name: 'بشرة دهنية', productCount: 4 },
    { id: 't2', name: 'حب الشباب', productCount: 2 },
  ];
  it('renders one >= 44px link per tag, to the PLP filtered by that tag, keyboard reachable', () => {
    const { container } = render(
      <TagChips tags={tags} urlPrefix="/s" isRtl label="حسب نوع بشرتك" />
    );
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map(a => a.getAttribute('href'))).toEqual([
      `/s/products?tag=${encodeURIComponent('بشرة دهنية')}`,
      `/s/products?tag=${encodeURIComponent('حب الشباب')}`,
    ]);
    expect(smallTargets(container, 44)).toEqual([]);
    expect(container.querySelector('nav')!.getAttribute('aria-label')).toBe('حسب نوع بشرتك');
    expect(container.querySelector('ul')!.getAttribute('class')).toMatch(/snap-x/);
    expect(container.querySelector('ul')!.getAttribute('class')).toMatch(/scroll-px/);
  });
  it('renders nothing for zero tags (an unfilled feature is absent, never an empty shell)', () => {
    expect(render(<TagChips tags={[]} isRtl />).container.innerHTML).toBe('');
  });
});

describe('StepsSection', () => {
  const S = (blocks: unknown[], extra: Record<string, unknown> = {}, products = POOL) => (
    <StepsSection
      settings={{ heading: 'Your routine', headingAr: 'روتينك في 3 خطوات', ...extra }}
      blocks={blocks as never}
      products={products as never}
    />
  );
  it('is an ordered list with numbers (order matters), every target >= 44px', () => {
    const { container } = render(S(THREE));
    const ol = container.querySelector('ol')!;
    expect(ol).not.toBeNull();
    expect(ol.querySelectorAll(':scope > li')).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll('[data-part="step-num"]')).map(n => n.textContent)
    ).toEqual(['1', '2', '3']);
    expect(smallTargets(container, 44)).toEqual([]);
    expect(container.querySelector('h2')!.textContent).toBe('روتينك في 3 خطوات');
  });
  it('fewer than two steps is not a routine: renders nothing publicly', () => {
    expect(render(S([step('s1', 'تنظيف', 'a')])).container.innerHTML).toBe('');
    expect(render(S([])).container.innerHTML).toBe('');
  });
  it('a step with an unknown or foreign product id shows without a product (never a broken link)', () => {
    const { container } = render(S([step('s1', 'تنظيف', 'ghost'), step('s2', 'علاج', 'b')]));
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('button')).toBeNull(); // not every step has a product
  });
  it('"add all" exists only when every step has a buyable, option-free product', () => {
    expect(render(S(THREE)).container.querySelector('button')).not.toBeNull();
    cleanup();
    // sold out (no backorder)
    const sold = [product('a'), product('b', { inventory: 0 }), product('c')];
    expect(render(S(THREE, {}, sold)).container.querySelector('button')).toBeNull();
    cleanup();
    // variant product routes to its page instead
    const variant = [product('a'), product('b', { variants: [{ price: 1 }] }), product('c')];
    const { container } = render(S(THREE, {}, variant));
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(3);
  });
  it('a ROW path reads the card-price switch, compare-at and sold-out through the shared helpers (CLAUDE.md row paths)', () => {
    const NOPRICE = (
      <StepsSection
        settings={{ heading: 'R', headingAr: 'R' }}
        blocks={THREE as never}
        products={POOL as never}
        showPrice={false}
      />
    );
    const hidden = render(NOPRICE).container;
    expect(hidden.querySelector('[data-part="steps-total"]')).toBeNull();
    expect(hidden.textContent).not.toMatch(/EGP|ج\.م/); // no price anywhere
    expect(render(S(THREE)).container.textContent).toMatch(/EGP|ج\.م/); // control: shown by default
  });
  it('a sale step shows its struck original; a sold-out step says so', () => {
    const pool = [
      product('a', { compareAtPrice: 15000 }),
      product('b', { inventory: 0 }),
      product('c'),
    ];
    const { container } = render(S(THREE, {}, pool));
    const steps = container.querySelectorAll('li');
    expect(steps[0].querySelector('s')).not.toBeNull();
    expect(steps[1].textContent).toMatch(/نفد|غير متوفر|Sold out/);
    expect(steps[2].querySelector('s')).toBeNull();
  });
  it('"add all" adds each real product through the cart path (no bundle claimed, no saving shown)', async () => {
    const { container } = render(S(THREE));
    fireEvent.click(container.querySelector('button')!);
    await waitFor(() => expect(ctx.addItem).toHaveBeenCalledTimes(3));
    expect(ctx.addItem.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(ctx.addBundle).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/وفّر/);
  });
  it('a bundle that holds exactly these products backs "add all": the real bundle is added and its saving shown', async () => {
    setStore('jasmine', 'ar', ['bundles']);
    ctx.getSavings = vi.fn(async () => ({
      success: true,
      data: {
        savings: [
          {
            bundleId: 'bun-1',
            slug: 'routine',
            name: 'Routine',
            nameAr: 'الروتين',
            price: 25500,
            componentSum: 30000,
            saving: 4500,
            percent: 15,
            exact: true,
          },
        ],
      },
    }));
    const { container } = render(S(THREE));
    await waitFor(() => expect(container.textContent).toMatch(/وفّر 15%/));
    expect(ctx.getSavings).toHaveBeenCalledWith('store-j', ['a', 'b', 'c']);
    fireEvent.click(container.querySelector('button')!);
    await waitFor(() => expect(ctx.addBundle).toHaveBeenCalledWith('bun-1', 1));
    expect(ctx.addItem).not.toHaveBeenCalled();
  });
  it('a bundle that is not exactly these products does not back "add all"', async () => {
    setStore('jasmine', 'ar', ['bundles']);
    ctx.getSavings = vi.fn(async () => ({
      success: true,
      data: {
        savings: [
          {
            bundleId: 'b',
            slug: 's',
            name: 'n',
            nameAr: null,
            price: 1,
            componentSum: 2,
            saving: 1,
            percent: 50,
            exact: false,
          },
        ],
      },
    }));
    const { container } = render(S(THREE));
    await waitFor(() => expect(ctx.getSavings).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/وفّر/);
  });
  it('without the bundles feature no saving request is made at all', () => {
    render(S(THREE));
    expect(ctx.getSavings).not.toHaveBeenCalled();
  });
  it('a step ticks when its product is already in the cart (data-done), others stay open', () => {
    ctx.cart = [{ productId: 'b' }];
    const { container } = render(S(THREE));
    expect(
      Array.from(container.querySelectorAll('[data-part="step"]')).map(l =>
        l.getAttribute('data-done')
      )
    ).toEqual(['false', 'true', 'false']);
    expect(container.querySelectorAll('li')[1].textContent).toContain('في سلتك');
  });
  it('when the routine bundle itself is in the cart every step ticks (one bundle row holds all three products)', async () => {
    setStore('jasmine', 'ar', ['bundles']);
    ctx.getSavings = vi.fn(async () => ({
      success: true,
      data: {
        savings: [
          {
            bundleId: 'bun-1',
            slug: 'r',
            name: 'R',
            nameAr: null,
            price: 1,
            componentSum: 2,
            saving: 1,
            percent: 15,
            exact: true,
          },
        ],
      },
    }));
    ctx.cartBundles = [{ bundleId: 'bun-1' }];
    const { container } = render(S(THREE));
    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll('[data-part="step"]')).map(l =>
          l.getAttribute('data-done')
        )
      ).toEqual(['true', 'true', 'true'])
    );
    // a different bundle in the cart ticks nothing
    cleanup();
    ctx.cartBundles = [{ bundleId: 'other' }];
    const other = render(S(THREE));
    await waitFor(() => expect(ctx.getSavings).toHaveBeenCalled());
    expect(
      Array.from(other.container.querySelectorAll('[data-part="step"]')).map(l =>
        l.getAttribute('data-done')
      )
    ).toEqual(['false', 'false', 'false']);
  });
  it('English: neutral button text and the page language headings', () => {
    setStore('jasmine', 'en');
    const { container } = render(S(THREE));
    expect(container.querySelector('button')!.textContent).toBe('Add all to cart');
    expect(container.querySelector('h2')!.textContent).toBe('Your routine');
  });
  it('Arabic button text is the neutral short form', () => {
    const { container } = render(S(THREE));
    expect(container.querySelector('button')!.textContent).toBe('إضافة الكل للسلة');
  });
  it('renders on every skin (platform section, never one tenant)', () => {
    for (const template of ['minimal', 'dahab', 'qamar', 'souq', 'jasmine']) {
      setStore(template);
      const { container } = render(S(THREE));
      expect(container.querySelectorAll('li'), template).toHaveLength(3);
      cleanup();
    }
  });
});
