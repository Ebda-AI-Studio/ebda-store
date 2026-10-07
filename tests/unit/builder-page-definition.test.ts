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
  type PageDefinition,
  type StoreLayoutSettings,
  type TemplateId,
} from '@force/shared';
import { LAYOUT_FIXTURES, TEMPLATES, loadLayoutFixture } from '../fixtures/builder/homepage-data';

const asStorefront = (raw: unknown, t: TemplateId): StoreLayoutSettings =>
  resolveLayoutSettings(JSON.parse(JSON.stringify(resolveLayoutSettings(raw, t))));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const baseDef = (): PageDefinition =>
  layoutToDefinition(asStorefront(loadLayoutFixture('pecannbee-flow'), 'modern'));

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
      ? { paddingTop: pick(['none', 'tight', 'normal', 'loose', 'xloose'] as const) }
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
        layoutToDefinition(asStorefront(loadLayoutFixture(fixture), 'modern'))
      );
      if (fixture === 'malformed') continue;
      expect(res.errors, fixture).toEqual([]);
    }
  });

  it('500 generated layouts round-trip both ways', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const L = asStorefront(generateLayout(seed), 'modern');
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
      'modern'
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
      'modern'
    );
    const D = layoutToDefinition(L);
    const extras = D.sections.filter(s => s.type === 'product-carousel');
    expect(extras.map(s => s.id)).toEqual(['extra-extra-feat', 'extra-extra-feat-2']);
    expect(extras.map(s => s.props.id)).toEqual(['Extra_Feat', 'extra feat']);
  });
});

describe('registry', () => {
  it('owns every legacy section key: the 8 body keys + announcement/header/footer + extraCarousels', () => {
    const keys = SECTION_REGISTRY.map(d => d.legacyKey).sort();
    expect(keys).toEqual(
      [...LEGACY_HOME_SECTION_KEYS, 'announcement', 'header', 'footer', 'extraCarousels'].sort()
    );
    // and every registry key is a real layout key (no drift from the interface)
    for (const k of keys) expect(LAYOUT_TOP_LEVEL_KEYS as readonly string[]).toContain(k);
  });

  it('chrome sections are placed top/bottom, cardinality one; product carousels many (max 8)', () => {
    const byType = Object.fromEntries(SECTION_REGISTRY.map(d => [d.type, d]));
    expect(byType.header.placement).toBe('chrome-top');
    expect(byType.footer.placement).toBe('chrome-bottom');
    expect(byType.header.cardinality).toBe('one');
    expect(byType['product-carousel']).toMatchObject({ cardinality: 'many', maxCount: 8 });
    for (const d of SECTION_REGISTRY) expect(d.slots).toEqual([]);
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
      many.sections.push({ id: `x-${i}`, type: 'brand-story', props: {} });
    expect(codes(many)).toContain('SCHEMA'); // envelope max(40)
  });

  it('rejects more than 8 product carousels', () => {
    const D = baseDef();
    for (let i = 0; i < 8; i++)
      D.sections.push({
        id: `extra-n${i}`,
        type: 'product-carousel',
        props: { id: `n${i}`, productSource: 'featured' },
      });
    expect(codes(D)).toContain('CARDINALITY');
  });

  it('rejects a document over 256 KB and a string over 2 KB', () => {
    const big = baseDef();
    const slide = { image: 'https://pub-test.r2.dev/x.jpg', alt: 'a'.repeat(2000) };
    const hero = big.sections.find(s => s.type === 'hero')!;
    hero.props.slides = Array.from({ length: 10 }, () => slide);
    for (let i = 0; i < 25; i++)
      big.sections.push({
        id: `bs-${i}`,
        type: 'brand-story',
        props: { typography: { body: { fontFamily: 'f'.repeat(100) } }, pad: 'x'.repeat(2000) },
      });
    expect(BUILDER_LIMITS.maxDocBytes).toBe(262144);
    const long = baseDef();
    long.sections.find(s => s.type === 'hero')!.props.slides = [
      { image: 'https://pub-test.r2.dev/x.jpg', alt: 'é'.repeat(1100) },
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
      (hero.props.slides as Array<Record<string, unknown>>)[0].ctaHref = href;
      expect(codes(D)).toContain('UNSAFE_URL');
    }
  );

  it('rejects data:/javascript: image URLs but accepts https and relative', () => {
    const D = baseDef();
    const slides = D.sections.find(s => s.type === 'hero')!.props.slides as Array<
      Record<string, unknown>
    >;
    slides[0].image = 'data:image/png;base64,AAAA';
    expect(codes(D)).toContain('UNSAFE_URL');
    slides[0].image = '/uploads/a.jpg';
    expect(codes(D)).not.toContain('UNSAFE_URL');
  });

  it('rejects physical left/right alignment (RTL must mirror)', () => {
    const D = baseDef();
    D.sections.find(s => s.type === 'category-grid')!.props.typography = {
      heading: { textAlign: 'left' },
    };
    expect(codes(D)).toContain('PHYSICAL_ALIGNMENT');
  });

  it('rejects responsive props a section does not support, accepts the declared ones', () => {
    const D = baseDef();
    D.sections.find(s => s.type === 'hero')!.responsive = { mobile: { props: { mode: 'single' } } };
    expect(codes(D)).toContain('RESPONSIVE_NOT_SUPPORTED');
    const ok = baseDef();
    ok.sections.find(s => s.type === 'category-grid')!.responsive = {
      tablet: { hidden: true },
      mobile: { props: { layout: 'grid' } },
    };
    expect(validateDefinitionSync(ok).errors).toEqual([]);
  });

  it('rejects children (no v1 section declares a slot)', () => {
    const D = baseDef();
    D.sections[0].children = [{ id: 'kid', type: 'brand-story', props: {} }];
    expect(codes(D)).toContain('SLOT_NOT_SUPPORTED');
  });

  it('runs the per-type props through the layout schema (bad enum -> PROPS_INVALID)', () => {
    const D = baseDef();
    D.sections.find(s => s.type === 'category-grid')!.props.desktopColumns = 9;
    expect(codes(D)).toContain('PROPS_INVALID');
  });

  it('unknown section type: an ERROR on write, SKIPPED (never thrown) on render', () => {
    const D = baseDef();
    D.sections.splice(1, 0, { id: 'future', type: 'image-text', props: {} });
    expect(codes(D)).toContain('UNKNOWN_TYPE');
    const { sections, skipped } = renderableSections(D);
    expect(skipped).toEqual([{ id: 'future', type: 'image-text' }]);
    expect(sections.some(s => s.id === 'future')).toBe(false);
    expect(() => definitionToLayout(D)).not.toThrow();
  });

  it('catalogue refs that are not in the store come back as warnings with a JSON pointer', async () => {
    const D = baseDef();
    D.sections.push({
      id: 'extra-m',
      type: 'product-carousel',
      props: { id: 'm', productSource: 'manual', manualProductIds: ['mine', 'theirs'] },
    });
    const res = await validateDefinition(D, {
      resolveRefs: async () => ({
        categorySlugs: new Set(['dates']),
        productIds: new Set(['mine']),
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.map(w => w.path)).toEqual([
      `/sections/${D.sections.length - 1}/props/manualProductIds/1`,
    ]);
  });
});
