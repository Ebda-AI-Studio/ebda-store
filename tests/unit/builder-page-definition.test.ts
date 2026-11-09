/**
 * PageDefinition v1: schema limits, registry validation and the two-way
 * layout adapter (visual builder Phase 1).
 *
 * Round trips run over the golden layouts (x 5 template baselines) and a
 * seeded generated corpus, in both directions:
 *   definitionToLayout(layoutToDefinition(L)) == L
 *   layoutToDefinition(definitionToLayout(D)) == D
 */
import { describe, it, expect } from 'vitest';
import {
  resolveLayoutSettings,
  layoutToDefinition,
  definitionToLayout,
  validateDefinitionSync,
  validateDefinition,
  renderableSections,
  SECTION_REGISTRY,
  LEGACY_HOME_SECTION_KEYS,
  LAYOUT_TOP_LEVEL_KEYS,
  BUILDER_LIMITS,
  HERO_SLIDE_BLOCK,
  sectionFromPreset,
  THEME_SETTINGS_SCHEMA,
  TEMPLATE_FAMILIES,
  heroSlideSchema,
  type PageDefinition,
  type StoreLayoutSettings,
  defaultPageDocument,
  type SectionPageKind,
  type TemplateId,
} from '@ebda/shared';
import { LAYOUT_FIXTURES, TEMPLATES, loadLayoutFixture } from '../fixtures/builder/homepage-data';

const asStorefront = (raw: unknown, t: TemplateId): StoreLayoutSettings =>
  resolveLayoutSettings(JSON.parse(JSON.stringify(resolveLayoutSettings(raw, t))));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const baseDef = (): PageDefinition =>
  layoutToDefinition(asStorefront(loadLayoutFixture('default-flow'), 'qamar'));

// ── deterministic generator ────────────────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function generateLayout(seed: number): unknown {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const maybe = <T>(v: T): T | undefined => (r() < 0.5 ? v : undefined);
  const vis = () => ({
    ...(r() < 0.3 ? { hideOnMobile: r() < 0.5 } : {}),
    ...(r() < 0.3 ? { hideOnDesktop: r() < 0.5 } : {}),
    ...(r() < 0.15 ? { hideOnTablet: r() < 0.5 } : {}),
    ...(r() < 0.3
      ? { paddingTop: pick(['none', 'tight', 'normal', 'loose', 'xloose', 'xxloose'] as const) }
      : {}),
    ...(r() < 0.25
      ? {
          paddingTopMobile: pick(['none', 'tight', 'xloose'] as const),
          paddingBottomTablet: pick(['normal', 'loose'] as const),
        }
      : {}),
  });
  const order = [...LEGACY_HOME_SECTION_KEYS].sort(() => r() - 0.5).slice(0, Math.floor(r() * 9));
  const raw: Record<string, unknown> = {
    hero: {
      enabled: r() < 0.8,
      mode: pick(['single', 'slider'] as const),
      autoplayMs: 5000,
      slides: [],
      ...vis(),
    },
    categories: {
      enabled: r() < 0.8,
      layout: pick(['grid', 'horizontal'] as const),
      ...(r() < 0.4 ? { layoutMobile: pick(['grid', 'horizontal'] as const) } : {}),
      captionPosition: pick(['below', 'overlay'] as const),
      ...(r() < 0.4 ? { captionPositionMobile: pick(['below', 'overlay'] as const) } : {}),
      desktopColumns: pick([2, 3, 4] as const),
      mobileColumns: pick([1, 2, 3] as const),
      title: maybe('T'),
      ...vis(),
    },
    newArrivals: { enabled: r() < 0.5, limit: 8, bgColor: maybe('#112233'), ...vis() },
    bestSellers: { enabled: r() < 0.5, limit: 4, ...vis() },
    testimonials: { enabled: r() < 0.5, minRating: 4, verifiedOnly: r() < 0.5 },
  };
  for (const k of [
    'brandStory',
    'trustStrip',
    'blogCarousel',
    'announcement',
    'header',
    'footer',
  ]) {
    const roll = r();
    if (roll < 0.33) continue;
    raw[k] = roll < 0.5 ? {} : { ...(r() < 0.7 ? { enabled: r() < 0.5 } : {}), ...vis() };
  }
  if (r() < 0.7) raw.sectionOrder = order;
  if (r() < 0.6)
    raw.extraCarousels = Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({
      id: r() < 0.5 ? `extra-${seed}-${i}` : `ID_${i}`,
      productSource: pick(['newest', 'best_seller', 'featured', 'category', 'manual'] as const),
      ...(r() < 0.7 ? { enabled: r() < 0.7 } : {}),
      limit: 6,
      ...vis(),
    }));
  if (r() < 0.5) raw.bottomBar = { bgColor: '#000000' };
  if (r() < 0.5) raw.productCardDefaults = { showCardPrice: r() < 0.5 };
  return raw;
}

describe('adapter round trip', () => {
  for (const fixture of LAYOUT_FIXTURES) {
    for (const t of TEMPLATES) {
      it(`${fixture} / ${t}: layout -> definition -> layout is identical, and back`, () => {
        const L = asStorefront(loadLayoutFixture(fixture), t);
        const D = layoutToDefinition(L);
        expect(definitionToLayout(D)).toEqual(L);
        expect(layoutToDefinition(definitionToLayout(D))).toEqual(D);
        // every adapter output survives JSON (it is stored as jsonb)
        expect(definitionToLayout(clone(D))).toEqual(L);
      });
    }
  }

  it('golden layouts produce valid documents (malformed: only its own layout defects)', () => {
    for (const fixture of LAYOUT_FIXTURES) {
      const res = validateDefinitionSync(
        layoutToDefinition(asStorefront(loadLayoutFixture(fixture), 'qamar'))
      );
      if (fixture === 'malformed') continue;
      expect(res.errors, fixture).toEqual([]);
    }
  });

  it('500 generated layouts round-trip both ways', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const L = asStorefront(generateLayout(seed), 'qamar');
      const D = layoutToDefinition(L);
      // hideOnTablet equal to hideOnDesktop is the legacy two-way mode either way
      const normalise = (x: StoreLayoutSettings) =>
        JSON.parse(
          JSON.stringify(x, (_k, v) =>
            v &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            v.hideOnTablet !== undefined &&
            v.hideOnTablet === (v.hideOnDesktop ?? undefined)
              ? (({ hideOnTablet: _h, ...rest }) => rest)(v)
              : v
          )
        );
      expect(normalise(definitionToLayout(D)), `seed ${seed}`).toEqual(normalise(L));
      expect(layoutToDefinition(definitionToLayout(D)), `seed ${seed}`).toEqual(D);
    }
  });

  it('maps visibility onto three viewports and back (desktop/tablet/mobile)', () => {
    const L = asStorefront(
      {
        newArrivals: {
          enabled: true,
          limit: 4,
          hideOnMobile: true,
          hideOnDesktop: true,
          hideOnTablet: false,
        },
        bestSellers: { enabled: false, limit: 4, hideOnDesktop: true },
      },
      'qamar'
    );
    const D = layoutToDefinition(L);
    const na = D.sections.find(s => s.id === 'new-arrivals')!;
    expect(na.responsive).toEqual({
      mobile: { hidden: true },
      desktop: { hidden: true },
      tablet: { hidden: false },
    });
    const bs = D.sections.find(s => s.id === 'best-sellers')!;
    expect(bs.hidden).toBe(true);
    expect(bs.responsive).toEqual({ desktop: { hidden: true }, tablet: { hidden: true } });
    expect(definitionToLayout(D)).toEqual(L);
  });

  it('a document edit that hides a section on tablet only projects to hideOnTablet', () => {
    const D = baseDef();
    const hero = D.sections.find(s => s.id === 'hero')!;
    hero.responsive = { tablet: { hidden: true } };
    expect(definitionToLayout(D).hero).toMatchObject({ hideOnTablet: true });
    expect(definitionToLayout(D).hero.hideOnDesktop).toBeUndefined();
  });

  it('section order: body order drives sectionOrder; extras keep their own order', () => {
    const D = baseDef();
    const ids = D.sections.map(s => s.id);
    expect(ids.slice(0, 8)).toEqual([
      'hero',
      'best-sellers',
      'categories',
      'new-arrivals',
      'trust-strip',
      'brand-story',
      'testimonials',
      'blog-carousel',
    ]);
    // move testimonials to the top
    const i = D.sections.findIndex(s => s.id === 'testimonials');
    D.sections.unshift(D.sections.splice(i, 1)[0]);
    expect(definitionToLayout(D).sectionOrder?.[0]).toBe('testimonials');
  });

  it('a removed required section projects as DISABLED, never back to the enabled default', () => {
    const D = baseDef();
    D.sections = D.sections.filter(s => s.type !== 'hero');
    expect(definitionToLayout(D).hero.enabled).toBe(false);
  });

  it('extra carousel ids become schema-valid, unique section ids; the original id is kept', () => {
    const L = asStorefront(
      {
        extraCarousels: [
          { id: 'Extra_Feat', productSource: 'featured', limit: 2 },
          { id: 'extra feat', productSource: 'featured', limit: 2 },
        ],
      },
      'qamar'
    );
    const D = layoutToDefinition(L);
    const extras = D.sections.filter(s => s.type === 'product-carousel');
    expect(extras.map(s => s.id)).toEqual(['extra-extra-feat', 'extra-extra-feat-2']);
    expect(extras.map(s => s.settings.id)).toEqual(['Extra_Feat', 'extra feat']);
  });
});

describe('registry', () => {
  it('owns every legacy section key: the 8 body keys + announcement/header/footer + extraCarousels', () => {
    // document-only types (Phase 2; Phase 3 Dahab pilot; B1 shop-the-look; B3 steps; B5 gift-finder) have no legacy key
    expect(SECTION_REGISTRY.filter(d => d.legacyKey === null).map(d => d.type)).toEqual([
      'image-text',
      'newsletter',
      'featured-collection',
      'collection-list',
      'product-spotlight',
      'shop-the-look',
      'steps',
      'maker-profile',
      'gift-finder',
      // T7 signature sections (one per template)
      'editorial-collage',
      'piece-window',
      'spec-sheet',
      'key-ingredients',
      'kitchen-days',
      'trust-badges',
      // page documents (VE-3 / VE-12)
      'product-main',
      'product-faq',
      'product-reviews',
      'product-bundles',
      'product-recommendations',
      'product-related',
      'collection-main',
      'cart-main',
      'cart-recommendations',
    ]);
    const keys = SECTION_REGISTRY.flatMap(d => (d.legacyKey === null ? [] : [d.legacyKey])).sort();
    expect(keys).toEqual(
      [...LEGACY_HOME_SECTION_KEYS, 'announcement', 'header', 'footer', 'extraCarousels'].sort()
    );
    // and every registry key is a real layout key (no drift from the interface)
    for (const k of keys) expect(LAYOUT_TOP_LEVEL_KEYS as readonly string[]).toContain(k);
  });

  it('header/footer are section groups, cardinality one; product carousels many (max 8)', () => {
    const byType = Object.fromEntries(SECTION_REGISTRY.map(d => [d.type, d]));
    expect(byType.header.group).toBe('header');
    expect(byType.announcement.group).toBe('header');
    expect(byType.footer.group).toBe('footer');
    expect(byType.header.cardinality).toBe('one');
    expect(byType['product-carousel']).toMatchObject({ cardinality: 'many', maxCount: 8 });
    expect(byType.hero.blocks.map(b => b.type)).toEqual(['slide']);
  });
});

describe('settings schemas (drive the Phase 2 auto-generated panel)', () => {
  const VISIBILITY_AND_STRUCTURE = new Set([
    'enabled', // -> hidden
    'hideOnMobile', // -> responsive.mobile.hidden
    'hideOnDesktop', // -> responsive.desktop/tablet.hidden
    'hideOnTablet', // -> responsive.tablet.hidden
    'layoutMobile', // -> responsive.mobile.settings.layout
    'captionPositionMobile', // -> responsive.mobile.settings.captionPosition
    'paddingTopTablet', // -> responsive.tablet.settings.paddingTop (Ruling SP-1)
    'paddingTopMobile',
    'paddingBottomTablet',
    'paddingBottomMobile',
    'slides', // -> blocks
    'items', // trust strip items -> blocks
    'id', // product carousel's internal id (kept in settings, not editable)
  ]);
  const shapeKeys = (schema: unknown): string[] =>
    Object.keys((schema as { shape: Record<string, unknown> }).shape);
  const settingIds = (defs: ReadonlyArray<{ id: string; localized?: boolean }>) =>
    new Set(defs.flatMap(d => (d.localized ? [d.id, `${d.id}Ar`] : [d.id])));

  it('every field the API stores for a section has a settings descriptor, and no descriptor is phantom', () => {
    for (const d of SECTION_REGISTRY) {
      const stored = shapeKeys(d.propsSchema).filter(k => !VISIBILITY_AND_STRUCTURE.has(k));
      const declared = settingIds(d.settings);
      // Ruling EP-5: a key no skin reads loses its control but stays accepted by the save schema.
      const retired = new Set(d.retired);
      expect(
        stored.filter(k => !declared.has(k) && !retired.has(k)),
        `${d.type}: stored but no descriptor`
      ).toEqual([]);
      expect(
        [...retired].filter(k => declared.has(k) || !stored.includes(k)),
        `${d.type}: a retired key is still declared, or is not stored at all`
      ).toEqual([]);
      expect(
        [...declared].filter(k => !stored.includes(k)),
        `${d.type}: descriptor for nothing`
      ).toEqual([]);
    }
  });

  it('hero slide block descriptors cover every slide field', () => {
    const stored = shapeKeys(heroSlideSchema);
    const declared = settingIds(HERO_SLIDE_BLOCK.settings);
    expect(stored.filter(k => !declared.has(k))).toEqual([]);
    expect([...declared].filter(k => !stored.includes(k))).toEqual([]);
  });

  it('select options and responsive settings are consistent with the registry', () => {
    for (const d of SECTION_REGISTRY) {
      for (const st of d.settings) {
        if (st.type === 'select')
          expect(st.options?.length, `${d.type}.${st.id}`).toBeGreaterThan(1);
        for (const v of st.responsive ?? [])
          expect(d.responsive.settings[v] ?? [], `${d.type}.${st.id}`).toContain(st.id);
        expect(st.labelAr.length, `${d.type}.${st.id} needs an Arabic label`).toBeGreaterThan(0);
      }
    }
  });

  it('every preset inserts a valid section (add-section picker)', () => {
    for (const d of SECTION_REGISTRY) {
      d.presets.forEach((p, i) => {
        // a page-kind section is tested on its own page's document, the rest on the home document
        const kind = d.pages.find(k => k !== 'home');
        const doc =
          d.pages.includes('home') || !kind
            ? baseDef()
            : defaultPageDocument(kind as SectionPageKind);
        const node = sectionFromPreset(d.type, i, `preset-${d.type}`);
        expect(node.hidden).toBe(false);
        const list = d.group === 'template' ? doc.sections : doc.sectionGroups[d.group];
        // replace an existing singleton so cardinality is not what is tested here
        const at = list.findIndex(n => n.type === d.type);
        if (at >= 0 && d.cardinality === 'one') list.splice(at, 1, node);
        else list.push(node);
        expect(validateDefinitionSync(doc).errors, `${d.type} / ${p.nameEn}`).toEqual([]);
      });
    }
  });

  it('global theme settings are typed against StoreTheme and bilingual', () => {
    const ids = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings.map(st => st.id));
    expect(new Set(ids).size).toBe(ids.length);
    // the header first, like the header on the storefront (Ruling EP-4)
    expect(THEME_SETTINGS_SCHEMA.map(g => g.id)).toEqual([
      'header',
      'colors',
      'typography',
      'buttons',
      'cards',
      'spacing',
    ]);
    for (const g of THEME_SETTINGS_SCHEMA)
      for (const st of g.settings) expect(st.labelAr).not.toBe('');
  });
});

describe('validation', () => {
  const codes = (d: unknown) => validateDefinitionSync(d).errors.map(e => e.code);

  it('accepts the adapter output', () => {
    expect(validateDefinitionSync(baseDef()).ok).toBe(true);
  });

  it('rejects a wrong schemaVersion and unknown top-level keys', () => {
    expect(codes({ ...baseDef(), schemaVersion: 2 })).toContain('SCHEMA');
    expect(codes({ ...baseDef(), extra: 1 })).toContain('SCHEMA');
  });

  it('rejects duplicate section ids', () => {
    const D = baseDef();
    D.sections[1].id = D.sections[0].id;
    expect(codes(D)).toContain('DUPLICATE_ID');
  });

  it('rejects invalid section ids', () => {
    const D = baseDef();
    D.sections[0].id = 'Hero One';
    expect(codes(D)).toContain('SCHEMA');
  });

  it('rejects more than 40 sections, and more than one hero (cardinality)', () => {
    const D = baseDef();
    const hero = D.sections.find(s => s.type === 'hero')!;
    D.sections.push({ ...clone(hero), id: 'hero-2' });
    expect(codes(D)).toContain('CARDINALITY');
    const many = baseDef();
    for (let i = 0; i < 41; i++)
      many.sections.push({ id: `x-${i}`, type: 'brand-story', settings: {} });
    expect(codes(many)).toContain('SCHEMA'); // envelope max(40)
  });

  it('rejects more than 8 product carousels', () => {
    const D = baseDef();
    for (let i = 0; i < 8; i++)
      D.sections.push({
        id: `extra-n${i}`,
        type: 'product-carousel',
        settings: { id: `n${i}`, productSource: 'featured' },
      });
    expect(codes(D)).toContain('CARDINALITY');
  });

  it('rejects a document over 256 KB and a string over 2 KB', () => {
    const big = baseDef();
    for (let i = 0; i < 25; i++)
      big.sections.push({
        id: `bs-${i}`,
        type: 'brand-story',
        settings: { typography: { body: { fontFamily: 'f'.repeat(100) } }, pad: 'x'.repeat(2000) },
      });
    expect(BUILDER_LIMITS.maxDocBytes).toBe(262144);
    const long = baseDef();
    long.sections.find(s => s.type === 'hero')!.blocks = [
      {
        id: 'slide-1',
        type: 'slide',
        settings: { image: 'https://pub-test.r2.dev/x.jpg', alt: 'é'.repeat(1100) },
      },
    ];
    expect(codes(long)).toContain('STRING_TOO_LONG');
    const huge = baseDef();
    huge.siteSettings = {
      ...huge.siteSettings,
      productCardDefaults: { ctaLabelTextEn: 'z'.repeat(300 * 1024) },
    };
    expect(codes(huge)).toContain('DOC_TOO_LARGE');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', ' JAVASCRIPT:alert(1)', 'vbscript:x'])(
    'rejects unsafe link scheme %s',
    href => {
      const D = baseDef();
      const hero = D.sections.find(s => s.type === 'hero')!;
      hero.blocks![0].settings.ctaHref = href;
      expect(codes(D)).toContain('UNSAFE_URL');
    }
  );

  it('rejects data:/javascript: image URLs but accepts https and relative', () => {
    const D = baseDef();
    const slides = D.sections.find(s => s.type === 'hero')!.blocks!.map(b => b.settings);
    slides[0].image = 'data:image/png;base64,AAAA';
    expect(codes(D)).toContain('UNSAFE_URL');
    slides[0].image = '/uploads/a.jpg';
    expect(codes(D)).not.toContain('UNSAFE_URL');
  });

  it('rejects physical left/right alignment (RTL must mirror)', () => {
    const D = baseDef();
    D.sections.find(s => s.type === 'category-grid')!.settings.typography = {
      heading: { textAlign: 'left' },
    };
    expect(codes(D)).toContain('PHYSICAL_ALIGNMENT');
  });

  it('rejects responsive props a section does not support, accepts the declared ones', () => {
    const D = baseDef();
    D.sections.find(s => s.type === 'hero')!.responsive = {
      mobile: { settings: { mode: 'single' } },
    };
    expect(codes(D)).toContain('RESPONSIVE_NOT_SUPPORTED');
    const ok = baseDef();
    ok.sections.find(s => s.type === 'category-grid')!.responsive = {
      tablet: { hidden: true },
      mobile: { settings: { layout: 'grid' } },
    };
    expect(validateDefinitionSync(ok).errors).toEqual([]);
  });

  it('blocks: hero slides are ordered slide blocks; foreign block types, duplicates and >10 are rejected', () => {
    const D = baseDef();
    const hero = D.sections.find(s => s.type === 'hero')!;
    expect(hero.blocks!.map(b => [b.id, b.type])).toEqual([
      ['slide-1', 'slide'],
      ['slide-2', 'slide'],
    ]);
    expect(hero.settings.slides).toBeUndefined();
    // reorder blocks -> slides reorder in the projection
    hero.blocks!.reverse();
    expect(definitionToLayout(D).hero.slides[0].image).toBe('https://pub-test.r2.dev/hero/b.jpg');
    // a hidden block is not rendered
    hero.blocks![0].hidden = true;
    expect(definitionToLayout(D).hero.slides).toHaveLength(1);
    const bad = baseDef();
    bad.sections.find(s => s.type === 'category-grid')!.blocks = [
      { id: 'b', type: 'slide', settings: {} },
    ];
    expect(codes(bad)).toContain('BLOCK_NOT_SUPPORTED');
    const dup = baseDef();
    const h = dup.sections.find(s => s.type === 'hero')!;
    h.blocks![1].id = h.blocks![0].id;
    expect(codes(dup)).toContain('DUPLICATE_ID');
    const many = baseDef();
    many.sections.find(s => s.type === 'hero')!.blocks = Array.from({ length: 11 }, (_, i) => ({
      id: `slide-${i + 1}`,
      type: 'slide',
      settings: { image: 'https://pub-test.r2.dev/x.jpg' },
    }));
    expect(codes(many)).toContain('CARDINALITY');
  });

  it('section groups: header/footer types live in their groups only', () => {
    const D = layoutToDefinition(asStorefront(loadLayoutFixture('fully-customised'), 'qamar'));
    expect(D.sectionGroups.header.map(s => s.type)).toEqual(['announcement', 'header']);
    expect(D.sectionGroups.footer.map(s => s.type)).toEqual(['footer']);
    expect(validateDefinitionSync(D).errors).toEqual([]);
    const moved = clone(D);
    moved.sections.push(moved.sectionGroups.footer.pop()!);
    expect(codes(moved)).toContain('GROUP_MISMATCH');
    const wrong = clone(D);
    wrong.sectionGroups.header.push(wrong.sections.shift()!);
    expect(codes(wrong)).toContain('GROUP_MISMATCH');
  });

  it('runs the per-type props through the layout schema (bad enum -> PROPS_INVALID)', () => {
    const D = baseDef();
    D.sections.find(s => s.type === 'category-grid')!.settings.desktopColumns = 9;
    expect(codes(D)).toContain('PROPS_INVALID');
  });

  it('unknown section type: an ERROR on write, SKIPPED (never thrown) on render', () => {
    const D = baseDef();
    D.sections.splice(1, 0, { id: 'future', type: 'video-hero', settings: {} });
    expect(codes(D)).toContain('UNKNOWN_TYPE');
    const { sections, skipped } = renderableSections(D);
    expect(skipped).toEqual([{ id: 'future', type: 'video-hero' }]);
    expect(sections.some(s => s.id === 'future')).toBe(false);
    expect(() => definitionToLayout(D)).not.toThrow();
  });

  it('catalogue refs that are not in the store come back as warnings with a JSON pointer', async () => {
    const D = baseDef();
    D.sections.push({
      id: 'extra-m',
      type: 'product-carousel',
      settings: { id: 'm', productSource: 'manual', manualProductIds: ['mine', 'theirs'] },
    });
    const res = await validateDefinition(D, {
      resolveRefs: async () => ({
        categorySlugs: new Set(['dates']),
        productIds: new Set(['mine']),
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.map(w => w.path)).toEqual([
      `/sections/${D.sections.length - 1}/settings/manualProductIds/1`,
    ]);
  });
});

describe('template families (final names, Ahmad 2026-10-07)', () => {
  it('declares Souq, Dahab, Qamar, Lamma, Jasmine with Arabic labels', () => {
    expect(TEMPLATE_FAMILIES.map(f => [f.id, f.labelEn, f.labelAr])).toEqual([
      ['souq', 'Souq', 'سوق'],
      ['dahab', 'Dahab', 'دهب'],
      ['qamar', 'Qamar', 'قمر'],
      ['lamma', 'Lamma', 'لمّة'],
      ['jasmine', 'Jasmine', 'ياسمين'],
    ]);
  });

  it('composes only registered sections; pending ones are not registered yet', () => {
    const types = new Set(SECTION_REGISTRY.map(d => d.type));
    for (const f of TEMPLATE_FAMILIES) {
      expect(
        f.sectionTypes.filter(t => !types.has(t)),
        f.id
      ).toEqual([]);
      expect(
        f.pendingSectionTypes.filter(t => types.has(t)),
        f.id
      ).toEqual([]);
    }
  });
});
