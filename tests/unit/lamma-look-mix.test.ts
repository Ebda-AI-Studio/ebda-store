/**
 * Phase B4 Task 3: the three Lamma section mixes and the look-switch behaviour over them. Mixes
 * are data over the shared registry (LOOKS-1): the checks are on the data, the switch machinery
 * (applyTemplateFamily), the validator and the TPL-1 guarantees (content kept, design not leaked,
 * a section the incoming look does not use is dropped from the DRAFT only).
 */
import { describe, it, expect } from 'vitest';
import {
  applyTemplateFamily,
  getLook,
  LOOK_DESIGN_KEYS,
  getSectionDefinition,
  sectionFromPreset,
  PAGE_DEFINITION_SCHEMA_VERSION,
  validateDefinitionSync,
  type PageDefinition,
} from '@ebda/shared';
import { isOrangeFamily } from './helpers/orange-gate';

const table = getLook('lamma.table')!;
const notebook = getLook('lamma.notebook')!;
const market = getLook('lamma.market')!;
const atelier = getLook('qamar.atelier')!;
const catalogue = getLook('souq.catalogue')!;
const LAMMA = [table, notebook, market];

const all = (doc: PageDefinition, type: string) => doc.sections.filter(s => s.type === type);
const one = (doc: PageDefinition, type: string) => all(doc, type)[0];
const types = (doc: PageDefinition) => doc.sections.map(s => s.type);

/** A merchant's own page: hero copy + slide photo, a maker profile, a collection of dishes, a logo. */
function merchantBase(): PageDefinition {
  const h = sectionFromPreset('hero', 1, 'hero');
  h.blocks = [
    {
      id: 's1',
      type: 'slide',
      settings: {
        image: 'https://x/hero.webp',
        headlineAr: 'أكل بيتي بإيد أمي',
        headline: "Mum's home cooking",
      },
    },
  ];
  const maker = sectionFromPreset('maker-profile', 0, 'maker-profile');
  maker.settings = {
    ...maker.settings,
    image: 'https://x/maker.webp',
    nameAr: 'أم سلمى',
    name: 'Om Salma',
    hygieneAr: 'مطبخ مرخّص',
  };
  const menu = sectionFromPreset('featured-collection', 0, 'featured-collection');
  menu.settings = {
    ...menu.settings,
    productSource: 'manual',
    manualProductIds: ['p-1', 'p-2', 'p-3'],
    headingAr: 'أطباقنا',
  };
  const header = sectionFromPreset('header', 0, 'hdr');
  header.settings = { ...header.settings, logo: 'https://x/logo.webp' };
  return {
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey: 'home',
    sectionGroups: { header: [header], footer: [] },
    sections: [h, maker, menu],
    siteSettings: {},
  };
}

describe('the mixes, exactly as designed', () => {
  it('Family table: full-bleed hero, order again, the menu with category tabs, the cook as a strip, trust', () => {
    expect(table.sections!.map(s => s.type)).toEqual([
      'hero',
      'product-carousel',
      'featured-collection',
      'kitchen-days',
      'maker-profile',
      'trust-strip',
    ]);
    const [h, again, menu, , maker] = table.sections!;
    expect(again.preset).toMatchObject({ productSource: 'reorder', titleAr: 'اطلب تاني' });
    expect(h.design).toMatchObject({ presentation: 'full-bleed', textAnchor: 'bottom-start' });
    expect(menu.design).toMatchObject({ layout: 'menu', tabs: 'categories' });
    expect(menu.preset).toMatchObject({
      productSource: 'newest',
      limit: 24,
      headingAr: 'منيو النهاردة',
    });
    expect(maker.design).toMatchObject({ variant: 'strip' });
    expect(table.chrome).toMatchObject({
      header: { logoPlacement: 'start' },
      cartBar: 'total',
      cardStepper: 'inline',
    });
  });
  it('Kitchen notebook: the cook leads (no hero), order again, dishes on the LIGHT band, story, trust', () => {
    expect(notebook.sections!.map(s => s.type)).toEqual([
      'maker-profile',
      'product-carousel',
      'featured-collection',
      'kitchen-days',
      'brand-story',
      'trust-strip',
    ]);
    const [maker, again, grid] = notebook.sections!;
    expect(again.preset).toMatchObject({ productSource: 'reorder' });
    expect(maker.design).toMatchObject({ variant: 'lead' });
    // quality bar section 9 rule 1: merchant dish photos are shot on white, so the grid sits on the inverse band
    expect(grid.design).toMatchObject({ columns: 2, mobileColumns: 2, bgColor: 'token:inverse' });
    expect(notebook.chrome?.header.logoPlacement).toBe('centre');
    expect(notebook.sections!.map(s => s.type)).not.toContain('hero');
  });
  it('Fresh market: aisle tiles FIRST (three across on a phone), order again, deals, a dense grid, trust', () => {
    expect(market.sections!.map(s => s.type)).toEqual([
      'category-grid',
      'product-carousel',
      'product-carousel',
      'featured-collection',
      'kitchen-days',
      'trust-strip',
    ]);
    const [tiles, again, deals, grid] = market.sections!;
    expect(again.preset).toMatchObject({ productSource: 'reorder' });
    expect(tiles.design).toMatchObject({
      layout: 'tiles',
      layoutMobile: 'tiles',
      tint: 'aisles',
      mobileColumns: 3,
      captionPosition: 'below',
    });
    expect(deals.preset).toMatchObject({ productSource: 'on_sale', titleAr: 'عروض النهاردة' });
    expect(grid.design).toMatchObject({ columns: 4, mobileColumns: 2 });
    expect(market.chrome?.aisles).toHaveLength(4);
  });
  it('every look reaches the products in the first three sections', () => {
    for (const l of LAMMA) {
      const early = l.sections!.slice(0, 3).map(s => s.type);
      expect(
        early.some(t => t === 'featured-collection' || t === 'category-grid'),
        l.id
      ).toBe(true);
    }
  });
});

describe('mix data is valid against the schema (the C1/X3 mismatch class)', () => {
  for (const look of LAMMA) {
    it(`${look.id}: every design key is a LOOK_DESIGN_KEY, no mix sets hero mode, no category in a preset`, () => {
      for (const s of look.sections!) {
        expect(getSectionDefinition(s.type)?.group, s.type).toBe('template');
        for (const k of Object.keys(s.design ?? {}))
          expect(LOOK_DESIGN_KEYS, `${s.type}.${k}`).toContain(k);
        expect(s.design ?? {}).not.toHaveProperty('mode');
        expect(s.preset ?? {}).not.toHaveProperty('categorySlug');
      }
    });
    it(`${look.id}: every enum value a mix writes exists in the section's settings schema`, () => {
      for (const s of look.sections!) {
        const def = getSectionDefinition(s.type)!;
        for (const [k, v] of Object.entries(s.design ?? {})) {
          const setting = def.settings.find(x => x.id === k) as
            | { options?: Array<{ value: unknown }> }
            | undefined;
          if (setting?.options)
            expect(
              setting.options.map(o => o.value),
              `${s.type}.${k}=${String(v)}`
            ).toContain(v);
        }
      }
    });
    it(`${look.id}: no type is named more often than the registry allows`, () => {
      for (const t of new Set(look.sections!.map(s => s.type))) {
        const n = look.sections!.filter(s => s.type === t).length;
        expect(n, t).toBeLessThanOrEqual(getSectionDefinition(t)!.maxCount);
      }
    });
    it(`${look.id}: the composed draft validates (enum values, cardinality, tokens) in order`, () => {
      const doc = applyTemplateFamily(merchantBase(), 'lamma', look);
      const v = validateDefinitionSync(doc);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      expect(types(doc).slice(0, look.sections!.length)).toEqual(look.sections!.map(s => s.type));
    });
  }
  it('no Lamma mix names an orange-family token or literal colour; the aisles are clean', () => {
    for (const l of LAMMA)
      expect(JSON.stringify(l.sections), l.id).not.toMatch(
        /#[0-9a-fA-F]{3,8}|orange|amber|saffron/i
      );
    for (const hex of market.chrome!.aisles!) expect(isOrangeFamily(hex), hex).toBe(false);
  });
});

describe('look switch keeps content and does not leak design (TPL-1)', () => {
  /** Family table with the merchant's own content layered on. */
  function onTable(): PageDefinition {
    return applyTemplateFamily(merchantBase(), 'lamma', table);
  }

  it('Table -> Notebook -> Market -> Table keeps hero text, dish refs, the maker profile and the logo', () => {
    const t1 = onTable();
    const n = applyTemplateFamily(t1, 'lamma', notebook, { from: table, design: 'keep' });
    const m = applyTemplateFamily(n, 'lamma', market, { from: notebook, design: 'keep' });
    const t2 = applyTemplateFamily(m, 'lamma', table, { from: market, design: 'keep' });
    for (const doc of [t1, n, m, t2]) {
      const maker = one(doc, 'maker-profile');
      expect(maker, 'maker profile survives every switch').toBeTruthy();
      expect(maker.settings).toMatchObject({
        nameAr: 'أم سلمى',
        image: 'https://x/maker.webp',
        hygieneAr: 'مطبخ مرخّص',
      });
      expect(doc.sectionGroups.header[0].settings.logo).toBe('https://x/logo.webp');
      const dishes = all(doc, 'featured-collection')[0];
      expect(dishes.settings.manualProductIds).toEqual(['p-1', 'p-2', 'p-3']);
      expect(dishes.settings.headingAr).toBe('أطباقنا');
    }
    const heroBlock = (d: PageDefinition) => one(d, 'hero')?.blocks?.[0]?.settings.headlineAr;
    expect(heroBlock(t1)).toBe('أكل بيتي بإيد أمي');
    // Notebook has no hero in its mix: the edited hero stays after the mix (Ruling B1-45)
    expect(heroBlock(n)).toBe('أكل بيتي بإيد أمي');
    expect(heroBlock(t2)).toBe('أكل بيتي بإيد أمي');
  });

  it('the design keys follow the incoming look, and none of the outgoing look leaks', () => {
    const t1 = onTable();
    expect(one(t1, 'featured-collection').settings).toMatchObject({
      layout: 'menu',
      tabs: 'categories',
    });
    expect(one(t1, 'maker-profile').settings.variant).toBe('strip');
    const n = applyTemplateFamily(t1, 'lamma', notebook, { from: table, design: 'reset' });
    // the menu layout and tabs are Table's: Notebook's grid must not inherit them
    const grid = one(n, 'featured-collection');
    expect(grid.settings.layout).not.toBe('menu');
    expect(grid.settings.tabs).toBeUndefined();
    expect(grid.settings).toMatchObject({ columns: 2, bgColor: 'token:inverse' });
    expect(one(n, 'maker-profile').settings.variant).toBe('lead');
    const t2 = applyTemplateFamily(n, 'lamma', table, { from: notebook, design: 'reset' });
    expect(one(t2, 'featured-collection').settings.bgColor).not.toBe('token:inverse');
    expect(one(t2, 'maker-profile').settings.variant).toBe('strip');
  });

  it('design keep preserves a field the merchant changed (C8)', () => {
    const t1 = onTable();
    const edited: PageDefinition = {
      ...t1,
      sections: t1.sections.map(s =>
        s.type === 'maker-profile' ? { ...s, settings: { ...s.settings, variant: 'lead' } } : s
      ),
    };
    const n = applyTemplateFamily(edited, 'lamma', notebook, { from: table, design: 'keep' });
    expect(one(n, 'maker-profile').settings.variant).toBe('lead');
    const t2 = applyTemplateFamily(edited, 'lamma', table, { from: table, design: 'keep' });
    expect(one(t2, 'maker-profile').settings.variant).toBe('lead');
  });

  it('a section the incoming look drops leaves the DRAFT only and comes back on a switch back', () => {
    const t1 = onTable();
    const m = applyTemplateFamily(t1, 'lamma', market, { from: table, design: 'reset' });
    expect(types(m)).toContain('category-grid');
    const back = applyTemplateFamily(m, 'lamma', table, { from: market, design: 'reset' });
    expect(types(back).slice(0, table.sections!.length)).toEqual(table.sections!.map(s => s.type));
  });

  it('Lamma -> Qamar -> Lamma and Lamma -> Souq -> Lamma keep the merchant content', () => {
    for (const other of [atelier, catalogue]) {
      const family = other.template as 'qamar' | 'souq';
      const onLamma = onTable();
      const away = applyTemplateFamily(onLamma, family, other, { from: table, design: 'keep' });
      // the merchant-edited maker profile is not in the other mix but stays on the draft
      expect(one(away, 'maker-profile').settings.nameAr, other.id).toBe('أم سلمى');
      expect(away.sectionGroups.header[0].settings.logo).toBe('https://x/logo.webp');
      const back = applyTemplateFamily(away, 'lamma', table, { from: other, design: 'keep' });
      expect(one(back, 'maker-profile').settings.nameAr, other.id).toBe('أم سلمى');
      expect(one(back, 'hero').blocks?.[0]?.settings.image, other.id).toBe('https://x/hero.webp');
      expect(one(back, 'featured-collection').settings.manualProductIds, other.id).toEqual([
        'p-1',
        'p-2',
        'p-3',
      ]);
    }
  });

  it('re-applying a mix is idempotent', () => {
    for (const look of LAMMA) {
      const a = applyTemplateFamily(merchantBase(), 'lamma', look);
      const b = applyTemplateFamily(a, 'lamma', look, { from: look, design: 'keep' });
      expect(types(b), look.id).toEqual(types(a));
    }
  });
});
