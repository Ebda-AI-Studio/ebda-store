import { describe, it, expect } from 'vitest';
import {
  applyTemplateFamily,
  getLook,
  LOOKS,
  LOOK_DESIGN_KEYS,
  getSectionDefinition,
  sectionFromPreset,
  PAGE_DEFINITION_SCHEMA_VERSION,
  layoutToDefinition,
  resolveLayoutSettings,
  documentForLook,
  validateDefinitionSync,
  type LookDefinition,
  type PageDefinition,
  type SectionNode,
} from '@ebda/shared';

const base = (): PageDefinition => {
  const hero = sectionFromPreset('hero', 1, 'hero');
  hero.settings = { ...hero.settings, presentation: 'framed' };
  hero.blocks = [
    { id: 's1', type: 'slide', settings: { image: 'https://x/a.webp', headlineAr: 'مرحبا' } },
  ];
  const it = sectionFromPreset('image-text', 0, 'story');
  it.settings = { ...it.settings, headingAr: 'حكايتي', image: 'https://x/b.webp' };
  return {
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey: 'home',
    sectionGroups: { header: [], footer: [] },
    sections: [hero, it],
    siteSettings: {},
  };
};

const defaultsOf = (type: string) => sectionFromPreset(type, 0, type).settings;
const byType = (doc: PageDefinition, type: string) => doc.sections.find(s => s.type === type)!;

// Lookbook's and Vitrine's real mixes land in Tasks 7–8; these stand-ins carry the exact
// design keys the preflight found leaking between them (featured-collection bgColor on
// Lookbook, testimonials layout on Vitrine).
type Mix = Pick<LookDefinition, 'sections'>;
const lookbookLike: Mix = {
  sections: [
    { type: 'hero' },
    { type: 'featured-collection', design: { bgColor: 'token:card', columns: 3 } },
    { type: 'testimonials' },
    { type: 'image-text' },
  ],
};
const vitrineLike: Mix = {
  sections: [
    { type: 'hero', design: { presentation: 'framed' } },
    { type: 'featured-collection' },
    { type: 'testimonials', design: { layout: 'single' } },
  ],
};

/** Every setting a look may not touch, plus blocks: the section's content. */
const content = (n: SectionNode) => ({
  settings: Object.fromEntries(
    Object.entries(n.settings).filter(([k]) => !(LOOK_DESIGN_KEYS as readonly string[]).includes(k))
  ),
  blocks: n.blocks,
});

describe('look section mix', () => {
  it('every Qamar look renders on the qamar skin', () => {
    const qamar = LOOKS.filter(l => l.template === 'qamar');
    expect(qamar).toHaveLength(3);
    for (const l of qamar) expect(l.skin).toBe('qamar');
  });

  it('every mix entry names a template-group registry section and only design keys', () => {
    for (const l of LOOKS) {
      const types = (l.sections ?? []).map(s => s.type);
      expect(new Set(types).size, `${l.id}: one spec per type`).toBe(types.length);
    }
    expect(LOOK_DESIGN_KEYS).not.toContain('mode'); // hero mode is content (slideshow vs single)
    for (const l of LOOKS)
      for (const s of l.sections ?? []) {
        expect(getSectionDefinition(s.type)?.group, `${l.id}:${s.type}`).toBe('template');
        for (const k of Object.keys(s.design ?? {}))
          expect(LOOK_DESIGN_KEYS, `${l.id}:${s.type}.${k}`).toContain(k);
      }
  });

  it('Atelier: chrome logo at the start, carousel preset never names a category (C7)', () => {
    const atelier = getLook('qamar.atelier')!;
    expect(atelier.chrome).toEqual({ header: { logoPlacement: 'start' } });
    const carousel = atelier.sections!.find(s => s.type === 'product-carousel')!;
    expect(carousel.preset).toEqual({ productSource: 'newest', limit: 12 });
    for (const s of atelier.sections!) expect(s.preset ?? {}).not.toHaveProperty('categorySlug');
  });

  it('follows the look order and applies design keys to an existing section', () => {
    const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
    const types = doc.sections.map(s => s.type);
    expect(types).toEqual((getLook('qamar.atelier')!.sections ?? []).map(s => s.type));
    const hero = doc.sections.find(s => s.type === 'hero')!;
    expect(hero.settings.presentation).toBe('full-bleed');
  });

  it('a section the store lacks starts from the look preset plus its design', () => {
    const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
    expect(byType(doc, 'featured-collection').settings).toMatchObject({
      productSource: 'newest',
      limit: 8,
      headingAr: 'وصل حديثًا',
      columns: 4,
      mobileColumns: 2,
    });
    expect(byType(doc, 'product-carousel').settings).toMatchObject({
      productSource: 'newest',
      limit: 12,
    });
  });

  it('never overwrites content (Ruling B1-3)', () => {
    const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
    const hero = doc.sections.find(s => s.type === 'hero')!;
    expect(hero.blocks?.[0]?.settings.headlineAr).toBe('مرحبا');
    const story = doc.sections.find(s => s.id === 'story')!;
    expect(story.settings.headingAr).toBe('حكايتي');
    expect(story.settings.image).toBe('https://x/b.webp');
  });

  it('without a look (or a look with no mix) behaves exactly as before', () => {
    const a = applyTemplateFamily(base(), 'qamar');
    const b = applyTemplateFamily(base(), 'qamar', getLook('souq.catalogue'));
    expect(b).toEqual(a);
  });

  describe('look switch: no design leakage between looks (C6)', () => {
    it('Lookbook → Atelier drops Lookbook-only design keys back to the section default', () => {
      for (const design of ['keep', 'reset'] as const) {
        const onLookbook = applyTemplateFamily(base(), 'qamar', lookbookLike);
        expect(byType(onLookbook, 'featured-collection').settings.bgColor).toBe('token:card');
        const doc = applyTemplateFamily(onLookbook, 'qamar', getLook('qamar.atelier'), {
          from: lookbookLike,
          design,
        });
        const fc = byType(doc, 'featured-collection').settings;
        expect(fc.bgColor, design).toBe(defaultsOf('featured-collection').bgColor);
        expect(fc.columns, design).toBe(4); // Atelier's own value replaces Lookbook's 3
      }
    });

    it('Vitrine → Lookbook drops Vitrine-only design keys back to the section default', () => {
      for (const design of ['keep', 'reset'] as const) {
        const onVitrine = applyTemplateFamily(base(), 'qamar', vitrineLike);
        expect(byType(onVitrine, 'testimonials').settings.layout).toBe('single');
        const doc = applyTemplateFamily(onVitrine, 'qamar', lookbookLike, {
          from: vitrineLike,
          design,
        });
        expect(byType(doc, 'testimonials').settings.layout, design).toBe(
          defaultsOf('testimonials').layout
        );
        expect(byType(doc, 'hero').settings.presentation, design).toBe(
          defaultsOf('hero').presentation
        );
      }
    });
  });

  describe("look switch keeps the merchant's own design edits with design:'keep' (C8, TPL-1)", () => {
    const onAtelier = () => {
      const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
      // The merchant edits two Atelier-set fields after applying the look.
      return {
        ...doc,
        sections: doc.sections.map(s =>
          s.type === 'hero'
            ? { ...s, settings: { ...s.settings, presentation: 'framed' } }
            : s.type === 'featured-collection'
              ? { ...s, settings: { ...s.settings, mobileColumns: 1 } }
              : s
        ),
      };
    };

    it('keep: fields changed from the outgoing preset stay; untouched ones follow the new look', () => {
      const doc = applyTemplateFamily(onAtelier(), 'qamar', lookbookLike, {
        from: getLook('qamar.atelier'),
        design: 'keep',
      });
      expect(byType(doc, 'hero').settings.presentation).toBe('framed'); // merchant's
      expect(byType(doc, 'featured-collection').settings.mobileColumns).toBe(1); // merchant's
      expect(byType(doc, 'featured-collection').settings.columns).toBe(3); // untouched → Lookbook
      expect(byType(doc, 'featured-collection').settings.bgColor).toBe('token:card');
    });

    it('keep: a key the outgoing look never set keeps a non-default merchant value', () => {
      const start = base(); // hero presentation 'framed', set by the merchant before any look
      const doc = applyTemplateFamily(start, 'qamar', getLook('qamar.atelier'), {
        from: null,
        design: 'keep',
      });
      expect(byType(doc, 'hero').settings.presentation).toBe('framed');
    });

    it('reset: the incoming look applies whole, merchant edits included', () => {
      const doc = applyTemplateFamily(onAtelier(), 'qamar', lookbookLike, {
        from: getLook('qamar.atelier'),
        design: 'reset',
      });
      expect(byType(doc, 'hero').settings.presentation).toBe(defaultsOf('hero').presentation);
      expect(byType(doc, 'featured-collection').settings.mobileColumns).toBe(
        defaultsOf('featured-collection').mobileColumns
      );
      expect(byType(doc, 'featured-collection').settings.columns).toBe(3);
    });

    it('keep: a section the store lacks still takes the incoming preset and design', () => {
      const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'), {
        from: lookbookLike,
        design: 'keep',
      });
      expect(byType(doc, 'featured-collection').settings).toMatchObject({
        productSource: 'newest',
        limit: 8,
        columns: 4,
        mobileColumns: 2,
      });
    });
  });

  it('Atelier → Vitrine keeps content: slides, copy, images and carousel choices (C9)', () => {
    const onAtelier = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
    // The merchant points the carousel at their own category.
    const edited: PageDefinition = {
      ...onAtelier,
      sections: onAtelier.sections.map(s =>
        s.type === 'product-carousel'
          ? {
              ...s,
              settings: { ...s.settings, productSource: 'category', categorySlug: 'dresses' },
            }
          : s
      ),
    };
    for (const design of ['keep', 'reset'] as const) {
      const doc = applyTemplateFamily(edited, 'qamar', getLook('qamar.vitrine'), {
        from: getLook('qamar.atelier'),
        design,
      });
      const before = new Map(edited.sections.map(s => [s.id, s]));
      let compared = 0;
      for (const s of doc.sections) {
        const prev = before.get(s.id);
        if (!prev) continue;
        expect(content(s), `${design}:${s.id}`).toEqual(content(prev));
        compared++;
      }
      expect(compared, design).toBeGreaterThan(0);
      expect(byType(doc, 'hero').blocks?.[0]?.settings.headlineAr).toBe('مرحبا');
      const carousel = doc.sections.find(s => s.type === 'product-carousel');
      if (carousel)
        expect(carousel.settings).toMatchObject({
          productSource: 'category',
          categorySlug: 'dresses',
        });
      const story = doc.sections.find(s => s.id === 'story');
      if (story)
        expect(story.settings).toMatchObject({ headingAr: 'حكايتي', image: 'https://x/b.webp' });
    }
  });
  describe('layout-built pages: the skin baseline is the default (fix round 1)', () => {
    const framedTwo: Mix = {
      sections: [
        { type: 'hero', design: { presentation: 'framed' } },
        { type: 'category-grid', design: { desktopColumns: 2 } },
      ],
    };
    const noDesign: Mix = { sections: [{ type: 'hero' }, { type: 'category-grid' }] };
    const layoutPage = (skin: 'minimal' | 'qamar') =>
      layoutToDefinition(resolveLayoutSettings({}, skin, null));

    it('the probe: a layout-built page holds skin values that differ from preset 0', () => {
      const page = layoutPage('minimal');
      expect(byType(page, 'hero').settings.presentation).toBe('full-bleed');
      expect(byType(page, 'category-grid').settings.desktopColumns).toBe(4);
      expect(defaultsOf('category-grid').desktopColumns).not.toBe(4);
    });

    it("keep from a legacy store applies the incoming look's design (framed hero, 2 columns)", () => {
      for (const skin of ['minimal', 'qamar'] as const) {
        const doc = applyTemplateFamily(layoutPage(skin), 'qamar', framedTwo, {
          from: null,
          design: 'keep',
          fromSkin: { skin },
          toSkin: { skin: 'qamar' },
        });
        expect(byType(doc, 'hero').settings.presentation, skin).toBe('framed');
        expect(byType(doc, 'category-grid').settings.desktopColumns, skin).toBe(2);
      }
    });

    it('a key only the outgoing look set returns to the skin default, never to preset 0', () => {
      for (const design of ['keep', 'reset'] as const) {
        const onFramed = applyTemplateFamily(layoutPage('qamar'), 'qamar', framedTwo, {
          fromSkin: { skin: 'qamar' },
          toSkin: { skin: 'qamar' },
        });
        const doc = applyTemplateFamily(onFramed, 'qamar', noDesign, {
          from: framedTwo,
          design,
          fromSkin: { skin: 'qamar' },
          toSkin: { skin: 'qamar' },
        });
        const skinDefault = layoutPage('qamar');
        expect(byType(doc, 'hero').settings.presentation, design).toBe(
          byType(skinDefault, 'hero').settings.presentation
        );
        expect(byType(doc, 'category-grid').settings.desktopColumns, design).toBe(4);
      }
    });

    it('keep: a merchant column choice that differs from the skin default is kept', () => {
      const page = layoutPage('qamar');
      const edited = {
        ...page,
        sections: page.sections.map(s =>
          s.type === 'category-grid' ? { ...s, settings: { ...s.settings, desktopColumns: 5 } } : s
        ),
      };
      const doc = applyTemplateFamily(edited, 'qamar', framedTwo, {
        from: null,
        design: 'keep',
        fromSkin: { skin: 'qamar' },
        toSkin: { skin: 'qamar' },
      });
      expect(byType(doc, 'category-grid').settings.desktopColumns).toBe(5);
      expect(byType(doc, 'hero').settings.presentation).toBe('framed');
    });
  });

  it("a merchant's multi-slide slideshow survives a keep switch to Atelier", () => {
    const start = base();
    const hero = byType(start, 'hero');
    hero.settings = { ...hero.settings, mode: 'slider' };
    hero.blocks = [
      { id: 's1', type: 'slide', settings: { image: 'https://x/a.webp' } },
      { id: 's2', type: 'slide', settings: { image: 'https://x/c.webp' } },
      { id: 's3', type: 'slide', settings: { image: 'https://x/d.webp' } },
    ];
    for (const design of ['keep', 'reset'] as const) {
      const doc = applyTemplateFamily(start, 'qamar', getLook('qamar.atelier'), {
        from: null,
        design,
      });
      expect(byType(doc, 'hero').settings.mode, design).toBe('slider');
      expect(byType(doc, 'hero').blocks, design).toHaveLength(3);
    }
  });

  describe('lookTag: one section per look on one page (C10)', () => {
    const tagged = (): PageDefinition => {
      const page = base();
      const [hero, story] = page.sections;
      const h = (id: string, tag: string, image: string) => ({
        ...hero!,
        id,
        lookTag: tag,
        blocks: [{ id: `${id}-s`, type: 'slide', settings: { image } }],
      });
      return {
        ...page,
        sections: [
          h('hero-atelier', 'qamar.atelier', 'https://x/atelier.webp'),
          h('hero-lookbook', 'qamar.lookbook', 'https://x/lookbook.webp'),
          h('hero-vitrine', 'qamar.vitrine', 'https://x/vitrine.webp'),
          story!,
        ],
      };
    };

    it("under a look with a mix, only that look's tagged section renders; untagged always do", () => {
      const doc = documentForLook(tagged(), getLook('qamar.atelier'));
      expect(doc.sections.map(s => s.id)).toEqual(['hero-atelier', 'story']);
      const composed = applyTemplateFamily(tagged(), 'qamar', getLook('qamar.atelier'));
      expect(composed.sections.filter(s => s.type === 'hero').map(s => s.id)).toEqual([
        'hero-atelier',
      ]);
      expect(composed.sections.some(s => s.id === 'story')).toBe(true);
    });

    it('without a mix (or without a look) the document is unchanged', () => {
      const page = tagged();
      expect(documentForLook(page, getLook('souq.catalogue'))).toBe(page);
      expect(documentForLook(page, null)).toBe(page);
      const plain = base();
      expect(documentForLook(plain, getLook('qamar.atelier'))).toBe(plain);
    });

    it('validation: one hero per look is fine; an unknown look or two heroes for one look is not', () => {
      expect(validateDefinitionSync(tagged()).errors).toEqual([]);
      const unknown = tagged();
      unknown.sections[0] = { ...unknown.sections[0]!, lookTag: 'qamar.nope' };
      expect(validateDefinitionSync(unknown).errors.map(e => e.path)).toContain(
        '/sections/0/lookTag'
      );
      const twice = tagged();
      twice.sections[1] = { ...twice.sections[1]!, lookTag: 'qamar.atelier' };
      expect(validateDefinitionSync(twice).errors.map(e => e.code)).toContain('CARDINALITY');
      const mixed = tagged();
      mixed.sections.push({ ...mixed.sections[0]!, id: 'hero-plain', lookTag: undefined });
      delete mixed.sections[mixed.sections.length - 1]!.lookTag;
      expect(validateDefinitionSync(mixed).errors.map(e => e.code)).toContain('CARDINALITY');
    });
  });
});
