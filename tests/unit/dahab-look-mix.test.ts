/**
 * Phase B5 Task 3: the three Dahab section mixes and the look-switch behaviour over them. Mixes are
 * data over the shared registry (LOOKS-1): the checks are on the data, the switch machinery
 * (applyTemplateFamily), the validator and the TPL-1 guarantees (content kept, design not leaked,
 * a section the incoming look does not use is dropped from the DRAFT only). The legacy-`arch`
 * checks pin Ruling B5-3: a saved document keeps validating and renders.
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
  collectRefs,
  type PageDefinition,
} from '@ebda/shared';
import { isForbiddenOrange } from './helpers/orange-gate';

const worn = getLook('dahab.worn')!;
const workshop = getLook('dahab.workshop')!;
const giftbox = getLook('dahab.giftbox')!;
const atelier = getLook('qamar.atelier')!;
const DAHAB = [worn, workshop, giftbox];

const all = (doc: PageDefinition, type: string) => doc.sections.filter(s => s.type === type);
const one = (doc: PageDefinition, type: string) => all(doc, type)[0];
const types = (doc: PageDefinition) => doc.sections.map(s => s.type);

/** A merchant's own jeweller page: hero copy + photo, a collection of pieces, a tile list with an arch, a logo. */
function merchantBase(): PageDefinition {
  const h = sectionFromPreset('hero', 1, 'hero');
  h.blocks = [
    {
      id: 's1',
      type: 'slide',
      settings: {
        image: 'https://x/hero.webp',
        headlineAr: 'دهب يتلبس كل يوم',
        headline: 'Gold you live in',
      },
    },
  ];
  const pieces = sectionFromPreset('featured-collection', 0, 'featured-collection');
  pieces.settings = {
    ...pieces.settings,
    productSource: 'manual',
    manualProductIds: ['p-1', 'p-2', 'p-3'],
    headingAr: 'قطعنا',
  };
  const tiles = sectionFromPreset('collection-list', 0, 'collection-list');
  tiles.settings = { ...tiles.settings, tileShape: 'arch', headingAr: 'مجموعاتنا' };
  tiles.blocks = [
    {
      id: 'c1',
      type: 'collection',
      settings: { categorySlug: 'rings', image: 'https://x/c1.webp' },
    },
  ];
  const header = sectionFromPreset('header', 0, 'hdr');
  header.settings = { ...header.settings, logo: 'https://x/logo.webp' };
  return {
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey: 'home',
    sectionGroups: { header: [header], footer: [] },
    sections: [h, pieces, tiles],
    siteSettings: {},
  };
}

describe('the mixes, exactly as designed', () => {
  it('Worn: full-bleed hero, chips under it, the pieces, the engraving band, new in, reviews, story', () => {
    expect(worn.sections!.map(s => s.type)).toEqual([
      'hero',
      'category-grid',
      'featured-collection',
      'piece-window',
      'image-text',
      'product-carousel',
      'testimonials',
      'brand-story',
    ]);
    const [h, chips, pieces, signature, engraving] = worn.sections!;
    expect(signature.type).toBe('piece-window');
    // no textAnchor: Dahab's hero always sets its copy at the inline start (Ruling B5-35)
    expect(h.design).toEqual({ presentation: 'full-bleed' });
    expect(chips.design).toMatchObject({ layout: 'chips', layoutMobile: 'chips' });
    expect(pieces.design).toMatchObject({ columns: 4, mobileColumns: 2 });
    expect(engraving.preset).toMatchObject({ headingAr: 'اسمك محفور عليها', buttonTextAr: 'خصّص' });
  });
  it('Workshop: hero, the three-step journey, pieces on the LIGHT band, maker strip, rectangular tiles, trust, story', () => {
    expect(workshop.sections!.map(s => s.type)).toEqual([
      'hero',
      'steps',
      'featured-collection',
      'piece-window',
      'image-text',
      'collection-list',
      'trust-badges',
      'brand-story',
    ]);
    const [, steps, pieces, , , tiles] = workshop.sections!;
    expect(steps.blocks!.map(b => b.settings.titleAr)).toEqual(['رسم', 'صب', 'تلميع']);
    // quality bar section 9 rule 1: merchant photos are shot on white, so the grid sits on the inverse band
    expect(pieces.design).toMatchObject({ bgColor: 'token:inverse' });
    expect(tiles.design).toMatchObject({ tileShape: 'rectangle' });
  });
  it('Gift box: hero, the gift finder, the pieces, the packaging band, new in, trust, newsletter', () => {
    expect(giftbox.sections!.map(s => s.type)).toEqual([
      'hero',
      'gift-finder',
      'featured-collection',
      'piece-window',
      'image-text',
      'product-carousel',
      'trust-badges',
      'newsletter',
    ]);
    expect(giftbox.sections![4].preset).toMatchObject({ headingAr: 'بنغلّفها لحد باب الفرح' });
  });
  it('every look reaches the products in the first three sections', () => {
    for (const l of DAHAB) {
      const early = l.sections!.slice(0, 3).map(s => s.type);
      expect(
        early.some(t => t === 'featured-collection' || t === 'category-grid'),
        l.id
      ).toBe(true);
    }
  });
  it('Workshop reuses Jasmine steps: there is no second steps-style section type (precondition 3)', () => {
    expect(getSectionDefinition('process-steps')).toBeUndefined();
    expect(getSectionDefinition('steps')).toBeTruthy();
  });
});

describe('mix data is valid against the schema (the C1/X3 mismatch class)', () => {
  for (const look of DAHAB) {
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
      const doc = applyTemplateFamily(merchantBase(), 'dahab', look);
      const v = validateDefinitionSync(doc);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      expect(types(doc).slice(0, look.sections!.length)).toEqual(look.sections!.map(s => s.type));
    });
  }
  it('no Dahab mix names an orange-family token or literal colour', () => {
    for (const l of DAHAB) {
      const json = JSON.stringify(l.sections);
      expect(json, l.id).not.toMatch(/#[0-9a-fA-F]{3,8}|orange|amber|saffron/i);
    }
    expect(isForbiddenOrange('#E4E7EB')).toBe(false);
  });
});

describe('look switch keeps content and does not leak design (TPL-1)', () => {
  function onWorn(): PageDefinition {
    return applyTemplateFamily(merchantBase(), 'dahab', worn);
  }

  it('Workshop -> Gift box -> Worn -> Workshop keeps hero text, piece refs, the tile list and the logo', () => {
    // Workshop first: its mix names `collection-list`, so the merchant's tile list is in the mix;
    // on the looks that do not name it, an EDITED list stays on the draft (Ruling B1-45).
    const k1 = applyTemplateFamily(merchantBase(), 'dahab', workshop);
    const g = applyTemplateFamily(k1, 'dahab', giftbox, { from: workshop, design: 'keep' });
    const w = applyTemplateFamily(g, 'dahab', worn, { from: giftbox, design: 'keep' });
    const k2 = applyTemplateFamily(w, 'dahab', workshop, { from: worn, design: 'keep' });
    for (const doc of [k1, g, w, k2]) {
      expect(doc.sectionGroups.header[0].settings.logo).toBe('https://x/logo.webp');
      const pieces = all(doc, 'featured-collection')[0];
      expect(pieces.settings.manualProductIds).toEqual(['p-1', 'p-2', 'p-3']);
      expect(pieces.settings.headingAr).toBe('قطعنا');
      expect(one(doc, 'hero').blocks?.[0]?.settings.headlineAr).toBe('دهب يتلبس كل يوم');
      // the merchant's tile list (and its category photo) is theirs on every look
      expect(one(doc, 'collection-list').blocks?.[0]?.settings).toMatchObject({
        categorySlug: 'rings',
        image: 'https://x/c1.webp',
      });
    }
  });

  it('the design keys follow the incoming look, and none of the outgoing look leaks', () => {
    const w1 = onWorn();
    expect(one(w1, 'featured-collection').settings).not.toHaveProperty('bgColor', 'token:inverse');
    const k = applyTemplateFamily(w1, 'dahab', workshop, { from: worn, design: 'reset' });
    expect(one(k, 'featured-collection').settings).toMatchObject({ bgColor: 'token:inverse' });
    const w2 = applyTemplateFamily(k, 'dahab', worn, { from: workshop, design: 'reset' });
    // Workshop's inverse band must not follow the merchant back to Worn
    expect(one(w2, 'featured-collection').settings.bgColor).not.toBe('token:inverse');
  });

  it('a fresh Workshop gets jewellery steps, not Jasmine skincare steps (the mix owns its blocks)', () => {
    const k = applyTemplateFamily(merchantBase(), 'dahab', workshop);
    const steps = one(k, 'steps');
    expect(steps.blocks!.map(b => b.settings.titleAr)).toEqual(['رسم', 'صب', 'تلميع']);
    expect(JSON.stringify(steps.blocks)).not.toMatch(/Cleanse|تنظيف/);
  });

  it('merchant-edited steps survive a switch away and back; untouched seeded steps do not pile up', () => {
    const k = applyTemplateFamily(merchantBase(), 'dahab', workshop);
    const edited: PageDefinition = {
      ...k,
      sections: k.sections.map(s =>
        s.type === 'steps'
          ? {
              ...s,
              blocks: s.blocks!.map((b, i) =>
                i === 0 ? { ...b, settings: { ...b.settings, titleAr: 'تصميم' } } : b
              ),
            }
          : s
      ),
    };
    const away = applyTemplateFamily(edited, 'dahab', worn, { from: workshop, design: 'keep' });
    expect(one(away, 'steps')?.blocks?.[0]?.settings.titleAr).toBe('تصميم');
    // an UNTOUCHED seeded steps section leaves the draft on a switch away
    const awayClean = applyTemplateFamily(k, 'dahab', worn, { from: workshop, design: 'keep' });
    expect(all(awayClean, 'steps')).toHaveLength(0);
  });

  it('design keep preserves a field the merchant changed (C8)', () => {
    const w1 = onWorn();
    const edited: PageDefinition = {
      ...w1,
      sections: w1.sections.map(s =>
        s.type === 'featured-collection' ? { ...s, settings: { ...s.settings, columns: 3 } } : s
      ),
    };
    const k = applyTemplateFamily(edited, 'dahab', workshop, { from: worn, design: 'keep' });
    expect(one(k, 'featured-collection').settings.columns).toBe(3);
  });

  it('a section a merchant added by hand (one no Dahab mix names) survives every switch', () => {
    const w1 = onWorn();
    const own = sectionFromPreset('product-spotlight', 0, 'my-spotlight');
    own.settings = { ...own.settings, headingAr: 'اختيارنا' };
    const mine: PageDefinition = { ...w1, sections: [...w1.sections, own] };
    const k = applyTemplateFamily(mine, 'dahab', workshop, { from: worn, design: 'keep' });
    expect(k.sections.some(s => s.id === 'my-spotlight')).toBe(true);
    const g = applyTemplateFamily(k, 'dahab', giftbox, { from: workshop, design: 'keep' });
    expect(g.sections.some(s => s.id === 'my-spotlight')).toBe(true);
    expect(g.sections.find(s => s.id === 'my-spotlight')?.settings.headingAr).toBe('اختيارنا');
  });

  it('Dahab -> Qamar -> Dahab keeps the merchant content', () => {
    const w1 = onWorn();
    const away = applyTemplateFamily(w1, 'qamar', atelier, { from: worn, design: 'keep' });
    expect(away.sectionGroups.header[0].settings.logo).toBe('https://x/logo.webp');
    const back = applyTemplateFamily(away, 'dahab', worn, { from: atelier, design: 'keep' });
    expect(one(back, 'hero').blocks?.[0]?.settings.image).toBe('https://x/hero.webp');
    expect(one(back, 'featured-collection').settings.manualProductIds).toEqual([
      'p-1',
      'p-2',
      'p-3',
    ]);
  });

  it('re-applying a mix is idempotent', () => {
    for (const look of DAHAB) {
      const a = applyTemplateFamily(merchantBase(), 'dahab', look);
      const b = applyTemplateFamily(a, 'dahab', look, { from: look, design: 'keep' });
      expect(types(b), look.id).toEqual(types(a));
    }
  });
});

describe('Ruling B5-3: a stored tileShape "arch" still validates, and is never offered again', () => {
  it('a document with tileShape arch validates and publishes through the schema', () => {
    const v = validateDefinitionSync(merchantBase());
    expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
    expect(one(merchantBase(), 'collection-list').settings.tileShape).toBe('arch');
  });
  it('the editor options and the preset no longer offer or default to arch', () => {
    const def = getSectionDefinition('collection-list')!;
    const shape = def.settings.find(x => x.id === 'tileShape') as {
      options: Array<{ value: string }>;
    };
    expect(shape.options.map(o => o.value)).not.toContain('arch');
    expect(def.presets[0].settings.tileShape).toBe('rectangle');
  });
});

describe('gift-finder (Ruling B5-7)', () => {
  const gf = () => {
    const n = sectionFromPreset('gift-finder', 0, 'gf');
    n.blocks = [
      { id: 'o1', type: 'occasion', settings: { categorySlug: 'engagement', label: 'Engagement' } },
      { id: 'b1', type: 'budget', settings: { maxPrice: 2000, label: 'Up to 2,000' } },
    ];
    return n;
  };
  const doc = (): PageDefinition => ({ ...merchantBase(), sections: [gf()] });

  it('validates, is a template section, and at most one per page', () => {
    const v = validateDefinitionSync(doc());
    expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
    expect(getSectionDefinition('gift-finder')).toMatchObject({ group: 'template', maxCount: 1 });
  });
  it('its occasion categories are catalogue refs, checked against the store like collection tiles', () => {
    expect(collectRefs(doc()).categorySlugs).toEqual(['engagement']);
  });
  it('a budget cap must be a whole number of pounds within bounds; unknown keys are refused', () => {
    for (const bad of [0, -1, 1.5, 1_000_001]) {
      const d = doc();
      d.sections[0].blocks![1].settings.maxPrice = bad;
      expect(validateDefinitionSync(d).ok, String(bad)).toBe(false);
    }
    const d2 = doc();
    d2.sections[0].blocks![0].settings.href = 'javascript:alert(1)';
    expect(validateDefinitionSync(d2).ok).toBe(false);
  });
});
