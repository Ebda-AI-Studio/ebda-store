/**
 * Phase B3 Task 4: the three Jasmine section mixes and the look-switch behaviour over them. Mixes
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
  documentForLook,
  validateDefinitionSync,
  type PageDefinition,
  type SectionNode,
} from '@ebda/shared';

const apothecary = getLook('jasmine.apothecary')!;
const bloom = getLook('jasmine.bloom')!;
const clinic = getLook('jasmine.clinic')!;
const atelier = getLook('qamar.atelier')!;
const night = getLook('souq.night')!;

const defaultsOf = (type: string) => sectionFromPreset(type, 0, type).settings;
const all = (doc: PageDefinition, type: string) => doc.sections.filter(s => s.type === type);
const one = (doc: PageDefinition, type: string) => all(doc, type)[0];
const types = (doc: PageDefinition) => doc.sections.map(s => s.type);
const hero = (d: PageDefinition) => d.sections.find(s => s.type === 'hero');

/** A merchant's own page: hero copy + slide photo, an about block, a header with a logo. */
function merchantBase(): PageDefinition {
  const h = sectionFromPreset('hero', 1, 'hero');
  h.blocks = [
    {
      id: 's1',
      type: 'slide',
      settings: {
        image: 'https://x/hero.webp',
        headlineAr: 'بشرتك تستاهل',
        headline: 'Deserve it',
      },
    },
  ];
  const story = sectionFromPreset('image-text', 0, 'story');
  story.settings = { ...story.settings, headingAr: 'حكايتنا', image: 'https://x/story.webp' };
  const header = sectionFromPreset('header', 0, 'hdr');
  header.settings = { ...header.settings, logo: 'https://x/logo.webp' };
  return {
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey: 'home',
    sectionGroups: { header: [header], footer: [] },
    sections: [h, story],
    siteSettings: {},
  };
}

describe('the mixes, exactly as designed', () => {
  it('Apothecary: hero, skin-type chips under it, product rows on the LIGHT band, the routine steps, trust', () => {
    expect(apothecary.sections!.map(s => s.type)).toEqual([
      'hero',
      'category-grid',
      'featured-collection',
      'key-ingredients',
      'steps',
      'trust-strip',
    ]);
    // the listing pages keep the olive ground; photos sit on a paper matte (fix wave 1)
    expect(apothecary.chrome?.listing).toBe('ground');
    const [h, chips, rows, , ritual] = apothecary.sections!;
    expect(h.design).toMatchObject({ presentation: 'full-bleed' });
    expect(chips.design).toMatchObject({ source: 'tags', layout: 'chips', layoutMobile: 'chips' });
    expect(chips.preset).toMatchObject({ titleAr: 'حسب نوع بشرتك' });
    // quality bar section 9 rule 1: merchant photos are shot on white, so the rows sit on the inverse band
    expect(rows.design).toMatchObject({ bgColor: 'token:inverse', mobileColumns: 2 });
    expect(ritual.preset).toMatchObject({ headingAr: 'الطقس' });
  });
  it('Bloom: framed hero, "start here" rail, weekly routine, shade grid, customer strip, deals, trust', () => {
    expect(bloom.sections!.map(s => s.type)).toEqual([
      'hero',
      'category-grid',
      'product-carousel',
      'featured-collection',
      'key-ingredients',
      'testimonials',
      'product-carousel',
      'trust-strip',
    ]);
    const [h, rail, week, grid, , , deals] = bloom.sections!;
    // the photo FILLS the frame (cover) and the headline sits on the scrim, never on pale pink
    expect(h.design).toMatchObject({
      presentation: 'framed',
      frame: 'line',
      textAnchor: 'bottom-start',
    });
    expect(rail.design).toMatchObject({ layout: 'rail', layoutMobile: 'rail' });
    expect(rail.design).not.toHaveProperty('source');
    expect(rail.preset).toMatchObject({ titleAr: 'ابدأ من هنا' });
    expect(week.preset).toMatchObject({ productSource: 'manual', titleAr: 'روتين الأسبوع' });
    expect(grid.design).toMatchObject({ columns: 4, mobileColumns: 2 });
    expect(deals.preset).toMatchObject({ productSource: 'on_sale', titleAr: 'عروض' });
  });
  it('Clinic: concern chips FIRST (directly under the header), the featured active (a photo in the first screen), the routine, actives on the surface', () => {
    expect(clinic.sections!.map(s => s.type)).toEqual([
      'category-grid',
      'product-spotlight',
      'steps',
      'featured-collection',
      'key-ingredients',
      'trust-strip',
      'newsletter',
    ]);
    const [chips, stage, steps, grid] = clinic.sections!;
    expect(chips.design).toMatchObject({ source: 'tags', layout: 'chips' });
    expect(chips.preset).toMatchObject({ titleAr: 'اختار مشكلتك' });
    expect(steps.preset).toMatchObject({ headingAr: 'روتينك في 3 خطوات' });
    expect(stage.design).toMatchObject({ layout: 'stage' });
    expect(stage.preset).toMatchObject({
      limit: 1,
      heading: 'Active of the week',
      headingAr: 'مادة الأسبوع',
    });
    expect(grid.design).toMatchObject({ bgColor: 'token:card' });
  });
  it('the first screen shows a path to the products in every look (categories, chips or rail)', () => {
    for (const l of [apothecary, bloom, clinic]) {
      const early = l.sections!.slice(0, 2).map(s => s.type);
      expect(early, l.id).toContain('category-grid');
    }
  });
});

describe('mix data is valid against the schema (the C1/X3 mismatch class)', () => {
  for (const look of [apothecary, bloom, clinic]) {
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
      const doc = applyTemplateFamily(merchantBase(), 'jasmine', look);
      const v = validateDefinitionSync(doc);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      expect(types(doc).slice(0, look.sections!.length)).toEqual(look.sections!.map(s => s.type));
    });
  }
  it('no Jasmine mix names an orange-family token or literal colour', () => {
    for (const l of [apothecary, bloom, clinic])
      expect(JSON.stringify(l.sections), l.id).not.toMatch(
        /#[0-9a-fA-F]{3,8}|orange|amber|saffron/i
      );
  });
});

describe('re-applying a mix is idempotent (Bloom names product-carousel twice)', () => {
  it('Bloom twice keeps two carousels, each with its own preset', () => {
    const b1 = applyTemplateFamily(merchantBase(), 'jasmine', bloom);
    const b2 = applyTemplateFamily(b1, 'jasmine', bloom, { from: bloom, design: 'keep' });
    expect(all(b2, 'product-carousel')).toHaveLength(2);
    expect(types(b2)).toEqual(types(b1));
    const [a, b] = all(b2, 'product-carousel');
    expect(a.settings.productSource).toBe('manual');
    expect(b.settings.productSource).toBe('on_sale');
  });
});

describe('look switch keeps content and does not leak design (TPL-1)', () => {
  /** Apothecary with the merchant's own content layered on: refs, a category photo, steps. */
  function merchantApothecary(): PageDefinition {
    // (re-applied with `keep`: the merchant's own about block is an edited section, so it stays even
    // though no Jasmine mix names an image-text any more)
    let doc = applyTemplateFamily(merchantBase(), 'jasmine', apothecary, {
      from: apothecary,
      design: 'keep',
    });
    // The routine steps the Apothecary mix created: the merchant filled in their products.
    doc = {
      ...doc,
      sections: doc.sections.map(n =>
        n.type === 'featured-collection'
          ? { ...n, settings: { ...n.settings, manualProductIds: ['p1', 'p2'] } }
          : n.type === 'steps'
            ? {
                ...n,
                blocks: n.blocks!.map((blk, i) => ({
                  ...blk,
                  settings: { ...blk.settings, productIds: [`prod-${i}`], bodyAr: `خطوة ${i + 1}` },
                })),
              }
            : n
      ),
    };
    return doc;
  }

  it('Apothecary → Bloom → Clinic → Apothecary keeps hero copy, product refs, logo, about block and the steps items', () => {
    const start = merchantApothecary();
    const heroBlocks = hero(start)!.blocks;
    const refs = one(start, 'featured-collection').settings.manualProductIds;
    const stepBlocks = one(start, 'steps').blocks;
    let doc = start;
    let from = apothecary;
    for (const to of [bloom, clinic, apothecary, clinic]) {
      doc = applyTemplateFamily(doc, 'jasmine', to, { from, design: 'keep' });
      from = to;
      expect(hero(doc)?.blocks, `hero copy after ${to.id}`).toEqual(heroBlocks);
      expect(one(doc, 'featured-collection').settings.manualProductIds, to.id).toEqual(refs);
      expect(doc.sectionGroups, to.id).toEqual(start.sectionGroups);
      expect(doc.siteSettings, to.id).toEqual(start.siteSettings);
      expect(one(doc, 'image-text').settings.image, `about photo after ${to.id}`).toBe(
        'https://x/story.webp'
      );
      // the routine items survive every switch away and back (never lost, restorable)
      expect(one(doc, 'steps')?.blocks, `steps after ${to.id}`).toEqual(stepBlocks);
      expect(types(doc).slice(0, to.sections!.length), to.id).toEqual(
        to.sections!.map(s => s.type)
      );
      expect(validateDefinitionSync(doc).ok, to.id).toBe(true);
    }
  });

  for (const design of ['keep', 'reset'] as const) {
    it(`no leakage (${design}): Apothecary → Bloom returns the tag source to categories and drops the light band`, () => {
      const onApo = applyTemplateFamily(merchantBase(), 'jasmine', apothecary);
      expect(one(onApo, 'category-grid').settings.source).toBe('tags');
      expect(one(onApo, 'featured-collection').settings.bgColor).toBe('token:inverse');
      const doc = applyTemplateFamily(onApo, 'jasmine', bloom, { from: apothecary, design });
      const grid = one(doc, 'category-grid').settings;
      expect(grid.layout).toBe('rail');
      // Apothecary-owned: the tag source and the chip padding return to the section default
      expect(grid.source ?? defaultsOf('category-grid').source).toBe(
        defaultsOf('category-grid').source
      );
      expect(grid.source).not.toBe('tags');
      expect(grid.paddingBottom).not.toBe('none');
      expect(one(doc, 'featured-collection').settings.bgColor).toBe(
        defaultsOf('featured-collection').bgColor
      );
    });
    it(`no leakage (${design}): Clinic → Apothecary swaps the stage layout out and keeps the chips on tags`, () => {
      const onClinic = applyTemplateFamily(merchantBase(), 'jasmine', clinic);
      expect(one(onClinic, 'product-spotlight').settings.layout).toBe('stage');
      expect(one(onClinic, 'featured-collection').settings.bgColor).toBe('token:card');
      const doc = applyTemplateFamily(onClinic, 'jasmine', apothecary, { from: clinic, design });
      expect(one(doc, 'featured-collection').settings.bgColor).toBe('token:inverse');
      expect(one(doc, 'category-grid').settings.source).toBe('tags');
      expect(validateDefinitionSync(doc).ok).toBe(true);
    });
    it(`no leakage (${design}): Bloom → Clinic: the rail does not leak into the chips`, () => {
      const onBloom = applyTemplateFamily(merchantBase(), 'jasmine', bloom);
      const doc = applyTemplateFamily(onBloom, 'jasmine', clinic, { from: bloom, design });
      const grid = one(doc, 'category-grid').settings;
      expect(grid.layout).toBe('chips');
      expect(grid.source).toBe('tags');
    });
  }

  it('keep: a merchant-changed field survives, the rest follows the incoming mix (C8)', () => {
    const onClinic = applyTemplateFamily(merchantBase(), 'jasmine', clinic);
    const edited: PageDefinition = {
      ...onClinic,
      sections: onClinic.sections.map(n =>
        n.type === 'featured-collection' ? { ...n, settings: { ...n.settings, columns: 3 } } : n
      ),
    };
    const kept = applyTemplateFamily(edited, 'jasmine', apothecary, {
      from: clinic,
      design: 'keep',
    });
    expect(one(kept, 'featured-collection').settings.columns).toBe(3); // the merchant's pick
    expect(one(kept, 'featured-collection').settings.bgColor).toBe('token:inverse');
    const reset = applyTemplateFamily(edited, 'jasmine', apothecary, {
      from: clinic,
      design: 'reset',
    });
    expect(one(reset, 'featured-collection').settings.columns).toBe(4);
  });

  it('Qamar ↔ Jasmine and Souq ↔ Jasmine keep content across templates', () => {
    const onAtelier = applyTemplateFamily(merchantBase(), 'qamar', atelier);
    const heroBlocks = hero(onAtelier)!.blocks;
    const toBloom = applyTemplateFamily(onAtelier, 'jasmine', bloom, {
      from: atelier,
      design: 'keep',
    });
    expect(hero(toBloom)?.blocks).toEqual(heroBlocks);
    expect(toBloom.sectionGroups).toEqual(onAtelier.sectionGroups);
    expect(one(toBloom, 'category-grid').settings.layout).toBe('rail');
    const backToQamar = applyTemplateFamily(toBloom, 'qamar', atelier, {
      from: bloom,
      design: 'keep',
    });
    expect(hero(backToQamar)?.blocks).toEqual(heroBlocks);
    expect(one(backToQamar, 'category-grid').settings.layout).toBe('chips');

    const onNight = applyTemplateFamily(merchantBase(), 'souq', night);
    const nightHero = hero(onNight)!.blocks;
    const toClinic = applyTemplateFamily(onNight, 'jasmine', clinic, {
      from: night,
      design: 'keep',
    });
    expect(hero(toClinic)?.blocks).toEqual(nightHero); // content kept (an untouched hero stays as content)
    expect(one(toClinic, 'category-grid').settings.layout).toBe('chips');
    const backToNight = applyTemplateFamily(toClinic, 'souq', night, {
      from: clinic,
      design: 'keep',
    });
    expect(hero(backToNight)?.blocks).toEqual(nightHero);
    expect(one(backToNight, 'category-grid').settings.layout).toBe('tiles');
    expect(one(backToNight, 'category-grid').settings.source ?? 'categories').toBe('categories');
    expect(validateDefinitionSync(backToNight).ok).toBe(true);
  });
});

describe('lookTag selects only its own look section at render', () => {
  it('a hero tagged for another Jasmine look is left out; untagged sections stay', () => {
    const base = merchantBase();
    const heroFor = (look: string, id: string): SectionNode => ({
      ...sectionFromPreset('hero', 0, id),
      lookTag: look,
    });
    const doc: PageDefinition = {
      ...base,
      sections: [
        heroFor('jasmine.apothecary', 'hero-apothecary'),
        heroFor('jasmine.bloom', 'hero-bloom'),
        heroFor('jasmine.clinic', 'hero-clinic'),
        ...base.sections.filter(s => s.type !== 'hero'),
      ],
    };
    for (const l of [apothecary, bloom, clinic]) {
      const shown = documentForLook(doc, l);
      const heroes = all(shown, 'hero');
      expect(
        heroes.map(h => h.id),
        l.id
      ).toEqual([`hero-${l.id.split('.')[1]}`]);
      expect(all(shown, 'image-text')).toHaveLength(1);
    }
  });
});
