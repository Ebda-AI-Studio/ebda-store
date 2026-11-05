/**
 * Phase B4 Task 6: the Lamma demo catalogue exercises every storefront feature the looks are judged
 * with (counted by feature, like B2's and B3's), is unbranded and fictional (Rulings B4-10, B4-11),
 * and its home document names only products that exist and renders through each look's mix.
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
  deliveryDateChoices,
  PAGE_DEFINITION_SCHEMA_VERSION,
  type PageDefinition,
} from '@ebda/shared';
import {
  LAMMA_PRODUCTS,
  LAMMA_CATEGORIES,
  LAMMA_IMAGE_FILES,
  // @ts-expect-error plain .mjs data module
} from '../../scripts/lamma-demo/catalogue.mjs';
// @ts-expect-error plain .mjs script
import { variantSku, combos, TEMPLATE_SPECS } from '../../scripts/storedemo/seed.mjs';
// @ts-expect-error plain .mjs script
import { buildLammaHome } from '../../scripts/storedemo/lamma-home.mjs';

type Value = { value: string; valueAr: string; priceAdd?: number };
type Option = { name: string; nameAr: string; values: Value[] };
type Fact = { key: string; keyAr: string; value: string; valueAr: string; onCard?: boolean };
type Product = {
  slug: string;
  name: string;
  nameAr: string;
  category: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  description: string;
  descriptionAr: string;
  options?: Option[];
  soldOut?: string[][];
  backorder?: boolean;
  stock?: number;
  facts: Fact[];
  leadTimeDays?: number;
  personalisation?: { label: string; labelAr: string; maxLength: number; required: boolean };
};
const PRODUCTS = LAMMA_PRODUCTS as Product[];
const CATEGORIES = LAMMA_CATEGORIES as { slug: string; image?: string }[];
const assets = path.resolve(__dirname, '../../scripts/lamma-demo/assets');
const withOptions = PRODUCTS.filter(p => p.options?.length);
const portion = withOptions.filter(p => p.options!.some(o => o.name === 'Portion'));
const weight = withOptions.filter(p => p.options!.some(o => o.name === 'Weight'));
const GROCERY = ['produce', 'dairy', 'meat-poultry', 'pantry'];

describe('lamma demo catalogue: shape', () => {
  it('28 products, unique slugs, 8 categories', () => {
    expect(PRODUCTS).toHaveLength(28);
    expect(new Set(PRODUCTS.map(p => p.slug)).size).toBe(28);
    expect(CATEGORIES.map(c => c.slug)).toEqual([
      'home-cooking',
      'tagines',
      'grill-bakery',
      'sweets',
      'produce',
      'dairy',
      'meat-poultry',
      'pantry',
    ]);
  });
  it('every product is in a known category and every category has products', () => {
    const slugs = new Set(CATEGORIES.map(c => c.slug));
    for (const p of PRODUCTS) expect(slugs.has(p.category), p.slug).toBe(true);
    for (const c of CATEGORIES)
      expect(
        PRODUCTS.some(p => p.category === c.slug),
        c.slug
      ).toBe(true);
  });
  it('every category photo is a product photo that exists', () => {
    for (const c of CATEGORIES) {
      expect(c.image, c.slug).toBeTruthy();
      expect(
        PRODUCTS.some(p => p.images.includes(c.image!)),
        c.slug
      ).toBe(true);
    }
  });
  it('the seed spec reads this catalogue', () => {
    expect(TEMPLATE_SPECS.lamma.products).toBe(LAMMA_PRODUCTS);
    expect(TEMPLATE_SPECS.lamma.categories).toBe(LAMMA_CATEGORIES);
  });
});

describe('lamma demo catalogue: every feature, by count', () => {
  it('portion-size variants with real price steps on 2 dishes', () => {
    expect(portion.map(p => p.slug)).toEqual(['mahshi-koronb', 'waraq-enab']);
    for (const p of portion) {
      const o = p.options!.find(x => x.name === 'Portion')!;
      expect(o.values).toHaveLength(3);
      const steps = o.values.map(v => v.priceAdd ?? 0);
      expect(steps[0]).toBe(0);
      expect(steps[1]).toBeGreaterThan(0);
      expect(steps[2]).toBeGreaterThan(steps[1]);
      expect(p.category).toBe('home-cooking');
    }
  });
  it('weight variants (500 g / 1 kg) on 4 produce items, the 1 kg price is the unit price shown as a fact', () => {
    expect(weight.map(p => p.slug)).toEqual(['tomatoes', 'eggplant', 'potatoes', 'apples']);
    for (const p of weight) {
      expect(p.category, p.slug).toBe('produce');
      const o = p.options!.find(x => x.name === 'Weight')!;
      expect(o.values.map(v => v.value)).toEqual(['500 g', '1 kg']);
      const perKg = p.price + (o.values[1].priceAdd ?? 0);
      const fact = p.facts.find(f => f.key === 'Price per kg')!;
      expect(fact.value, p.slug).toBe(`EGP ${perKg / 100}`);
      expect(fact.valueAr, p.slug).toBe(`${perKg / 100} ج.م/كجم`);
      expect(fact.onCard, p.slug).toBe(true);
    }
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
    expect(variantSku('mahshi-koronb', ['Small (6 pieces)'])).toBe('MAHSHI-KORONB-SMALL-6-PIECES');
  });
  it('at most two onCard facts on every product, at least one, and every fact list is valid', () => {
    for (const p of PRODUCTS) {
      const onCard = p.facts.filter(f => f.onCard).length;
      expect(onCard, p.slug).toBeGreaterThanOrEqual(1);
      expect(onCard, p.slug).toBeLessThanOrEqual(2);
      expect(productFactsSchema.safeParse(p.facts).success, p.slug).toBe(true);
    }
  });
  it('a made-to-order lead time on 5+ dishes (1, 2 and 3 days) and none on grocery', () => {
    const lead = PRODUCTS.filter(p => (p.leadTimeDays ?? 0) > 0);
    expect(lead.length).toBeGreaterThanOrEqual(5);
    expect(new Set(lead.map(p => p.leadTimeDays))).toEqual(new Set([1, 2, 3]));
    for (const p of PRODUCTS.filter(x => GROCERY.includes(x.category)))
      expect(p.leadTimeDays ?? 0, p.slug).toBe(0);
  });
  it('one REQUIRED message (the cake) and one OPTIONAL order note (the kunafa), both valid configs', () => {
    const noted = PRODUCTS.filter(p => p.personalisation);
    expect(noted.map(p => p.slug)).toEqual(['kunafa-nabulsi', 'chocolate-cake']);
    for (const p of noted)
      expect(
        personalisationConfigSchema.safeParse({ enabled: true, ...p.personalisation }).success,
        p.slug
      ).toBe(true);
    expect(PRODUCTS.find(p => p.slug === 'chocolate-cake')!.personalisation!.required).toBe(true);
    expect(PRODUCTS.find(p => p.slug === 'kunafa-nabulsi')!.personalisation!.required).toBe(false);
    expect(PRODUCTS.find(p => p.slug === 'kunafa-nabulsi')!.personalisation!.labelAr).toBe(
      'ملاحظة على الطلب'
    );
  });
  it('at least 6 sale prices, one at 40% off or more, every sale really lower', () => {
    const sales = PRODUCTS.filter(p => p.compareAtPrice);
    expect(sales.length).toBeGreaterThanOrEqual(6);
    for (const p of sales) expect(p.compareAtPrice!, p.slug).toBeGreaterThan(p.price);
    expect(sales.filter(p => 1 - p.price / p.compareAtPrice! >= 0.4).length).toBeGreaterThanOrEqual(
      1
    );
  });
  it('one backorder (no stock, pre-order), one sold-out variant (never everything)', () => {
    const back = PRODUCTS.filter(p => p.backorder);
    expect(back.map(p => p.slug)).toEqual(['bechamel-pasta']);
    expect(back[0].stock).toBe(0);
    const sold = withOptions.filter(p => p.soldOut?.length);
    expect(sold.map(p => p.slug)).toEqual(['black-tea']);
    const all = combos(sold[0].options!).map((c: Value[]) => c.map(v => v.value).join('|'));
    for (const t of sold[0].soldOut!) expect(all).toContain(t.join('|'));
    expect(all.length).toBeGreaterThan(sold[0].soldOut!.length);
  });
  it('every product has a photo (the showroom never shows a placeholder; lamma-noimg covers the empty case)', () => {
    expect(PRODUCTS.filter(p => p.images.length === 0).map(p => p.slug)).toEqual([]);
  });
  it('one very long Arabic name (>= 90 characters); no English name runs past 60 (the long case is lamma-longnames)', () => {
    expect(PRODUCTS.filter(p => p.nameAr.length >= 90)).toHaveLength(1);
    expect(PRODUCTS.filter(p => p.name.length > 60)).toEqual([]);
  });
  it('Arabic first: every product has Arabic name and description', () => {
    for (const p of PRODUCTS) {
      expect(/[؀-ۿ]/.test(p.nameAr), p.slug).toBe(true);
      expect(/[؀-ۿ]/.test(p.descriptionAr), p.slug).toBe(true);
    }
  });
  it('no orange subject by name (Review Focus 1): no oranges, carrots, mango, pumpkin or apricot', () => {
    const text = JSON.stringify(PRODUCTS.map(p => [p.slug, p.name, p.nameAr]));
    expect(text).not.toMatch(/orange|carrot|mango|pumpkin|apricot|برتقال|جزر|مانجو|قرع|مشمش/i);
  });
});

describe('lamma demo catalogue: unbranded and fictional (Rulings B4-10, B4-11)', () => {
  const BRANDS =
    /juhayna|lacnor|domty|panda|obour|el ?mallah|abu ?auf|koshary|hardee|mcdonald|kfc|pizza hut|talabat|elmenus|noon\.com|amazon|carrefour|spinneys|hyper ?one|nestle|lipton|ahmad tea|sultan|abu ?kass|dina farms/i;
  it('no product, category or fact names a brand', () => {
    const text = JSON.stringify([PRODUCTS, CATEGORIES]);
    expect(text.match(BRANDS)?.[0]).toBeUndefined();
  });
  it('no image file is a logo or brand file', () => {
    for (const f of LAMMA_IMAGE_FILES) expect(f).not.toMatch(/logo|brand/i);
  });
  it('the maker is a fictional cook, never a real client or person', () => {
    const doc = buildLammaHome(base, { img: (f: string) => f });
    const maker = doc.sections.find((s: { type: string }) => s.type === 'maker-profile');
    expect(maker.settings.nameAr).toBe('أم سلمى');
    expect(JSON.stringify(maker.settings)).not.toMatch(
      /om hassan|da gusto|al assriya|أم حسن|دا جوستو/i
    );
    // PREMIUM-36: real copy, no placeholder tag and no invented licence or certificate claim
    expect(maker.settings.hygieneAr).not.toMatch(/نص توضيحي|شهادة|مرخّص/);
    expect(maker.settings.hygiene).not.toMatch(/demo text|certificate|licensed/i);
  });
});

describe('lamma demo catalogue: store settings (Ruling B4-7)', () => {
  const spec = TEMPLATE_SPECS.lamma;
  it('Family table is the default look; food delivers same day, every day', () => {
    expect(getLook(spec.defaultLook)?.id).toBe('lamma.table');
    expect(spec.deliveryDays).toEqual({ min: 0, max: 1 });
    expect(spec.storeSettings.deliveryOffDays).toEqual([]);
  });
  it('minimum order 150 EGP (15,000 piastres), date chips 5 days ahead with two windows that have cut-offs', () => {
    expect(spec.storeSettings.minimumOrderFils).toBe(15_000);
    const cd = spec.storeSettings.checkoutDelivery;
    expect(cd.daysAhead).toBe(5);
    expect(cd.windows.enabled).toBe(true);
    expect(cd.windows.items.map((w: { id: string }) => w.id)).toEqual(['lunch', 'dinner']);
    for (const w of cd.windows.items) expect(w.orderBy, w.id).toBeTruthy();
  });
  it('the demo settings really offer five delivery dates with both windows on a Thursday morning', () => {
    const cd = spec.storeSettings.checkoutDelivery;
    const choices = deliveryDateChoices({
      now: new Date('2026-10-22T08:00:00+03:00'),
      offDays: spec.storeSettings.deliveryOffDays,
      windows: cd.windows.items,
      daysAhead: cd.daysAhead,
      estimateDays: spec.deliveryDays.min,
    });
    expect(choices.map(c => c.date)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
  });
  it('a Greater Cairo zone at 35 EGP, 0 to 1 days', () => {
    expect(spec.zone).toEqual({ deliveryFee: 3_500, estimatedDaysMin: 0, estimatedDaysMax: 1 });
  });
  it('the delivery-time line is merchant text in the announcement bar, marked as a demo (Ruling B4-12)', () => {
    expect(spec.announcement.textAr).toBe('التوصيل خلال 45 دقيقة (ده متجر تجريبي)');
  });
  it('no instalments (a food shop sells no instalments)', () => {
    expect(spec.instalments).toBeNull();
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
  buildLammaHome(base, { img: (f: string) => `/__lamma-demo/${f}`, productIdBySlug: ids });

describe('lamma demo catalogue: images and the home document', () => {
  it('every image the catalogue names exists in assets/', () => {
    for (const f of LAMMA_IMAGE_FILES) expect(existsSync(path.join(assets, f)), f).toBe(true);
  });
  it('the home document is a valid superset: one hero, tagged sections per look, the shared ones untagged', () => {
    const doc = build();
    expect(doc.sections.map((s: { type: string }) => s.type)).toEqual([
      'hero',
      'category-grid',
      'maker-profile',
      'product-carousel',
      'featured-collection',
      'featured-collection',
      'featured-collection',
      'product-carousel',
      'brand-story',
      'trust-strip',
    ]);
    expect(
      doc.sections
        .filter((s: { lookTag?: string }) => s.lookTag)
        .map((s: { id: string; lookTag: string }) => `${s.id}:${s.lookTag}`)
    ).toEqual([
      'hero-table:lamma.table',
      'menu:lamma.table',
      'from-the-kitchen:lamma.notebook',
      'fresh-today:lamma.market',
      'deals:lamma.market',
    ]);
  });
  for (const id of ['lamma.table', 'lamma.notebook', 'lamma.market']) {
    it(`${id}: the superset renders through the look's mix, validates, and shows only its own sections`, () => {
      const look = getLook(id)!;
      const rendered = applyTemplateFamily(build() as PageDefinition, 'lamma', look);
      const v = validateDefinitionSync(rendered);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      expect(rendered.sections.map(s => s.type).slice(0, look.sections!.length)).toEqual(
        look.sections!.map(s => s.type)
      );
      // exactly the look's own tagged sections survive: none belongs to another look
      for (const s of rendered.sections)
        expect(s.lookTag === undefined || s.lookTag === id, `${s.id} ${s.lookTag}`).toBe(true);
    });
  }
  it('Table shows the menu with 24 dishes; Notebook the 8-dish grid; Market the 24-dish fresh grid and the deals row', () => {
    const limitOf = (id: string, type: string, nth = 0) =>
      applyTemplateFamily(build() as PageDefinition, 'lamma', getLook(id)!).sections.filter(
        s => s.type === type
      )[nth]?.settings;
    expect(limitOf('lamma.table', 'featured-collection')).toMatchObject({
      limit: 24,
      layout: 'menu',
    });
    expect(limitOf('lamma.notebook', 'featured-collection')).toMatchObject({ limit: 8 });
    expect(limitOf('lamma.market', 'featured-collection')).toMatchObject({ limit: 24 });
    expect(limitOf('lamma.market', 'product-carousel', 1)).toMatchObject({
      productSource: 'on_sale',
    });
    expect(limitOf('lamma.table', 'product-carousel')).toMatchObject({ productSource: 'reorder' });
  });
  it('Notebook has no hero, Table has its own, Market has tiles with the aisle tint', () => {
    const types = (id: string) =>
      applyTemplateFamily(build() as PageDefinition, 'lamma', getLook(id)!).sections.map(
        s => s.type
      );
    expect(types('lamma.notebook')).not.toContain('hero');
    expect(types('lamma.table')).toContain('hero');
    const market = applyTemplateFamily(
      build() as PageDefinition,
      'lamma',
      getLook('lamma.market')!
    );
    expect(market.sections.find(s => s.type === 'category-grid')!.settings).toMatchObject({
      layout: 'tiles',
      tint: 'aisles',
    });
  });
});
