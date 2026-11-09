/**
 * Phase B2 Task 6: the Souq demo catalogue exercises every storefront feature the looks are judged
 * with (counted by feature, like B1's qamar-demo-catalogue test), is unbranded (Ruling B2-10) and
 * its home document names only products that exist.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { productFactsSchema, instalmentsSchema, resolveInstalment } from '@ebda/shared';
import {
  SOUQ_PRODUCTS,
  SOUQ_CATEGORIES,
  SOUQ_IMAGE_FILES,
  // @ts-expect-error plain .mjs data module
} from '../../scripts/souq-demo/catalogue.mjs';
// @ts-expect-error plain .mjs script
import { variantSku, combos, TEMPLATE_SPECS } from '../../scripts/storedemo/seed.mjs';
// @ts-expect-error plain .mjs script
import { buildSouqHome } from '../../scripts/storedemo/souq-home.mjs';

type Value = { value: string; valueAr: string; hex?: string; priceAdd?: number };
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
  facts: Fact[];
  leadTimeDays?: number;
};
const PRODUCTS = SOUQ_PRODUCTS as Product[];
const CATEGORIES = SOUQ_CATEGORIES as { slug: string; image?: string }[];
const assets = path.resolve(__dirname, '../../scripts/souq-demo/assets');

describe('souq demo catalogue: shape', () => {
  it('19 products, unique slugs, 7 categories', () => {
    expect(PRODUCTS).toHaveLength(19);
    expect(new Set(PRODUCTS.map(p => p.slug)).size).toBe(19);
    expect(CATEGORIES.map(c => c.slug)).toEqual([
      'phones',
      'laptops',
      'audio',
      'watches',
      'tv',
      'appliances',
      'accessories',
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
    expect(TEMPLATE_SPECS.souq.products).toBe(SOUQ_PRODUCTS);
    expect(TEMPLATE_SPECS.souq.categories).toBe(SOUQ_CATEGORIES);
  });
});

describe('souq demo catalogue: every feature, by count', () => {
  const withOptions = PRODUCTS.filter(p => p.options?.length);
  it('Colour (hex swatch) x Storage (chip) variants with price steps on 4 products', () => {
    const colourStorage = withOptions.filter(
      p =>
        p.options!.some(o => o.name === 'Colour' && o.values.every(v => v.hex)) &&
        p.options!.some(o => o.name === 'Storage' && o.values.some(v => (v.priceAdd ?? 0) > 0))
    );
    expect(colourStorage).toHaveLength(4);
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
    expect(variantSku('smartphone-6-7', ['Black', '512GB'])).toBe('SMARTPHONE-6-7-BLACK-512GB');
  });
  it('a variant price step is a real step (a bigger storage costs more, the same on the compare-at price)', () => {
    const phone = PRODUCTS.find(p => p.slug === 'smartphone-6-7')!;
    const storage = phone.options!.find(o => o.name === 'Storage')!;
    expect(storage.values.map(v => v.priceAdd)).toEqual([0, 400_000, 1_000_000]);
    expect(phone.compareAtPrice).toBeGreaterThan(phone.price);
  });
  it('two onCard facts on EVERY product, plus a warranty and a condition row', () => {
    for (const p of PRODUCTS) {
      expect(
        p.facts.filter(f => f.onCard),
        p.slug
      ).toHaveLength(2);
      expect(
        p.facts.some(f => f.key === 'Warranty'),
        p.slug
      ).toBe(true);
      expect(
        p.facts.some(f => f.key === 'Condition'),
        p.slug
      ).toBe(true);
      expect(productFactsSchema.safeParse(p.facts).success, p.slug).toBe(true);
    }
  });
  it('one refurbished (مجدّد) and one used in excellent condition (مستعمل بحالة ممتازة)', () => {
    const cond = (v: string) =>
      PRODUCTS.filter(p => p.facts.some(f => f.key === 'Condition' && f.valueAr === v));
    expect(cond('مجدّد')).toHaveLength(1);
    expect(cond('مستعمل بحالة ممتازة')).toHaveLength(1);
    expect(cond('جديد')).toHaveLength(17);
  });
  it('at least 6 sale prices, one at 40% off or more, every sale really lower', () => {
    const sales = PRODUCTS.filter(p => p.compareAtPrice);
    expect(sales.length).toBeGreaterThanOrEqual(6);
    for (const p of sales) expect(p.compareAtPrice!, p.slug).toBeGreaterThan(p.price);
    expect(sales.some(p => 1 - p.price / p.compareAtPrice! >= 0.4)).toBe(true);
  });
  it('one backorder, one sold-out variant combination', () => {
    expect(PRODUCTS.filter(p => p.backorder)).toHaveLength(1);
    const sold = withOptions.filter(p => p.soldOut?.length);
    expect(sold).toHaveLength(1);
    const all = combos(sold[0].options!).map((c: Value[]) => c.map(v => v.value).join('|'));
    for (const t of sold[0].soldOut!) expect(all).toContain(t.join('|'));
    expect(all.length).toBeGreaterThan(sold[0].soldOut!.length); // never everything
  });
  it('every showroom product has a photo (DQ-1; the no-photo case is the souq-noimg scenario store)', () => {
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

describe('souq demo catalogue: unbranded (Ruling B2-10)', () => {
  const BRANDS =
    /samsung|apple|iphone|ipad|macbook|huawei|xiaomi|oppo|realme|sony|lg\b|philips|bosch|beko|panasonic|toshiba|\bsharp (tv|aquos)|hp\b|dell|lenovo|asus|acer|jbl|anker|nokia|\bfresh\b|tornado|b\.tech|\bnoon\b|amazon/i;
  it('no product, category or fact names a brand or model', () => {
    const text = JSON.stringify([PRODUCTS, CATEGORIES]);
    // the matched word only (a failure must not dump the whole catalogue)
    expect(text.match(BRANDS)?.[0]).toBeUndefined();
  });
  it('no image URL path is a logo or brand file', () => {
    for (const f of SOUQ_IMAGE_FILES) expect(f).not.toMatch(/logo|brand/i);
  });
});

describe('souq demo catalogue: instalments (Ruling B2-9)', () => {
  const inst = TEMPLATE_SPECS.souq.instalments;
  it('enabled, 12 months, no markup, NO provider name', () => {
    expect(instalmentsSchema.safeParse(inst).success).toBe(true);
    expect(inst).toEqual({ enabled: true, months: 12, markupPct: 0 });
  });
  it('the phone resolves a monthly figure through the shared helper', () => {
    const phone = PRODUCTS.find(p => p.slug === 'smartphone-6-7')!;
    const r = resolveInstalment(inst, phone.price, true)!;
    expect(r.monthly).toBe(Math.ceil(phone.price / 12));
    expect(r.providerEn).toBeUndefined();
  });
  it('the other template does not get the key', () => {
    expect(TEMPLATE_SPECS.qamar.instalments).toBeNull();
  });
});

describe('souq demo catalogue: images and the home document', () => {
  it('every image the catalogue names exists in assets/', () => {
    for (const f of SOUQ_IMAGE_FILES) expect(existsSync(path.join(assets, f)), f).toBe(true);
  });
  it('the home document references only seeded products and is a valid superset', () => {
    const ids = new Map(PRODUCTS.map((p, i) => [p.slug, `id-${i}`]));
    const base = { sections: [], sectionGroups: { header: [], footer: [] } };
    const doc = buildSouqHome(base, {
      img: (f: string) => `/__souq-demo/${f}`,
      productIdBySlug: ids,
    });
    const types = doc.sections.map((s: { type: string }) => s.type);
    expect(types).toEqual([
      'hero',
      'product-spotlight', // Night's own single featured stage (tagged), STOP-2
      'category-grid',
      'product-carousel',
      'product-carousel',
      'featured-collection',
      'product-spotlight',
      'product-spotlight',
      'product-spotlight',
      'collection-list',
      'trust-strip',
      'newsletter',
      'brand-story',
      'spec-sheet', // T7 signature section
    ]);
    // one hero, Night's stage and the curated row are tagged Night; the Showroom's three stages are
    // tagged Showroom, so Catalogue shows only deals and Night shows exactly one stage
    expect(
      doc.sections
        .filter((s: { lookTag?: string }) => s.lookTag)
        .map((s: { id: string; lookTag: string }) => `${s.id}:${s.lookTag}`)
    ).toEqual([
      'hero-night:souq.night',
      'night-pick:souq.night',
      'curated:souq.night',
      'stage-1:souq.showroom',
      'stage-2:souq.showroom',
      'stage-3:souq.showroom',
    ]);
    // the three Showroom stages are three DIFFERENT products
    const stageIds = doc.sections
      .filter((s: { id: string }) => /^stage-/.test(s.id))
      .map((s: { settings: { manualProductIds: string[] } }) => s.settings.manualProductIds[0]);
    expect(new Set(stageIds).size).toBe(3);
    // a missing product fails loudly rather than rendering a blank
    expect(() =>
      buildSouqHome(base, { img: (f: string) => f, productIdBySlug: new Map() })
    ).toThrow(/not in the seeded catalogue/);
  });
});
