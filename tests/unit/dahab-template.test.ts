/**
 * Dahab template (builder Phase 3 pilot): the data side.
 *  - the four new section types: registry entries, validators (section AND
 *    block settings), catalogue references and logical alignment;
 *  - the Dahab family, theme defaults (WCAG AA on every text pair the skin
 *    paints) and layout baseline (accepted by the layout PUT schema).
 */
import { describe, it, expect } from 'vitest';
import {
  SECTION_REGISTRY,
  TEMPLATE_FAMILIES,
  TEMPLATE_LAYOUT_BASELINES,
  TEMPLATE_THEMES,
  collectRefs,
  getSectionDefinition,
  getTemplateTheme,
  layoutToDefinition,
  resolveLayoutSettings,
  sectionFromPreset,
  storeLayoutSchema,
  validateDefinition,
  validateDefinitionSync,
  type PageDefinition,
} from '@force/shared';

const NEW_TYPES = ['featured-collection', 'collection-list', 'product-spotlight', 'trust-badges'];

const baseDoc = (): PageDefinition =>
  JSON.parse(JSON.stringify(layoutToDefinition(resolveLayoutSettings({}, 'dahab'))));

function withSection(type: string, settings: Record<string, unknown>, blocks?: unknown[]) {
  const doc = baseDoc();
  const node = sectionFromPreset(type, 0, `${type}-x`);
  node.settings = { ...node.settings, ...settings };
  if (blocks) node.blocks = blocks as never;
  doc.sections.push(node);
  return doc;
}

describe('new builder sections', () => {
  it('are registered as document-only template sections with bilingual labels and presets', () => {
    for (const type of NEW_TYPES) {
      const d = getSectionDefinition(type)!;
      expect(d, type).toBeTruthy();
      expect(d.legacyKey).toBeNull();
      expect(d.group).toBe('template');
      expect(d.labelAr.length).toBeGreaterThan(0);
      expect(d.presets.length).toBeGreaterThan(0);
      for (const b of d.blocks) expect(b.propsSchema, `${type}.${b.type}`).toBeTruthy();
    }
  });

  it('every preset (incl. the trust-badge blocks) validates', () => {
    for (const type of NEW_TYPES) {
      const doc = baseDoc();
      doc.sections.push(sectionFromPreset(type, 0, `${type}-p`));
      expect(validateDefinitionSync(doc).errors, type).toEqual([]);
    }
  });

  it('rejects unknown settings and out-of-range values on sections', () => {
    const bad = [
      withSection('featured-collection', { columns: 9 }),
      withSection('featured-collection', { price: 100 }), // price never lives in a document
      withSection('product-spotlight', { limit: 12 }),
      withSection('collection-list', { tileShape: 'hexagon' }),
      withSection('trust-badges', { layout: 'carousel' }),
    ];
    for (const doc of bad) expect(validateDefinitionSync(doc).ok).toBe(false);
  });

  it('validates BLOCK settings (a bad badge icon or an unknown key is an error)', () => {
    const icon = withSection('trust-badges', {}, [
      { id: 'b1', type: 'badge', settings: { icon: 'bitcoin', title: 'x' } },
    ]);
    const extra = withSection('collection-list', {}, [
      { id: 'c1', type: 'collection', settings: { categorySlug: 'rings', onclick: 'x' } },
    ]);
    expect(validateDefinitionSync(icon).errors.map(e => e.path)).toContain(
      `/sections/${icon.sections.length - 1}/blocks/0/settings/icon`
    );
    expect(validateDefinitionSync(extra).ok).toBe(false);
  });

  it('rejects unsafe links and images in the new sections', () => {
    expect(
      validateDefinitionSync(
        withSection('featured-collection', { buttonLink: 'javascript:alert(1)' })
      ).ok
    ).toBe(false);
    expect(
      validateDefinitionSync(
        withSection('collection-list', {}, [
          { id: 'c1', type: 'collection', settings: { image: 'data:image/png;base64,AAAA' } },
        ])
      ).ok
    ).toBe(false);
  });

  it('collects and checks catalogue refs from product sections and collection tiles', async () => {
    const doc = withSection('featured-collection', {
      productSource: 'category',
      categorySlug: 'rings',
    });
    doc.sections.push(
      {
        ...sectionFromPreset('product-spotlight', 0, 'spot'),
        settings: { productSource: 'manual', manualProductIds: ['p1', 'p-other-store'] },
      },
      {
        ...sectionFromPreset('collection-list', 0, 'tiles'),
        blocks: [{ id: 'c1', type: 'collection', settings: { categorySlug: 'gone' } }],
      }
    );
    const refs = collectRefs(doc);
    expect(refs.categorySlugs.sort()).toEqual(['gone', 'rings']);
    expect(refs.productIds.sort()).toEqual(['p-other-store', 'p1']);
    const res = await validateDefinition(doc, {
      resolveRefs: async () => ({ categorySlugs: new Set(['rings']), productIds: new Set(['p1']) }),
    });
    const paths = res.warnings.map(w => w.path);
    expect(paths.some(p => p.endsWith('/blocks/0/settings/categorySlug'))).toBe(true);
    expect(paths.some(p => p.endsWith('/settings/manualProductIds/1'))).toBe(true);
    expect(paths.some(p => p.endsWith('/settings/categorySlug') && !p.includes('blocks'))).toBe(
      false
    );
  });

  it('logical image side only (start / end)', () => {
    expect(
      validateDefinitionSync(withSection('product-spotlight', { imagePosition: 'left' })).ok
    ).toBe(false);
    expect(
      validateDefinitionSync(withSection('product-spotlight', { imagePosition: 'start' })).ok
    ).toBe(true);
  });
});

describe('Dahab family, theme and baseline', () => {
  it('the family composes only registered sections and names its skin', () => {
    const dahab = TEMPLATE_FAMILIES.find(f => f.id === 'dahab')!;
    expect(dahab.skin).toBe('dahab');
    expect(dahab.pendingSectionTypes).toEqual([]);
    for (const t of dahab.sectionTypes)
      expect(
        SECTION_REGISTRY.some(d => d.type === t),
        t
      ).toBe(true);
  });

  it('the layout baseline is a layout the API would accept', () => {
    const parsed = storeLayoutSchema.safeParse(TEMPLATE_LAYOUT_BASELINES.dahab);
    expect(
      parsed.success,
      JSON.stringify(parsed.success ? '' : parsed.error.issues.slice(0, 3))
    ).toBe(true);
  });

  // WCAG relative luminance from an "H S% L%" triplet.
  const lum = (triplet: string) => {
    const [h, s, l] = triplet.split(/\s+/).map(v => parseFloat(v));
    const S = s / 100;
    const L = l / 100;
    const a = S * Math.min(L, 1 - L);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  it('every text pair the skin paints meets WCAG AA (4.5:1)', () => {
    const t = getTemplateTheme('dahab');
    const pairs: Array<[string, string, string]> = [
      ['ivory on night', t.foregroundColor, t.backgroundColor],
      ['ivory on card', t.cardForeground, t.cardColor],
      ['muted on night', t.mutedForeground, t.backgroundColor],
      ['muted on card', t.mutedForeground, t.cardColor],
      ['muted on section-alt', t.mutedForeground, TEMPLATE_THEMES.dahab.bgSectionAlt!],
      ['gold text on night', t.primaryColor, t.backgroundColor],
      ['gold text on card', t.primaryColor, t.cardColor],
      ['night on gold button', t.primaryForeground, t.primaryColor],
      ['night on bright gold (hover)', t.accentForeground, t.accentColor],
    ];
    for (const [name, fg, bg] of pairs)
      expect(contrast(fg, bg), `${name}: ${contrast(fg, bg).toFixed(2)}`).toBeGreaterThanOrEqual(
        4.5
      );
  });

  it('Dahab turns the platform divider bands off (its headings carry the hairline)', () => {
    expect(getTemplateTheme('dahab').dividers?.enabled).toBe(false);
  });
});
