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
