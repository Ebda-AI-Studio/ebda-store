/**
 * Phase B5 Task 5: the Dahab demo catalogue exercises every storefront feature the looks are judged with
 * (counted by feature, like B2's to B4's), prices six pieces from the gold rate (two per karat), is
 * unbranded and fictional (Rulings B5-10, B5-11), carries no yellow-gold swatch and no orange palette
 * field, and its home document names only sections that exist and renders through each look's mix.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  productFactsSchema,
  personalisationConfigSchema,
  getLook,
  validateDefinitionSync,
  applyTemplateFamily,
  computeGoldUnitPrice,
  mgToGramsString,
  PAGE_DEFINITION_SCHEMA_VERSION,
  type PageDefinition,
} from '@ebda/shared';
import {
  DAHAB_PRODUCTS,
  DAHAB_CATEGORIES,
  DAHAB_OCCASIONS,
  DAHAB_SIZE_CHARTS,
  DAHAB_GOLD_RATES,
  DAHAB_IMAGE_FILES,
  // @ts-expect-error plain .mjs data module
} from '../../scripts/dahab-demo/catalogue.mjs';
// @ts-expect-error plain .mjs script
import { variantSku, combos, TEMPLATE_SPECS } from '../../scripts/storedemo/seed.mjs';
// @ts-expect-error plain .mjs script
import { buildDahabHome } from '../../scripts/storedemo/dahab-home.mjs';
import { isOrangeFamily } from './helpers/orange-gate';

type Value = { value: string; valueAr: string; hex?: string; priceAdd?: number; weightMg?: number };
type Option = { name: string; nameAr: string; values: Value[] };
type Fact = { key: string; keyAr: string; value: string; valueAr: string; onCard?: boolean };
type Gold = {
  karat: 24 | 21 | 18;
  weightMg: number;
  makingChargeType: 'fixed' | 'per_gram';
  makingChargeValue: number;
  marginBps: number;
};
type Product = {
  slug: string;
  name: string;
  nameAr: string;
  category: string;
  alsoIn?: string[];
  price: number;
  compareAtPrice?: number;
  images: string[];
  description: string;
  descriptionAr: string;
  options?: Option[];
  soldOut?: string[][];
  backorder?: boolean;
  stock?: number;
  gold?: Gold;
  facts: Fact[];
  leadTimeDays?: number;
  personalisation?: { label: string; labelAr: string; maxLength: number; required: boolean };
};
const PRODUCTS = DAHAB_PRODUCTS as Product[];
const CATEGORIES = DAHAB_CATEGORIES as { slug: string; image?: string; sizeChart?: string }[];
const OCCASIONS = (DAHAB_OCCASIONS as { slug: string }[]).map(o => o.slug);
const assets = path.resolve(__dirname, '../../scripts/dahab-demo/assets');
const withOptions = PRODUCTS.filter(p => p.options?.length);
const gold = PRODUCTS.filter(p => p.gold);

describe('dahab demo catalogue: shape', () => {
  it('21 products with unique slugs and 11 categories (7 shop + 4 occasions)', () => {
    expect(PRODUCTS).toHaveLength(21);
    expect(new Set(PRODUCTS.map(p => p.slug)).size).toBe(21);
    expect(CATEGORIES.map(c => c.slug)).toEqual([
      'rings',
      'necklaces',
      'bracelets',
      'earrings',
      'sets',
      'gold-rate',
      'gifts',
      'engagement',
      'birthday',
      'mothers-day',
      'graduation',
    ]);
  });
  it('every product (and every alsoIn) is in a known category; every category holds a product', () => {
    const slugs = new Set(CATEGORIES.map(c => c.slug));
    for (const p of PRODUCTS)
      for (const c of [p.category, ...(p.alsoIn ?? [])])
        expect(slugs.has(c), `${p.slug} ${c}`).toBe(true);
    for (const c of CATEGORIES)
      expect(
        PRODUCTS.some(p => p.category === c.slug || p.alsoIn?.includes(c.slug)),
        c.slug
      ).toBe(true);
  });
  it('every shop category photo is a product photo that exists; occasions carry none (hidden from the home row)', () => {
    for (const c of CATEGORIES.filter(x => !OCCASIONS.includes(x.slug))) {
      expect(c.image, c.slug).toBeTruthy();
      expect(
        PRODUCTS.some(p => p.images.includes(c.image!)),
        c.slug
      ).toBe(true);
    }
    for (const c of CATEGORIES.filter(x => OCCASIONS.includes(x.slug)))
      expect(c.image).toBeUndefined();
  });
  it('the seed spec reads this catalogue and hides the occasion categories from the home row', () => {
    expect(TEMPLATE_SPECS.dahab.products).toBe(DAHAB_PRODUCTS);
    expect(TEMPLATE_SPECS.dahab.categories).toBe(DAHAB_CATEGORIES);
    expect(TEMPLATE_SPECS.dahab.occasionSlugs).toEqual(OCCASIONS);
  });
});

describe('dahab demo catalogue: gold-rate pieces (Rulings B5-12, B5-13)', () => {
  it('six pieces, two per karat, one per-gram making charge and one fixed in the set', () => {
    expect(gold).toHaveLength(6);
    for (const k of [24, 21, 18])
      expect(
        gold.filter(p => p.gold!.karat === k),
        `${k}k`
      ).toHaveLength(2);
    expect(gold.some(p => p.gold!.makingChargeType === 'per_gram')).toBe(true);
    expect(gold.some(p => p.gold!.makingChargeType === 'fixed')).toBe(true);
  });
  it('a gold ring whose size variants weigh differently', () => {
    const ring = gold.find(p => p.options?.some(o => o.name === 'Size'))!;
    expect(ring.slug).toBe('gold-solitaire-18');
    const weights = ring.options![0].values.map(v => v.weightMg);
    expect(weights.every(w => typeof w === 'number')).toBe(true);
    expect(new Set(weights).size).toBe(weights.length);
  });
  it('no gold piece carries a compare-at price or a sale (a sale runs through a coupon, Ruling B5-19)', () => {
    for (const p of gold) {
      expect(p.compareAtPrice, p.slug).toBeUndefined();
      expect(
        p.options?.some(o => o.values.some(v => v.priceAdd)),
        p.slug
      ).toBeFalsy();
    }
  });
  it('the facts agree with the spec: karat chip and weight chip match what the repricer will use', () => {
    for (const p of gold) {
      const karat = p.facts.find(f => f.key === 'Karat')!;
      expect(karat.value, p.slug).toBe(`${p.gold!.karat} karat`);
      expect(karat.valueAr, p.slug).toBe(`عيار ${p.gold!.karat}`);
      const w = p.facts.find(f => f.key === 'Weight')!;
      expect(w.value, p.slug).toBe(`${mgToGramsString(p.gold!.weightMg)} g`);
      expect(
        p.facts.filter(f => f.onCard),
        p.slug
      ).toHaveLength(2);
    }
  });
  it('every spec is accepted by the price formula at the demo rates, with a plausible price', () => {
    const rate = (k: number) =>
      DAHAB_GOLD_RATES.find((r: { karat: number }) => r.karat === k).ratePerGram;
    for (const p of gold) {
      const r = computeGoldUnitPrice(
        {
          karat: p.gold!.karat,
          weightMg: p.gold!.weightMg,
          makingChargeType: p.gold!.makingChargeType,
          makingChargeValue: p.gold!.makingChargeValue,
          marginBps: p.gold!.marginBps,
        },
        rate(p.gold!.karat),
        100
      );
      expect(r.unitPrice % 100, p.slug).toBe(0);
      expect(r.unitPrice, p.slug).toBeGreaterThan(500_000); // above 5,000 EGP
      expect(r.unitPrice, p.slug).toBeLessThan(6_000_000); // below 60,000 EGP
    }
  });
  it('the three demo rates cover every karat and agree within 0.5 % of 24k x karat / 24', () => {
    const r24 = DAHAB_GOLD_RATES.find((r: { karat: number }) => r.karat === 24).ratePerGram;
    for (const k of [21, 18]) {
      const r = DAHAB_GOLD_RATES.find((x: { karat: number }) => x.karat === k).ratePerGram;
      expect(Math.abs(r - (r24 * k) / 24) / r, `${k}k`).toBeLessThan(0.005);
    }
  });
  it('the seed turns the automatic rate OFF and shows the breakdown (judged with the split visible)', () => {
    expect(TEMPLATE_SPECS.dahab.gold.feed).toBe(false);
    expect(TEMPLATE_SPECS.dahab.gold.showBreakdown).toBe(true);
  });
});

describe('dahab demo catalogue: every B0 feature, by count', () => {
  it('rings use the "مقاس الخاتم" chart through their category, and every ring size is in the chart', () => {
    expect(CATEGORIES.find(c => c.slug === 'rings')!.sizeChart).toBe('ring');
    expect(DAHAB_SIZE_CHARTS.ring.nameAr).toBe('مقاس الخاتم');
    const chartSizes = DAHAB_SIZE_CHARTS.ring.rows.map((r: string[]) => r[0]);
    const rings = PRODUCTS.filter(p => p.category === 'rings' || p.alsoIn?.includes('rings'));
    expect(rings.length).toBeGreaterThanOrEqual(4);
    for (const p of rings)
      for (const v of p.options!.find(o => o.name === 'Size')!.values)
        expect(chartSizes, `${p.slug} ${v.value}`).toContain(v.value);
  });
  it('a METAL swatch option (silver, rose gold, champagne) with real hex values and NO yellow-gold swatch', () => {
    const band = PRODUCTS.find(p => p.slug === 'silver-band-ring')!;
    const metal = band.options!.find(o => o.name === 'Metal')!;
    expect(metal.values.map(v => v.value)).toEqual(['Silver', 'Rose gold', 'Champagne']);
    for (const v of metal.values) {
      expect(v.hex, v.value).toMatch(/^#[0-9A-F]{6}$/i);
      // the no-orange gate reads swatches too: a yellow-gold swatch would fail it
      expect(isOrangeFamily(v.hex!), `${v.value} ${v.hex}`).toBe(false);
    }
    const all = JSON.stringify(PRODUCTS);
    expect(all).not.toMatch(/yellow gold|ذهب أصفر/i);
  });
  it('a length option on the necklaces, with real price steps', () => {
    const len = PRODUCTS.filter(p => p.options?.some(o => o.name === 'Length'));
    expect(len.map(p => p.slug).sort()).toEqual(['heart-pendant', 'name-necklace']);
    for (const p of len) {
      const steps = p.options!.find(o => o.name === 'Length')!.values.map(v => v.priceAdd ?? 0);
      expect(steps[0]).toBe(0);
      expect(steps[1]).toBeGreaterThan(0);
    }
  });
  it('gift wrap is a variant OPTION on 3+ pieces (Ruling B5-4), the wrap step a real price', () => {
    const wrapped = PRODUCTS.filter(p => p.options?.some(o => o.name === 'Gift wrap'));
    expect(wrapped.length).toBeGreaterThanOrEqual(3);
    for (const p of wrapped) {
      const o = p.options!.find(x => x.name === 'Gift wrap')!;
      expect(o.nameAr).toBe('تغليف الهدية');
      expect(o.values[1].priceAdd).toBeGreaterThan(0);
    }
  });
  it('a gift card at four fixed amounts as variants', () => {
    const card = PRODUCTS.find(p => p.slug === 'gift-card')!;
    const o = card.options!.find(x => x.name === 'Amount')!;
    expect(o.values.map(v => card.price + (v.priceAdd ?? 0))).toEqual([
      50_000, 100_000, 200_000, 500_000,
    ]);
  });
  it('variant SKUs are unique per product and use full value slugs', () => {
    for (const p of withOptions) {
      const skus = combos(p.options!).map((c: Value[]) =>
        variantSku(
          p.slug,
          c.map(v => v.value)
        )
      );
      expect(new Set(skus).size, p.slug).toBe(skus.length);
    }
    expect(variantSku('gold-solitaire-18', ['16'])).toBe('GOLD-SOLITAIRE-18-16');
  });
  it('facts on every piece: 1 or 2 on the card, all valid; every gold-weight/karat/width/warranty kind appears', () => {
    for (const p of PRODUCTS) {
      const onCard = p.facts.filter(f => f.onCard).length;
      expect(onCard, p.slug).toBeGreaterThanOrEqual(1);
      expect(onCard, p.slug).toBeLessThanOrEqual(2);
      expect(productFactsSchema.safeParse(p.facts).success, p.slug).toBe(true);
    }
    const keys = new Set(PRODUCTS.flatMap(p => p.facts.map(f => f.key)));
    for (const k of ['Karat', 'Width', 'Weight', 'Warranty']) expect(keys.has(k), k).toBe(true);
    expect(
      PRODUCTS.filter(p => p.facts.some(f => f.key === 'Warranty')).length
    ).toBeGreaterThanOrEqual(15);
  });
  it('two pieces with REQUIRED engraving "الحروف للحفر" (max 12) and two OPTIONAL card messages, all valid configs', () => {
    const noted = PRODUCTS.filter(p => p.personalisation);
    const required = noted.filter(p => p.personalisation!.required);
    expect(required.map(p => p.slug).sort()).toEqual(['engraved-ring', 'name-necklace']);
    for (const p of required) {
      expect(p.personalisation!.labelAr).toBe('الحروف للحفر');
      expect(p.personalisation!.maxLength).toBe(12);
    }
    const optional = noted.filter(p => !p.personalisation!.required);
    expect(optional.map(p => p.slug).sort()).toEqual(['heart-pendant', 'pearl-studs']);
    for (const p of optional) expect(p.personalisation!.labelAr).toBe('رسالة على الكارت');
    for (const p of noted)
      expect(
        personalisationConfigSchema.safeParse({ enabled: true, ...p.personalisation }).success,
        p.slug
      ).toBe(true);
  });
  it('four or more made-to-order pieces with a lead time of 3 to 7 days; the gold pieces ship ready', () => {
    const lead = PRODUCTS.filter(p => (p.leadTimeDays ?? 0) > 0);
    expect(lead.length).toBeGreaterThanOrEqual(4);
    for (const p of lead) {
      expect(p.leadTimeDays!, p.slug).toBeGreaterThanOrEqual(3);
      expect(p.leadTimeDays!, p.slug).toBeLessThanOrEqual(7);
    }
    for (const p of gold) expect(p.leadTimeDays ?? 0, p.slug).toBe(0);
  });
  it('sale prices: a real sale on a variant product (the card path reads the parent) and on simple pieces', () => {
    const sales = PRODUCTS.filter(p => p.compareAtPrice);
    expect(sales.length).toBeGreaterThanOrEqual(3);
    for (const p of sales) expect(p.compareAtPrice!, p.slug).toBeGreaterThan(p.price);
    expect(sales.some(p => p.options?.length)).toBe(true);
    expect(sales.some(p => !p.options?.length)).toBe(true);
  });
  it('one backorder (no stock, pre-order), one fully sold-out piece, two sold-out variants (never everything)', () => {
    expect(PRODUCTS.filter(p => p.backorder).map(p => p.slug)).toEqual(['tennis-bracelet']);
    expect(PRODUCTS.find(p => p.slug === 'tennis-bracelet')!.stock).toBe(0);
    const out = PRODUCTS.filter(p => !p.options?.length && p.stock === 0 && !p.backorder);
    expect(out.map(p => p.slug)).toEqual(['beaded-anklet']);
    const sold = withOptions.filter(p => p.soldOut?.length);
    expect(sold.map(p => p.slug).sort()).toEqual(['heart-pendant', 'silver-band-ring']);
    for (const p of sold) {
      const all = combos(p.options!).map((c: Value[]) => c.map(v => v.value).join('|'));
      for (const t of p.soldOut!) expect(all).toContain(t.join('|'));
      expect(all.length).toBeGreaterThan(p.soldOut!.length);
    }
  });
  it('every product has a photo, and Arabic first: an Arabic name and description', () => {
    expect(PRODUCTS.filter(p => p.images.length === 0).map(p => p.slug)).toEqual([]);
    for (const p of PRODUCTS) {
      expect(/[؀-ۿ]/.test(p.nameAr), p.slug).toBe(true);
      expect(/[؀-ۿ]/.test(p.descriptionAr), p.slug).toBe(true);
    }
  });
});

describe('dahab demo catalogue: unbranded and fictional (Rulings B5-10, B5-11)', () => {
  const BRANDS =
    /tiffany|cartier|bulgari|pandora|swarovski|van cleef|mejuri|talabat|noon\.com|amazon|dahab gold|el ?ezz|lazurde|bvlgari|damas|ثروت|مجوهرات ال/i;
  it('no product, category or fact names a brand', () => {
    const text = JSON.stringify([PRODUCTS, CATEGORIES]);
    expect(text.match(BRANDS)?.[0]).toBeUndefined();
  });
  it('no image file is a logo or brand file', () => {
    for (const f of DAHAB_IMAGE_FILES) expect(f).not.toMatch(/logo|brand/i);
  });
  it('no "karat" claim without a karat in the facts of a GOLD piece, and no hallmark claim anywhere', () => {
    expect(JSON.stringify(PRODUCTS)).not.toMatch(/hallmark|دمغة|assay/i);
  });
});

const ids = new Map(PRODUCTS.map((p, i) => [p.slug, `id-${i}`]));
const base = {
  schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
  pageKey: 'home',
  sections: [],
  sectionGroups: { header: [], footer: [] },
  siteSettings: {},
};
const build = () =>
  buildDahabHome(base, { img: (f: string) => `/__dahab-demo/${f}`, productIdBySlug: ids });

describe('dahab demo catalogue: images and the home document', () => {
  it('every image the catalogue names exists in assets/', () => {
    for (const f of DAHAB_IMAGE_FILES) expect(existsSync(path.join(assets, f)), f).toBe(true);
  });
  it('every image the home document names is in the catalogue image set', () => {
    const named = JSON.stringify(build()).match(/\/__dahab-demo\/[a-z0-9-]+\.webp/g) ?? [];
    expect(named.length).toBeGreaterThan(5);
    for (const n of named) expect(DAHAB_IMAGE_FILES, n).toContain(n.replace('/__dahab-demo/', ''));
  });
  it('the superset has one hero, one featured collection and one image-with-text PER look, tagged', () => {
    const doc = build();
    const tagged = (type: string) =>
      doc.sections
        .filter((s: { type: string; lookTag?: string }) => s.type === type)
        .map((s: { lookTag?: string }) => s.lookTag);
    for (const type of ['hero', 'featured-collection', 'image-text'])
      expect(tagged(type), type).toEqual(['dahab.worn', 'dahab.workshop', 'dahab.giftbox']);
    expect(tagged('steps')).toEqual(['dahab.workshop']);
    expect(tagged('gift-finder')).toEqual(['dahab.giftbox']);
  });
  it('the gift finder links to categories that exist and budgets in whole pounds', () => {
    const gf = build().sections.find((s: { type: string }) => s.type === 'gift-finder');
    const slugs = new Set(CATEGORIES.map(c => c.slug));
    const occ = gf.blocks.filter((b: { type: string }) => b.type === 'occasion');
    expect(occ).toHaveLength(4);
    for (const b of occ)
      expect(slugs.has(b.settings.categorySlug), b.settings.categorySlug).toBe(true);
    const budgets = gf.blocks.filter((b: { type: string }) => b.type === 'budget');
    expect(budgets.map((b: { settings: { maxPrice: number } }) => b.settings.maxPrice)).toEqual([
      1000, 2000, 5000,
    ]);
  });
  it('the Workshop collection list links four shop categories that exist', () => {
    const cl = build().sections.find((s: { type: string }) => s.type === 'collection-list');
    const slugs = new Set(CATEGORIES.map(c => c.slug));
    expect(cl.blocks).toHaveLength(4);
    for (const b of cl.blocks) expect(slugs.has(b.settings.categorySlug)).toBe(true);
  });
  for (const id of ['dahab.worn', 'dahab.workshop', 'dahab.giftbox']) {
    it(`${id}: the superset renders through the look's mix, validates, and shows only its own sections`, () => {
      const look = getLook(id)!;
      const rendered = applyTemplateFamily(build() as PageDefinition, 'dahab', look);
      const v = validateDefinitionSync(rendered);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      expect(rendered.sections.map(s => s.type).slice(0, look.sections!.length)).toEqual(
        look.sections!.map(s => s.type)
      );
      for (const s of rendered.sections)
        expect(s.lookTag === undefined || s.lookTag === id, `${s.id} ${s.lookTag}`).toBe(true);
    });
  }
  it('Worn has the chip row and the reviews; Workshop the steps and the collection list; Gift box the finder and the newsletter', () => {
    const types = (id: string) =>
      applyTemplateFamily(build() as PageDefinition, 'dahab', getLook(id)!).sections.map(
        s => s.type
      );
    expect(types('dahab.worn')).toEqual(expect.arrayContaining(['category-grid', 'testimonials']));
    expect(types('dahab.workshop')).toEqual(expect.arrayContaining(['steps', 'collection-list']));
    expect(types('dahab.giftbox')).toEqual(expect.arrayContaining(['gift-finder', 'newsletter']));
    expect(types('dahab.worn')).not.toContain('gift-finder');
    expect(types('dahab.workshop')).not.toContain('gift-finder');
  });
});
