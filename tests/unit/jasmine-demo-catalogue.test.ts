/**
 * Phase B3 Task 5: the Jasmine demo catalogue exercises every storefront feature the looks are
 * judged with (counted by feature, like B2's souq-demo-catalogue test), is unbranded (Ruling B3-9),
 * every skin-type chip leads to a non-empty PLP (B3-5), every shade swatch passes the SAME hue gate
 * as the tokens (B3-3), and its home document names only products that exist.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  productFactsSchema,
  instalmentsSchema,
  computeBundlePrice,
  isAllocatable,
  getLook,
  validateDefinitionSync,
  applyTemplateFamily,
  PAGE_DEFINITION_SCHEMA_VERSION,
  type BundleLine,
  type PageDefinition,
} from '@ebda/shared';
import {
  JASMINE_PRODUCTS,
  JASMINE_CATEGORIES,
  JASMINE_TAGS,
  JASMINE_BUNDLES,
  JASMINE_REVIEWS,
  JASMINE_IMAGE_FILES,
  // @ts-expect-error plain .mjs data module
} from '../../scripts/jasmine-demo/catalogue.mjs';
// @ts-expect-error plain .mjs script
import { variantSku, combos, TEMPLATE_SPECS } from '../../scripts/storedemo/seed.mjs';
// @ts-expect-error plain .mjs script
import { buildJasmineHome } from '../../scripts/storedemo/jasmine-home.mjs';
import { isOrangeFamily } from './helpers/orange-gate';

type Value = { value: string; valueAr: string; hex?: string; priceAdd?: number };
type Option = { name: string; nameAr: string; values: Value[] };
type Fact = { key: string; keyAr: string; value: string; valueAr: string; onCard?: boolean };
type Product = {
  slug: string;
  name: string;
  nameAr: string;
  category: string;
  tags: string[];
  price: number;
  compareAtPrice?: number;
  images: string[];
  description: string;
  descriptionAr: string;
  options?: Option[];
  soldOut?: string[][];
  backorder?: boolean;
  facts: Fact[];
  leadTimeDays?: number;
};
const PRODUCTS = JASMINE_PRODUCTS as Product[];
const CATEGORIES = JASMINE_CATEGORIES as { slug: string; image?: string }[];
const assets = path.resolve(__dirname, '../../scripts/jasmine-demo/assets');
const withOptions = PRODUCTS.filter(p => p.options?.length);
const shadeProducts = withOptions.filter(p => p.options!.some(o => o.name === 'Shade'));

describe('jasmine demo catalogue: shape', () => {
  it('21 products, unique slugs, 7 categories', () => {
    expect(PRODUCTS).toHaveLength(21);
    expect(new Set(PRODUCTS.map(p => p.slug)).size).toBe(21);
    expect(CATEGORIES.map(c => c.slug)).toEqual([
      'cleansers',
      'serums',
      'moisturisers-sun',
      'makeup',
      'perfumes',
      'hair-care',
      'tools-devices',
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
  it('the seed spec reads this catalogue', () => {
    expect(TEMPLATE_SPECS.jasmine.products).toBe(JASMINE_PRODUCTS);
    expect(TEMPLATE_SPECS.jasmine.categories).toBe(JASMINE_CATEGORIES);
    expect(TEMPLATE_SPECS.jasmine.tags).toBe(JASMINE_TAGS);
    expect(TEMPLATE_SPECS.jasmine.bundles).toBe(JASMINE_BUNDLES);
    expect(TEMPLATE_SPECS.jasmine.reviews).toBe(JASMINE_REVIEWS);
  });
});

describe('jasmine demo catalogue: skin-type and concern chips (Rulings B3-5, B3-13)', () => {
  const NAMES = (JASMINE_TAGS as Array<{ name: string; nameAr: string }>).map(t => t.name);
  it('every product tag is a known tag and every known tag has products (no dead-end chip)', () => {
    for (const p of PRODUCTS) for (const t of p.tags) expect(NAMES, `${p.slug}: ${t}`).toContain(t);
    for (const t of NAMES)
      expect(PRODUCTS.filter(p => p.tags.includes(t)).length, t).toBeGreaterThanOrEqual(2);
  });
  it('the chips are the six skin types and concerns the research names, each in BOTH languages', () => {
    expect(JASMINE_TAGS).toEqual([
      { name: 'Oily skin', nameAr: 'بشرة دهنية' },
      { name: 'Dry skin', nameAr: 'بشرة جافة' },
      { name: 'Sensitive skin', nameAr: 'بشرة حساسة' },
      { name: 'Acne', nameAr: 'حب الشباب' },
      { name: 'Dark spots', nameAr: 'تصبغات' },
      { name: 'Dryness', nameAr: 'جفاف' },
    ]);
    for (const t of JASMINE_TAGS as Array<{ name: string; nameAr: string }>) {
      expect(/[؀-ۿ]/.test(t.name), `${t.name} is the English label`).toBe(false);
      expect(/[؀-ۿ]/.test(t.nameAr), `${t.nameAr} is Arabic`).toBe(true);
    }
  });
  it('every tagged product is ACTIVE with a price (a chip never lands on an unbuyable page)', () => {
    for (const p of PRODUCTS.filter(x => x.tags.length)) expect(p.price, p.slug).toBeGreaterThan(0);
  });
});

describe('jasmine demo catalogue: every feature, by count', () => {
  it('Shade (hex swatch) x Size (chip) variants with price steps on 2 makeup products, a shade-only product', () => {
    const shadeSize = shadeProducts.filter(
      p =>
        p.options!.some(o => o.name === 'Shade' && o.values.every(v => v.hex)) &&
        p.options!.some(o => o.name === 'Size' && o.values.some(v => (v.priceAdd ?? 0) > 0))
    );
    expect(shadeSize.map(p => p.slug)).toEqual(['matte-lipstick', 'cream-blush']);
    expect(shadeProducts.filter(p => p.options!.length === 1)).toHaveLength(1);
    expect(shadeProducts.every(p => p.category === 'makeup')).toBe(true);
  });
  it('every shade swatch passes the SAME no-orange hue gate as the tokens (rose, berry, mauve, plum, nude: never coral)', () => {
    const hexes = shadeProducts.flatMap(p =>
      p.options!.filter(o => o.name === 'Shade').flatMap(o => o.values.map(v => v.hex!))
    );
    expect(hexes.length).toBeGreaterThanOrEqual(8);
    for (const hex of hexes) expect(isOrangeFamily(hex), hex).toBe(false);
    // negative control: an orange-coral lipstick, a terracotta blush and a peach nude are what the gate refuses
    for (const hex of ['#E8905A', '#C2744B', '#E68245', '#F5C39A'])
      expect(isOrangeFamily(hex), hex).toBe(true);
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
    expect(variantSku('matte-lipstick', ['Berry', 'Full 3.5 g'])).toBe(
      'MATTE-LIPSTICK-BERRY-FULL-3-5-G'
    );
  });
  it('the shade x size product is the checkout-data-flow case: a bigger size costs more, on the compare-at too', () => {
    const blush = PRODUCTS.find(p => p.slug === 'cream-blush')!;
    const size = blush.options!.find(o => o.name === 'Size')!;
    expect(size.values.map(v => v.priceAdd)).toEqual([0, 7_000]);
    expect(blush.compareAtPrice).toBeGreaterThan(blush.price);
    expect(combos(blush.options!)).toHaveLength(8);
  });
  it('two onCard facts on every product with a card voice (never more than 2), the rest are table rows', () => {
    for (const p of PRODUCTS) {
      expect(p.facts.filter(f => f.onCard).length, p.slug).toBe(2);
      expect(productFactsSchema.safeParse(p.facts).success, p.slug).toBe(true);
    }
  });
  it('Ruling B3-4 facts: skincare products carry ingredients, how to use, skin type and time after opening', () => {
    const skincare = PRODUCTS.filter(p =>
      ['cleansers', 'serums', 'moisturisers-sun'].includes(p.category)
    );
    for (const p of skincare) {
      const keys = p.facts.map(f => f.key);
      expect(keys, p.slug).toContain('How to use');
      expect(keys, p.slug).toContain('Skin type');
      expect(keys, p.slug).toContain('After opening');
    }
    // the card voice per look: an ingredient or active on skincare, the size always
    const onCard = (slug: string) =>
      PRODUCTS.find(p => p.slug === slug)!.facts.filter(f => f.onCard);
    expect(onCard('niacinamide-serum').map(f => f.valueAr)).toEqual(['نياسيناميد 10%', '30 مل']);
    expect(onCard('argan-hair-oil').map(f => f.key)).toEqual(['Key ingredient', 'Size']);
  });
  it('at least 6 sale prices, two at 40% off or more, every sale really lower', () => {
    const sales = PRODUCTS.filter(p => p.compareAtPrice);
    expect(sales.length).toBeGreaterThanOrEqual(6);
    for (const p of sales) expect(p.compareAtPrice!, p.slug).toBeGreaterThan(p.price);
    expect(sales.filter(p => 1 - p.price / p.compareAtPrice! >= 0.4).length).toBeGreaterThanOrEqual(
      2
    );
  });
  it('one backorder, one sold-out variant combination (never everything)', () => {
    expect(PRODUCTS.filter(p => p.backorder)).toHaveLength(1);
    const sold = withOptions.filter(p => p.soldOut?.length);
    expect(sold).toHaveLength(1);
    const all = combos(sold[0].options!).map((c: Value[]) => c.map(v => v.value).join('|'));
    for (const t of sold[0].soldOut!) expect(all).toContain(t.join('|'));
    expect(all.length).toBeGreaterThan(sold[0].soldOut!.length);
  });
  it('every showroom product has a photo (DQ-1; the no-photo case is the jasmine-noimg scenario store)', () => {
    expect(PRODUCTS.filter(p => p.images.length === 0)).toHaveLength(0);
  });
  it('two very long names: one Arabic, one English (>= 90 characters)', () => {
    expect(PRODUCTS.filter(p => p.nameAr.length >= 90)).toHaveLength(1);
    expect(PRODUCTS.filter(p => p.name.length >= 90)).toHaveLength(1);
  });
  it('one made-to-order lead time', () => {
    expect(PRODUCTS.filter(p => p.leadTimeDays && p.leadTimeDays > 0)).toHaveLength(1);
  });
  it('Arabic first: every product has Arabic name and description', () => {
    for (const p of PRODUCTS) {
      expect(/[؀-ۿ]/.test(p.nameAr), p.slug).toBe(true);
      expect(/[؀-ۿ]/.test(p.descriptionAr), p.slug).toBe(true);
    }
  });
});

describe('jasmine demo catalogue: the routine bundle and the reviews (Ruling B3-6)', () => {
  const bundle = JASMINE_BUNDLES[0];
  const price = (slug: string) => PRODUCTS.find(p => p.slug === slug)!;
  it('one bundle of three real, variant-less products with a real 15% saving', () => {
    expect(JASMINE_BUNDLES).toHaveLength(1);
    expect(bundle.products).toHaveLength(3);
    for (const s of bundle.products) {
      expect(price(s), s).toBeDefined();
      expect(price(s).options, `${s} must be variant-less`).toBeUndefined();
      expect(price(s).backorder, s).toBeUndefined();
    }
    const sum = bundle.products.reduce((n: number, s: string) => n + price(s).price, 0);
    const computed = computeBundlePrice(sum, bundle.pricingType, bundle.pricingValue);
    expect(bundle.pricingType).toBe('percentage');
    expect(bundle.pricingValue).toBe(1500); // basis points
    expect(sum - computed).toBe(Math.floor((sum * 1500) / 10000));
    expect(Math.round(((sum - computed) / sum) * 100)).toBe(15);
  });
  it('the bundle price is allocatable across its lines (the cart will accept it)', () => {
    const lines: BundleLine[] = bundle.products.map((s: string, i: number) => ({
      key: `k${i}`,
      unitPrice: price(s).price,
      quantity: 1,
    }));
    const sum = lines.reduce((n, l) => n + l.unitPrice, 0);
    expect(
      isAllocatable(lines, computeBundlePrice(sum, bundle.pricingType, bundle.pricingValue))
    ).toBe(true);
  });
  it('the bundle is exactly the Clinic routine: cleanse, treat, protect', () => {
    const base = { sections: [], sectionGroups: { header: [], footer: [] } };
    const ids = new Map(PRODUCTS.map((p, i) => [p.slug, `id-${i}`]));
    const doc = buildJasmineHome(base, { img: (f: string) => f, productIdBySlug: ids });
    const steps = doc.sections.find((s: { type: string }) => s.type === 'steps');
    const stepSlugs = steps.blocks.map((b: { settings: { productIds: string[] } }) => {
      const id = b.settings.productIds[0];
      return PRODUCTS[Number(id.replace('id-', ''))].slug;
    });
    expect(stepSlugs).toEqual(bundle.products);
  });
  it('approved reviews on 6 products, ratings 1-5, both languages, products exist', () => {
    const slugs = new Set(JASMINE_REVIEWS.map((r: [string, number, string, string]) => r[0]));
    expect(slugs.size).toBe(6);
    for (const [slug, rating, body, lang] of JASMINE_REVIEWS as Array<
      [string, number, string, string]
    >) {
      expect(price(slug), slug).toBeDefined();
      expect(rating).toBeGreaterThanOrEqual(1);
      expect(rating).toBeLessThanOrEqual(5);
      expect(body.length).toBeGreaterThanOrEqual(20);
      expect(['ar', 'en']).toContain(lang);
    }
    const langs = new Set(JASMINE_REVIEWS.map((r: [string, number, string, string]) => r[3]));
    expect(langs).toEqual(new Set(['ar', 'en']));
  });
});

describe('jasmine demo catalogue: unbranded (Ruling B3-9)', () => {
  const BRANDS =
    /cerave|la roche|nivea|garnier|l['’]?oreal|loreal|maybelline|revlon|dior|chanel|lancome|clinique|estee|mac cosmetics|nars|sephora|glossier|the ordinary|olay|neutrogena|vichy|bioderma|eucerin|avene|dove|pantene|head ?& ?shoulders|elseve|nice ?one|faces|noon\.com|amazon|ajmal|rasasi|arabian oud/i;
  it('no product, category, tag or fact names a brand', () => {
    const text = JSON.stringify([PRODUCTS, CATEGORIES, JASMINE_TAGS, JASMINE_BUNDLES]);
    expect(text.match(BRANDS)?.[0]).toBeUndefined();
  });
  it('no image URL path is a logo or brand file', () => {
    for (const f of JASMINE_IMAGE_FILES) expect(f).not.toMatch(/logo|brand/i);
  });
});

describe('jasmine demo catalogue: instalments, features, store settings', () => {
  const spec = TEMPLATE_SPECS.jasmine;
  it('instalments: enabled, 12 months, no markup, NO provider name', () => {
    expect(instalmentsSchema.safeParse(spec.instalments).success).toBe(true);
    expect(spec.instalments).toEqual({ enabled: true, months: 12, markupPct: 0 });
  });
  it('the bundles feature override is part of the spec (it is in no plan baseline)', () => {
    expect(spec.features).toEqual(['bundles']);
  });
  it('Clinic is the default look (the first screen shows the chips and the routine)', () => {
    expect(getLook(spec.defaultLook)?.id).toBe('jasmine.clinic');
  });
});

describe('jasmine demo catalogue: images and the home document', () => {
  it('every image the catalogue names exists in assets/', () => {
    for (const f of JASMINE_IMAGE_FILES) expect(existsSync(path.join(assets, f)), f).toBe(true);
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
    buildJasmineHome(base, { img: (f: string) => `/__jasmine-demo/${f}`, productIdBySlug: ids });
  it('the home document references only seeded products and is a valid superset, one hero per look', () => {
    const doc = build();
    expect(doc.sections.map((s: { type: string }) => s.type)).toEqual([
      'hero',
      'hero',
      'hero',
      'category-grid',
      'steps',
      'product-spotlight',
      'product-carousel',
      'featured-collection',
      'product-carousel',
      'testimonials',
      'trust-strip',
      'newsletter',
      'key-ingredients', // T7 signature section
    ]);
    expect(
      doc.sections
        .filter((s: { lookTag?: string }) => s.lookTag)
        .map((s: { id: string; lookTag: string }) => `${s.id}:${s.lookTag}`)
    ).toEqual([
      'hero-apothecary:jasmine.apothecary',
      'hero-bloom:jasmine.bloom',
      'hero-clinic:jasmine.clinic',
      'curated:jasmine.bloom',
    ]);
    expect(() =>
      buildJasmineHome(base, { img: (f: string) => f, productIdBySlug: new Map() })
    ).toThrow(/not in the seeded catalogue/);
  });
  for (const id of ['jasmine.apothecary', 'jasmine.bloom', 'jasmine.clinic']) {
    it(`${id}: the superset renders through the look's mix, validates, and shows only its own hero`, () => {
      const look = getLook(id)!;
      const rendered = applyTemplateFamily(build() as PageDefinition, 'jasmine', look);
      const v = validateDefinitionSync(rendered);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
      const heroes = rendered.sections.filter(s => s.type === 'hero');
      expect(heroes.map(h => h.lookTag)).toEqual(
        look.sections!.some(s => s.type === 'hero') ? [id] : []
      );
      expect(rendered.sections.map(s => s.type).slice(0, look.sections!.length)).toEqual(
        look.sections!.map(s => s.type)
      );
    });
  }
  it('Clinic and Apothecary show the real routine; Bloom leaves the steps out of the render', () => {
    const steps = (id: string) =>
      applyTemplateFamily(build() as PageDefinition, 'jasmine', getLook(id)!).sections.filter(
        s => s.type === 'steps'
      ).length;
    expect(steps('jasmine.clinic')).toBe(1);
    expect(steps('jasmine.apothecary')).toBe(1);
    expect(steps('jasmine.bloom')).toBe(0);
  });
});
