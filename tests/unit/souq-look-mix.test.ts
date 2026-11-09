/**
 * Phase B2 Task 4: the three Souq section mixes and the look-switch behaviour over them. Mixes are
 * data over the shared registry (LOOKS-1): the checks here are on the data, the switch machinery
 * (applyTemplateFamily) and the validator, plus the no-leak / keep-content guarantees of TPL-1.
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
  layoutToDefinition,
  resolveLayoutSettings,
  validateDefinitionSync,
  type PageDefinition,
  type SectionNode,
} from '@ebda/shared';

const catalogue = getLook('souq.catalogue')!;
const night = getLook('souq.night')!;
const showroom = getLook('souq.showroom')!;
const atelier = getLook('qamar.atelier')!;

const defaultsOf = (type: string) => sectionFromPreset(type, 0, type).settings;
const all = (doc: PageDefinition, type: string) => doc.sections.filter(s => s.type === type);
const one = (doc: PageDefinition, type: string) => all(doc, type)[0];
const types = (doc: PageDefinition) => doc.sections.map(s => s.type);

/** A merchant's own page: hero copy + slide photo, an about block, a header with a logo. */
function merchantBase(): PageDefinition {
  const hero = sectionFromPreset('hero', 1, 'hero');
  hero.blocks = [
    {
      id: 's1',
      type: 'slide',
      settings: {
        image: 'https://x/hero.webp',
        headlineAr: 'أجهزة بضمان حقيقي',
        headline: 'Real warranty',
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
    sections: [hero, story],
    siteSettings: {},
  };
}

describe('the mixes, exactly as designed', () => {
  it('Catalogue: search first, no hero; rail, deals, newest grid, trust, newsletter', () => {
    expect(catalogue.chrome?.header.search).toBe('prominent');
    expect(catalogue.sections!.map(s => s.type)).toEqual([
      'category-grid',
      'product-carousel',
      'featured-collection',
      'spec-sheet',
      'trust-strip',
      'newsletter',
    ]);
    expect(catalogue.sections!.some(s => s.type === 'hero')).toBe(false);
    const [rail, deals, grid] = catalogue.sections!;
    expect(rail.design).toMatchObject({ layout: 'rail', layoutMobile: 'rail' });
    expect(deals.preset).toMatchObject({
      productSource: 'on_sale',
      limit: 8,
      title: 'Deals today',
      titleAr: 'عروض النهاردة',
    });
    expect(grid.design).toEqual({ columns: 4, mobileColumns: 2 });
    expect(grid.preset).toMatchObject({ productSource: 'newest', limit: 12 });
  });

  it('Night souq: hero, one stage, 4-up tiles, curated row, deals row, grid, trust, story, all on the green', () => {
    expect(night.chrome?.header.search).toBe('icon');
    expect(night.chrome).toMatchObject({ plp: 'autoFill', listing: 'ground' });
    expect(night.sections!.map(s => s.type)).toEqual([
      'hero',
      'product-spotlight',
      'category-grid',
      'product-carousel',
      'product-carousel',
      'featured-collection',
      'spec-sheet',
      'trust-strip',
      'brand-story',
    ]);
    expect(night.sections![0].design).toMatchObject({ presentation: 'full-bleed' });
    // STOP-2: the lantern hero carries no product, so one featured product follows it (a stage)
    expect(night.sections![1].design).toMatchObject({ layout: 'stage' });
    expect(night.sections![1].preset).toMatchObject({ productSource: 'featured', limit: 1 });
    const tiles = night.sections![2].design!;
    expect(tiles).toMatchObject({
      layout: 'tiles',
      layoutMobile: 'tiles',
      desktopColumns: 4,
      mobileColumns: 2,
    });
    const [curated, deals] = [night.sections![3], night.sections![4]];
    expect(curated.preset).toMatchObject({ productSource: 'manual', titleAr: 'من السوق' });
    expect(deals.preset).toMatchObject({ productSource: 'on_sale', titleAr: 'عروض' });
    // B2-23/24 (amends B2-19): no light band anywhere; photos sit on a cream matte (CSS), so the
    // page stays green from the hero to the footer
    expect(night.sections![5].design).toMatchObject({ columns: 4 });
    for (const sec of night.sections!)
      expect(JSON.stringify(sec.design ?? {}), sec.type).not.toContain('token:inverse');
  });

  it('Showroom: chips under the header, up to three stages, tiles on the surface, 4-up grid', () => {
    expect(showroom.chrome?.header.search).toBe('icon');
    expect(showroom.sections!.map(s => s.type)).toEqual([
      'category-grid',
      'product-spotlight',
      'product-spotlight',
      'product-spotlight',
      'collection-list',
      'featured-collection',
      'spec-sheet',
      'trust-strip',
    ]);
    expect(showroom.sections![0].design).toMatchObject({ layout: 'chips', paddingBottom: 'none' });
    for (const s of showroom.sections!.slice(1, 4)) {
      expect(s.design).toMatchObject({ layout: 'stage' });
      expect(s.preset).toMatchObject({ limit: 1 });
      // STOP-1: no "Gift ideas" kicker (the registry's first spotlight preset) on a stage
      expect(s.preset).toMatchObject({ heading: '', headingAr: '' });
    }
    expect(showroom.sections![4].design).toMatchObject({
      tileShape: 'rectangle',
      bgColor: 'token:card',
    });
    expect(showroom.sections![5].design).toMatchObject({ columns: 4, mobileColumns: 2 });
  });
});

describe('mix data is valid against the schema (the C1/X3 mismatch class)', () => {
  for (const look of [catalogue, night, showroom]) {
    it(`${look.id}: every design key is a LOOK_DESIGN_KEY, no mix sets hero mode, no category in a preset`, () => {
      for (const s of look.sections!) {
        expect(getSectionDefinition(s.type)?.group, s.type).toBe('template');
        for (const k of Object.keys(s.design ?? {}))
          expect(LOOK_DESIGN_KEYS, `${s.type}.${k}`).toContain(k);
        expect(s.design ?? {}).not.toHaveProperty('mode');
        expect(s.preset ?? {}).not.toHaveProperty('categorySlug');
      }
    });
    it(`${look.id}: no type is named more often than the registry allows`, () => {
      for (const t of new Set(look.sections!.map(s => s.type))) {
        const n = look.sections!.filter(s => s.type === t).length;
        expect(n, t).toBeLessThanOrEqual(getSectionDefinition(t)!.maxCount);
      }
    });
    it(`${look.id}: the composed draft validates (enum values, cardinality, tokens)`, () => {
      const doc = applyTemplateFamily(merchantBase(), 'souq', look);
      const v = validateDefinitionSync(doc);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      expect(types(doc).slice(0, look.sections!.length)).toEqual(look.sections!.map(s => s.type));
    });
  }
});

describe('re-applying a mix is idempotent (several specs of one type)', () => {
  it('Night twice keeps two carousels; Showroom twice keeps three stages', () => {
    const n1 = applyTemplateFamily(merchantBase(), 'souq', night);
    const n2 = applyTemplateFamily(n1, 'souq', night, { from: night, design: 'keep' });
    expect(all(n2, 'product-carousel')).toHaveLength(2);
    expect(types(n2)).toEqual(types(n1));
    const s1 = applyTemplateFamily(merchantBase(), 'souq', showroom);
    const s2 = applyTemplateFamily(s1, 'souq', showroom, { from: showroom, design: 'keep' });
    expect(all(s2, 'product-spotlight')).toHaveLength(3);
    expect(types(s2)).toEqual(types(s1));
  });
  it('each carousel keeps its own preset (curated stays manual, deals stays on_sale)', () => {
    const doc = applyTemplateFamily(
      applyTemplateFamily(merchantBase(), 'souq', night),
      'souq',
      night,
      {
        from: night,
        design: 'reset',
      }
    );
    const [a, b] = all(doc, 'product-carousel');
    expect(a.settings.productSource).toBe('manual');
    expect(b.settings.productSource).toBe('on_sale');
  });
});

describe('look switch keeps content and does not leak design (TPL-1)', () => {
  const hero = (d: PageDefinition) => d.sections.find(s => s.type === 'hero');

  function merchantNight(): PageDefinition {
    // the store is on Night with the merchant's own content layered on
    let doc = applyTemplateFamily(merchantBase(), 'souq', night);
    doc = {
      ...doc,
      sections: doc.sections.map(n =>
        n.type === 'featured-collection'
          ? { ...n, settings: { ...n.settings, manualProductIds: ['p1', 'p2'] } }
          : n
      ),
    };
    return doc;
  }

  it('Night → Catalogue → Showroom → Night → Catalogue keeps hero copy, product refs, header logo', () => {
    const start = merchantNight();
    const heroBlocks = hero(start)!.blocks;
    const refs = one(start, 'featured-collection').settings.manualProductIds;
    expect(heroBlocks?.[0].settings.headlineAr).toBe('أجهزة بضمان حقيقي');
    let doc = start;
    let from = night;
    for (const to of [catalogue, showroom, night, catalogue]) {
      doc = applyTemplateFamily(doc, 'souq', to, { from, design: 'keep' });
      from = to;
      expect(hero(doc)?.blocks, `hero copy after ${to.id}`).toEqual(heroBlocks);
      expect(one(doc, 'featured-collection').settings.manualProductIds, to.id).toEqual(refs);
      expect(doc.sectionGroups, to.id).toEqual(start.sectionGroups);
      expect(doc.siteSettings, to.id).toEqual(start.siteSettings);
      expect(types(doc).slice(0, to.sections!.length), to.id).toEqual(
        to.sections!.map(s => s.type)
      );
      expect(validateDefinitionSync(doc).ok, to.id).toBe(true);
    }
  });

  it('a hand-picked stage and a category photo survive a switch away and back (revision-safe)', () => {
    let doc = applyTemplateFamily(merchantBase(), 'souq', showroom);
    doc = {
      ...doc,
      sections: doc.sections.map((n, i) => {
        if (n.type === 'product-spotlight' && n === all(doc, 'product-spotlight')[1])
          return {
            ...n,
            settings: { ...n.settings, productSource: 'manual', manualProductIds: ['p9'] },
          };
        if (n.type === 'collection-list')
          return {
            ...n,
            blocks: [
              {
                id: 'c1',
                type: 'collection',
                settings: { categorySlug: 'phones', image: 'https://x/phones.webp' },
              },
            ],
          } as SectionNode;
        return n;
      }),
    };
    const stage = (d: PageDefinition) =>
      all(d, 'product-spotlight').find(n => n.settings.manualProductIds);
    expect(stage(doc)!.settings.manualProductIds).toEqual(['p9']);
    const away = applyTemplateFamily(doc, 'souq', night, { from: showroom, design: 'keep' });
    // edited sections the incoming look does not use stay on the draft, after the mix
    expect(stage(away)?.settings.manualProductIds).toEqual(['p9']);
    expect(one(away, 'collection-list').blocks?.[0].settings.image).toBe('https://x/phones.webp');
    const back = applyTemplateFamily(away, 'souq', showroom, { from: night, design: 'keep' });
    expect(stage(back)!.settings.manualProductIds).toEqual(['p9']);
    expect(stage(back)!.settings.layout).toBe('stage');
    expect(one(back, 'collection-list').blocks?.[0].settings.image).toBe('https://x/phones.webp');
    expect(all(back, 'product-spotlight')).toHaveLength(3);
  });

  it('an UNTOUCHED section the outgoing look added leaves the draft (it stays in history)', () => {
    const onShowroom = applyTemplateFamily(merchantBase(), 'souq', showroom);
    const onNight = applyTemplateFamily(onShowroom, 'souq', night, {
      from: showroom,
      design: 'keep',
    });
    // Night keeps ONE stage of its own (the featured product under the hero); Showroom's other two
    // untouched stages leave the draft
    expect(all(onNight, 'product-spotlight')).toHaveLength(1);
    expect(all(onNight, 'collection-list')).toHaveLength(0);
  });

  for (const design of ['keep', 'reset'] as const) {
    it(`no leakage (${design}): Night → Catalogue resets Night-only design keys to the section default`, () => {
      const onNight = applyTemplateFamily(merchantBase(), 'souq', night);
      expect(one(onNight, 'category-grid').settings.layout).toBe('tiles');
      expect(one(onNight, 'category-grid').settings.desktopColumns).toBe(4);
      const doc = applyTemplateFamily(onNight, 'souq', catalogue, { from: night, design });
      const grid = one(doc, 'category-grid').settings;
      expect(grid.layout).toBe('rail');
      expect(grid.bgColor).toBe(defaultsOf('category-grid').bgColor);
      // Night's 4-up tiles are Night-owned: they return to the section default
      expect(grid.desktopColumns).toBe(defaultsOf('category-grid').desktopColumns);
      expect(grid.captionPosition).toBe(defaultsOf('category-grid').captionPosition);
      const fc = one(doc, 'featured-collection').settings;
      expect(fc.bgColor).toBe(defaultsOf('featured-collection').bgColor);
      expect(fc.columns).toBe(4);
      // Night's untouched stage leaves with it
      expect(all(doc, 'product-spotlight')).toHaveLength(0);
      if (design === 'keep') {
        // the hero (content) stays on the draft; its Night-only design resets
        expect(hero(doc)?.blocks).toEqual(hero(onNight)?.blocks);
        expect(hero(doc)?.settings.presentation).toBe(defaultsOf('hero').presentation);
        expect(hero(doc)?.settings.textAnchor ?? defaultsOf('hero').textAnchor).toBe(
          defaultsOf('hero').textAnchor
        );
      } else {
        // reset applies the incoming look whole: a section it does not name leaves the draft
        expect(hero(doc)).toBeUndefined();
      }
      // Night's untouched curated carousel (a surplus the Catalogue has no spec for) leaves;
      // only the deals carousel remains
      expect(all(doc, 'product-carousel')).toHaveLength(1);
      expect(all(doc, 'product-carousel')[0].settings.productSource).toBe('on_sale');
    });

    it(`no leakage (${design}): Showroom → Night swaps chips for tiles on the band, 4-up back to 4`, () => {
      const onShowroom = applyTemplateFamily(merchantBase(), 'souq', showroom);
      expect(one(onShowroom, 'category-grid').settings.layout).toBe('chips');
      expect(one(onShowroom, 'featured-collection').settings.columns).toBe(4);
      const doc = applyTemplateFamily(onShowroom, 'souq', night, { from: showroom, design });
      const grid = one(doc, 'category-grid').settings;
      expect(grid.layout).toBe('tiles');
      expect(grid.layoutMobile).toBe('tiles');
      expect(grid.desktopColumns).toBe(4);
      expect(grid.bgColor).toBe(defaultsOf('category-grid').bgColor);
      // Showroom's paddingTop 'tight' is Showroom-owned; Night sets only paddingBottom
      expect(grid.paddingTop).toBe(defaultsOf('category-grid').paddingTop);
      expect(one(doc, 'featured-collection').settings.columns).toBe(4);
    });
  }

  it('keep: a merchant-changed field survives, the rest follows the incoming mix (C8)', () => {
    const onCatalogue = applyTemplateFamily(merchantBase(), 'souq', catalogue);
    const edited: PageDefinition = {
      ...onCatalogue,
      sections: onCatalogue.sections.map(n =>
        n.type === 'featured-collection' ? { ...n, settings: { ...n.settings, columns: 3 } } : n
      ),
    };
    const kept = applyTemplateFamily(edited, 'souq', night, { from: catalogue, design: 'keep' });
    const fc = one(kept, 'featured-collection').settings;
    expect(fc.columns).toBe(3); // the merchant's pick
    const reset = applyTemplateFamily(edited, 'souq', night, { from: catalogue, design: 'reset' });
    expect(one(reset, 'featured-collection').settings.columns).toBe(4);
  });

  it('Qamar ↔ Souq keeps content across templates (hero copy, header logo, about block)', () => {
    const onAtelier = applyTemplateFamily(merchantBase(), 'qamar', atelier);
    const heroBlocks = hero(onAtelier)!.blocks;
    const toSouq = applyTemplateFamily(onAtelier, 'souq', night, { from: atelier, design: 'keep' });
    expect(hero(toSouq)?.blocks).toEqual(heroBlocks);
    expect(toSouq.sectionGroups).toEqual(onAtelier.sectionGroups);
    // the Atelier-only full-bleed image break was untouched: it leaves; Atelier's chips do not leak
    expect(one(toSouq, 'category-grid').settings.layout).toBe('tiles');
    const toCatalogue = applyTemplateFamily(toSouq, 'souq', catalogue, {
      from: night,
      design: 'keep',
    });
    const backToQamar = applyTemplateFamily(toCatalogue, 'qamar', atelier, {
      from: catalogue,
      design: 'keep',
    });
    expect(hero(backToQamar)?.blocks).toEqual(heroBlocks);
    expect(one(backToQamar, 'category-grid').settings.layout).toBe('chips');
    expect(all(backToQamar, 'product-carousel').length).toBeGreaterThanOrEqual(1);
    expect(validateDefinitionSync(backToQamar).ok).toBe(true);
  });
});

describe('merchant-edited surplus sections (B2-16)', () => {
  const editDeals = (doc: PageDefinition) => ({
    ...doc,
    sections: doc.sections.map(n =>
      n.type === 'product-carousel' && n.settings.productSource === 'on_sale'
        ? {
            ...n,
            settings: { ...n.settings, title: 'عروض الجمعة', titleAr: 'عروض الجمعة', limit: 5 },
          }
        : n
    ),
  });
  for (const design of ['keep', 'reset'] as const)
    it(`Night -> Catalogue (${design}): an edited extra carousel keeps its title and limit`, () => {
      const onNight = editDeals(applyTemplateFamily(merchantBase(), 'souq', night));
      const doc = applyTemplateFamily(onNight, 'souq', catalogue, { from: night, design });
      const carousels = all(doc, 'product-carousel');
      expect(
        carousels.some(c => c.settings.titleAr === 'عروض الجمعة' && c.settings.limit === 5)
      ).toBe(true);
      // the untouched curated seed (Night-only) leaves; the edited one stays exactly once
      expect(carousels).toHaveLength(1);
      expect(validateDefinitionSync(doc).ok).toBe(true);
    });
  it('round trip Night -> Catalogue -> Night never ends with two on_sale rows', () => {
    const onNight = editDeals(applyTemplateFamily(merchantBase(), 'souq', night));
    const toCat = applyTemplateFamily(onNight, 'souq', catalogue, { from: night, design: 'keep' });
    const back = applyTemplateFamily(toCat, 'souq', night, { from: catalogue, design: 'keep' });
    const sale = all(back, 'product-carousel').filter(c => c.settings.productSource === 'on_sale');
    expect(sale).toHaveLength(1);
    expect(sale[0].settings.titleAr).toBe('عروض الجمعة');
    expect(sale[0].settings.limit).toBe(5);
  });
});

describe('STOP-1 fixes on the composed documents', () => {
  it('a fresh Showroom stage carries no heading text at all', () => {
    const doc = applyTemplateFamily(merchantBase(), 'souq', showroom);
    const stages = all(doc, 'product-spotlight');
    expect(stages).toHaveLength(3);
    for (const st of stages) {
      expect(st.settings.heading).toBe('');
      expect(st.settings.headingAr).toBe('');
      expect(JSON.stringify(st.settings)).not.toMatch(/Gift ideas|أفكار للهدايا/);
    }
  });
  it('Night composes with no light band at all and validates (B2-24 amends B2-19)', () => {
    const doc = applyTemplateFamily(merchantBase(), 'souq', night);
    for (const sec of doc.sections)
      expect(JSON.stringify(sec.settings), sec.type).not.toContain('token:inverse');
    expect(validateDefinitionSync(doc).ok).toBe(true);
  });
});

describe('lookTag selects only its own look at render', () => {
  it('a hero / stage tagged for another Souq look is left out; untagged always stay', () => {
    const doc = applyTemplateFamily(merchantBase(), 'souq', night);
    const heroNode = one(doc, 'hero');
    const tagged: PageDefinition = {
      ...doc,
      sections: [
        { ...heroNode, id: 'hero-night', lookTag: 'souq.night' },
        { ...heroNode, id: 'hero-room', lookTag: 'souq.showroom' },
        { ...sectionFromPreset('product-spotlight', 0, 'stage-room'), lookTag: 'souq.showroom' },
        ...doc.sections.filter(n => n.type !== 'hero'),
      ],
    };
    expect(validateDefinitionSync(tagged).ok).toBe(true);
    const ids = (look: typeof night) => documentForLook(tagged, look).sections.map(n => n.id);
    expect(ids(night)).toContain('hero-night');
    expect(ids(night)).not.toContain('hero-room');
    expect(ids(night)).not.toContain('stage-room');
    expect(ids(showroom)).toContain('hero-room');
    expect(ids(showroom)).toContain('stage-room');
    expect(ids(showroom)).not.toContain('hero-night');
    // untagged sections stay under every look
    for (const look of [night, showroom, catalogue])
      expect(ids(look)).toContain(doc.sections.find(n => n.type === 'trust-strip')!.id);
  });
});

describe('Ruling B2-22: a fresh store that applies a Souq look is not painted in the branded base', () => {
  // The real merchant path: a layout-built page (no stored document) on the souq skin, then applyLook.
  for (const look of [catalogue, night, showroom]) {
    it(`${look.id}: no primary band, no card-ink typography left over on any section`, () => {
      const page = layoutToDefinition(resolveLayoutSettings({}, 'souq', null));
      const doc = applyTemplateFamily(page, 'souq', look, {
        from: null,
        design: 'reset',
        fromSkin: { skin: 'souq' },
        toSkin: { skin: 'souq' },
      });
      const json = JSON.stringify(doc.sections.map(sec => sec.settings));
      expect(json).not.toContain('"bgColor":"token:primary"');
      // heading / caption colours of the branded base (white on its primary band)
      expect(json).not.toMatch(/"color":"token:(card|secondary)"/);
      expect(validateDefinitionSync(doc).ok).toBe(true);
    });
  }
});

describe('Ruling B2-22 (cards): the listing card frame is the neutral border token', () => {
  it('souq productCardDefaults frame is token:border, not the primary accent', () => {
    expect(resolveLayoutSettings({}, 'souq', null).productCardDefaults?.cardFrameColor).toBe(
      'token:border'
    );
  });
});
