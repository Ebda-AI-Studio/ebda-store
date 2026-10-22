/**
 * Ruling VE-3 (amended): product, collection and cart pages are section documents with ONE pinned main
 * section. Pure rules: the default document equals today's order, the reducer never removes or hides the
 * main section (it can move), a section type only goes where it belongs, and the validator enforces the
 * same on every write.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAGE_SECTIONS,
  MAIN_SECTION_TYPE,
  PAGE_KINDS,
  SECTION_PAGE_KINDS,
  SECTION_REGISTRY,
  defaultPageDocument,
  getSectionDefinition,
  layoutToDefinition,
  pageDefinitionSchema,
  reduceDocument,
  resolveLayoutSettings,
  validateDefinitionSync,
  PAGE_SETTINGS,
  PAGE_OWNED_SETTING_KEYS,
  ALL_PAGE_OWNED_KEYS,
  pageSettingFor,
  pickOwnedSettings,
  publishedDocumentAgrees,
  definitionToLayout,
  storeLayoutSchema,
  type PageDefinition,
} from '@ebda/shared';

const ids = (d: PageDefinition) => d.sections.map(n => n.id);

describe('default page documents', () => {
  it.each(SECTION_PAGE_KINDS)(
    '%s: valid, in the storefront order, one pinned main section',
    kind => {
      const d = defaultPageDocument(kind);
      expect(pageDefinitionSchema.safeParse(d).success).toBe(true);
      expect(validateDefinitionSync(d)).toMatchObject({ ok: true, errors: [] });
      expect(d.pageKey).toBe(kind);
      expect(d.sections.map(n => n.type)).toEqual([...DEFAULT_PAGE_SECTIONS[kind]]);
      expect(new Set(ids(d)).size).toBe(d.sections.length);
      expect(d.sections.filter(n => n.type === MAIN_SECTION_TYPE[kind])).toHaveLength(1);
      expect(d.sectionGroups).toEqual({ header: [], footer: [] });
      expect(d.siteSettings).toEqual({});
      expect(d.sections.every(n => n.hidden === false || n.hidden === undefined)).toBe(true);
    }
  );

  it('is the order the pages render today (product: main, faq, reviews, bundles, recommendations, related)', () => {
    expect(ids(defaultPageDocument('product'))).toEqual([
      'product-main',
      'product-faq',
      'product-reviews',
      'product-bundles',
      'product-recommendations',
      'product-related',
    ]);
    expect(ids(defaultPageDocument('collection'))).toEqual(['collection-main']);
    expect(ids(defaultPageDocument('cart'))).toEqual(['cart-main', 'cart-recommendations']);
  });

  it('is a fresh object every time (no shared state between stores)', () => {
    const a = defaultPageDocument('cart');
    a.sections.pop();
    expect(defaultPageDocument('cart').sections).toHaveLength(2);
  });
});

describe('registry: where each type may appear', () => {
  it('every home-page type is still home-only unless it is shared on purpose', () => {
    const shared = SECTION_REGISTRY.filter(d => d.pages.length > 1).map(d => d.type);
    expect(shared.sort()).toEqual(['image-text', 'maker-profile', 'newsletter', 'trust-badges']);
    for (const d of SECTION_REGISTRY.filter(x => x.pages.length > 1))
      expect(d.pages).toEqual(PAGE_KINDS);
  });
  it('page-kind types belong to exactly their page, are document-only, and the three mains are pinned', () => {
    for (const [kind, main] of Object.entries(MAIN_SECTION_TYPE)) {
      const d = getSectionDefinition(main)!;
      expect(d.pinned).toBe(true);
      expect(d.pages).toEqual([kind]);
      expect(d.legacyKey).toBeNull();
    }
    for (const t of [
      'product-faq',
      'product-reviews',
      'product-bundles',
      'product-recommendations',
      'product-related',
    ])
      expect(getSectionDefinition(t)).toMatchObject({
        pages: ['product'],
        pinned: false,
        maxCount: 1,
      });
    expect(getSectionDefinition('cart-recommendations')?.pages).toEqual(['cart']);
    // nothing else is pinned
    expect(
      SECTION_REGISTRY.filter(d => d.pinned)
        .map(d => d.type)
        .sort()
    ).toEqual(Object.values(MAIN_SECTION_TYPE).sort());
  });
});

describe('reducer: the main section is pinned', () => {
  const cart = () => defaultPageDocument('cart');
  it('cannot be removed, hidden or duplicated', () => {
    expect(reduceDocument(cart(), { type: 'removeSection', id: 'cart-main' }).rejected).toBe(
      'PINNED'
    );
    expect(
      reduceDocument(cart(), { type: 'setSectionHidden', id: 'cart-main', hidden: true }).rejected
    ).toBe('PINNED');
    expect(reduceDocument(cart(), { type: 'duplicateSection', id: 'cart-main' }).rejected).toBe(
      'PINNED'
    );
  });
  it('can be moved, and un-hidden (a document from before the rule)', () => {
    const moved = reduceDocument(cart(), { type: 'moveSection', id: 'cart-main', toIndex: 1 });
    expect(moved.rejected).toBeUndefined();
    expect(ids(moved.doc)).toEqual(['cart-recommendations', 'cart-main']);
    const hidden = {
      ...cart(),
      sections: cart().sections.map(n => (n.id === 'cart-main' ? { ...n, hidden: true } : n)),
    };
    expect(
      reduceDocument(hidden, { type: 'setSectionHidden', id: 'cart-main', hidden: false }).rejected
    ).toBeUndefined();
  });
  it('the other sections stay freely removable, hideable and movable', () => {
    const d = defaultPageDocument('product');
    expect(
      reduceDocument(d, { type: 'removeSection', id: 'product-reviews' }).rejected
    ).toBeUndefined();
    expect(
      reduceDocument(d, { type: 'setSectionHidden', id: 'product-faq', hidden: true }).rejected
    ).toBeUndefined();
    expect(
      reduceDocument(d, { type: 'moveSection', id: 'product-related', toIndex: 0 }).rejected
    ).toBeUndefined();
  });
});

describe('reducer: a section only goes where it belongs', () => {
  it('refuses a home-only section on a product page, and a product section on the home page', () => {
    const r = reduceDocument(defaultPageDocument('product'), {
      type: 'addSection',
      list: 'template',
      sectionType: 'hero',
      presetIndex: 0,
    });
    expect(r.rejected).toBe('PAGE_MISMATCH');
    const home = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
    expect(
      reduceDocument(home, {
        type: 'addSection',
        list: 'template',
        sectionType: 'product-reviews',
        presetIndex: 0,
      }).rejected
    ).toBe('PAGE_MISMATCH');
    // the cart's recommendations on the product page
    expect(
      reduceDocument(defaultPageDocument('product'), {
        type: 'addSection',
        list: 'template',
        sectionType: 'cart-recommendations',
        presetIndex: 0,
      }).rejected
    ).toBe('PAGE_MISMATCH');
  });
  it('accepts a shared section on every page, at an index, and a singleton only once', () => {
    for (const kind of SECTION_PAGE_KINDS) {
      const r = reduceDocument(defaultPageDocument(kind), {
        type: 'addSection',
        list: 'template',
        sectionType: 'image-text',
        presetIndex: 0,
        index: 1,
      });
      expect(r.rejected, kind).toBeUndefined();
      expect(r.doc.sections[1].type).toBe('image-text');
    }
    // the singleton: reviews are already on the page
    expect(
      reduceDocument(defaultPageDocument('product'), {
        type: 'addSection',
        list: 'template',
        sectionType: 'product-reviews',
        presetIndex: 0,
      }).rejected
    ).toBe('CARDINALITY');
    // after removing it, it can be added again
    const without = reduceDocument(defaultPageDocument('product'), {
      type: 'removeSection',
      id: 'product-reviews',
    }).doc;
    expect(
      reduceDocument(without, {
        type: 'addSection',
        list: 'template',
        sectionType: 'product-reviews',
        presetIndex: 0,
      }).rejected
    ).toBeUndefined();
  });
  it('an unknown page key behaves like the home page (content pages keep working)', () => {
    const d = { ...layoutToDefinition(resolveLayoutSettings({}, 'modern')), pageKey: 'about' };
    expect(
      reduceDocument(d, {
        type: 'addSection',
        list: 'template',
        sectionType: 'image-text',
        presetIndex: 0,
      }).rejected
    ).toBeUndefined();
  });
});

describe('validator enforces the same on every write', () => {
  const codes = (d: unknown) => validateDefinitionSync(d).errors.map(e => e.code);
  it('a section of the wrong page is PAGE_MISMATCH, in both directions', () => {
    const cart = defaultPageDocument('cart');
    const withHero = {
      ...cart,
      sections: [...cart.sections, { id: 'hero', type: 'hero', settings: {} }],
    };
    expect(codes(withHero)).toContain('PAGE_MISMATCH');
    const home = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
    expect(
      codes({
        ...home,
        sections: [...home.sections, { id: 'product-main', type: 'product-main', settings: {} }],
      })
    ).toContain('PAGE_MISMATCH');
  });
  it('a missing or hidden main section is PINNED', () => {
    const p = defaultPageDocument('product');
    expect(codes({ ...p, sections: p.sections.filter(n => n.type !== 'product-main') })).toContain(
      'PINNED'
    );
    expect(
      codes({
        ...p,
        sections: p.sections.map(n => (n.type === 'product-main' ? { ...n, hidden: true } : n)),
      })
    ).toContain('PINNED');
  });
  it('a section page holds sections only: no header/footer, theme, chrome, typography or page settings', () => {
    const p = defaultPageDocument('collection');
    const header = { id: 'header', type: 'header', settings: {} };
    expect(codes({ ...p, sectionGroups: { header: [header], footer: [] } })).toContain(
      'PAGE_MISMATCH'
    );
    for (const patch of [
      { theme: { primaryColor: '1 1% 1%' } },
      { typography: { fonts: [] } },
      { siteSettings: { sizing: {} } },
    ])
      expect(codes({ ...p, ...patch }), JSON.stringify(patch)).toContain('PAGE_MISMATCH');
  });
  it('the home document is unaffected', () => {
    const home = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
    expect(
      validateDefinitionSync(home).errors.filter(
        e => e.code === 'PAGE_MISMATCH' || e.code === 'PINNED'
      )
    ).toEqual([]);
  });
});

describe('page-type settings (Ruling VE-13)', () => {
  it('every setting a page offers is a field the layout schema accepts, and owned keys are never shared', () => {
    const seen = new Set<string>();
    for (const [kind, groups] of Object.entries(PAGE_SETTINGS)) {
      for (const g of groups) {
        // one writer per key
        expect(seen.has(g.key), `${g.key} listed twice`).toBe(false);
        seen.add(g.key);
        const shape = (storeLayoutSchema.shape as Record<string, { unwrap?: () => unknown }>)[
          g.key
        ];
        expect(shape, `${kind}/${g.key} is not a layout key`).toBeDefined();
        for (const st of g.settings) expect(st.id.split('.').length).toBeLessThanOrEqual(2);
      }
    }
    // the owned keys are exactly the keys of the three section pages' groups
    for (const kind of SECTION_PAGE_KINDS)
      expect(PAGE_SETTINGS[kind].map(g => g.key)).toEqual([...PAGE_OWNED_SETTING_KEYS[kind]]);
    // a look switch rewrites the card defaults on the home document: nobody else owns them
    expect(ALL_PAGE_OWNED_KEYS.has('productCardDefaults')).toBe(false);
    expect(PAGE_SETTINGS.home.some(g => g.key === 'productCardDefaults')).toBe(true);
  });

  it('every control value the panel can write passes the layout schema (select options, colours, toggles)', () => {
    for (const groups of Object.values(PAGE_SETTINGS))
      for (const g of groups)
        for (const st of g.settings) {
          const sample =
            st.type === 'select'
              ? st.options![0].value
              : st.type === 'checkbox'
                ? true
                : st.type === 'color'
                  ? '#112233'
                  : 'text';
          const [head, ...rest] = st.id.split('.');
          const value = rest.length ? { [head]: { [rest[0]]: sample } } : { [head]: sample };
          // `sizing` and `filterSidebar` are all-or-nothing in the layout schema: the editor always has the full object
          const full =
            g.key === 'sizing'
              ? {
                  heroAspect: '16:9',
                  productImageAspect: '1:1',
                  categoryImageAspect: '1:1',
                  ...value,
                }
              : g.key === 'filterSidebar'
                ? { enabled: true, defaultOpen: true, ...value }
                : value;
          const r = storeLayoutSchema.partial().safeParse({ [g.key]: full });
          expect(r.success, `${g.key}.${st.id} = ${JSON.stringify(sample)}`).toBe(true);
        }
  });

  it('setSiteSetting writes, nests one level, clears, prunes empty objects, and refuses a foreign setting', () => {
    const cart = defaultPageDocument('cart');
    const a = reduceDocument(cart, {
      type: 'setSiteSetting',
      key: 'cartPage',
      path: 'density',
      value: 'compact',
    });
    expect(a.doc.siteSettings).toEqual({ cartPage: { density: 'compact' } });
    const b = reduceDocument(a.doc, {
      type: 'setSiteSetting',
      key: 'cartPage',
      path: 'density',
      value: undefined,
    });
    expect(b.doc.siteSettings).toEqual({});
    // a key another page owns, an unknown path, and the home-only key are refused with the document untouched
    for (const [key, path] of [
      ['productDetailPage', 'density'],
      ['cartPage', 'nonsense'],
      ['sizing', 'heroAspect'],
    ] as const) {
      const r = reduceDocument(cart, { type: 'setSiteSetting', key, path, value: 'x' });
      expect(r.rejected, `${key}.${path}`).toBe('UNKNOWN_SETTING');
      expect(r.doc).toBe(cart);
    }
    // home: its own keys, one nesting level down for the card badges
    const home = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
    const c = reduceDocument(home, {
      type: 'setSiteSetting',
      key: 'productCardDefaults',
      path: 'discountBadge.position',
      value: 'top-left',
    });
    expect(
      (c.doc.siteSettings.productCardDefaults as Record<string, unknown>).discountBadge
    ).toEqual({ position: 'top-left' });
    const d = reduceDocument(c.doc, {
      type: 'setSiteSetting',
      key: 'productCardDefaults',
      path: 'discountBadge.position',
      value: undefined,
    });
    // the emptied badge object is removed; the other card defaults stay
    expect(
      'discountBadge' in (d.doc.siteSettings.productCardDefaults as Record<string, unknown>)
    ).toBe(false);
    expect(pageSettingFor('about', 'sizing', 'heroAspect')).toBeDefined(); // an unknown page key behaves like home
  });

  it('the first write to an all-or-nothing key starts from the baseline, so one toggle is a valid object', () => {
    const collection = defaultPageDocument('collection');
    const r = reduceDocument(collection, {
      type: 'setSiteSetting',
      key: 'filterSidebar',
      path: 'enabled',
      value: false,
    });
    expect(r.doc.siteSettings.filterSidebar).toEqual({ enabled: false, defaultOpen: true });
    expect(validateDefinitionSync(r.doc).ok).toBe(true);
  });

  it('a section document validates with its own keys and refuses the others', () => {
    const live = {
      productDetailPage: { density: 'compact' },
      cartPage: { density: 'wide?' },
      sizing: {},
    };
    expect(pickOwnedSettings('product', live)).toEqual({
      productDetailPage: { density: 'compact' },
    });
    expect(pickOwnedSettings('collection', live)).toEqual({});
    const product = defaultPageDocument('product', live);
    expect(product.siteSettings).toEqual({ productDetailPage: { density: 'compact' } });
    expect(validateDefinitionSync(product).ok).toBe(true);
    const foreign = { ...product, siteSettings: { cartPage: { density: 'compact' } } };
    expect(validateDefinitionSync(foreign).errors.map(e => e.code)).toContain('PAGE_MISMATCH');
    const invalid = { ...product, siteSettings: { productDetailPage: { density: 'huge' } } };
    expect(validateDefinitionSync(invalid).ok).toBe(false);
  });

  it("the home document does not look drifted when another page's key changes the live layout", () => {
    const layout = resolveLayoutSettings({ productDetailPage: { density: 'compact' } }, 'modern');
    const home = layoutToDefinition(layout);
    expect(publishedDocumentAgrees(home, layout, 'modern')).toBe(true);
    const later = resolveLayoutSettings(
      { productDetailPage: { density: 'spacious' }, cartPage: { textScale: 'lg' } },
      'modern'
    );
    expect(publishedDocumentAgrees(home, later, 'modern')).toBe(true);
    // a home-owned key still counts as drift
    const drifted = resolveLayoutSettings(
      { sizing: { heroAspect: '4:3', productImageAspect: '1:1', categoryImageAspect: '1:1' } },
      'modern'
    );
    expect(publishedDocumentAgrees(home, drifted, 'modern')).toBe(false);
    void definitionToLayout;
  });
});
