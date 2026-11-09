import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { productFactsSchema, personalisationConfigSchema, sizeChartSchema } from '@ebda/shared';
// @ts-expect-error plain .mjs script
import { variantSku, combos } from '../../scripts/storedemo/seed.mjs';
import {
  QAMAR_PRODUCTS,
  QAMAR_CATEGORIES,
  QAMAR_SIZE_CHARTS,
  QAMAR_LOOKS_STORY,
  QAMAR_OCCASIONS,
  ASSET_FILES,
  // @ts-expect-error plain .mjs data module
} from '../../scripts/qamar-demo/catalogue.mjs';

type Value = { value: string; valueAr: string; hex?: string; image?: string };
type Option = { name: string; nameAr: string; values: Value[] };
type Fact = { key: string; keyAr: string; value: string; valueAr: string; onCard?: boolean };
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
  facts?: Fact[];
  leadTimeDays?: number;
  personalisation?: { label: string; labelAr: string; maxLength: number; required: boolean };
};
const PRODUCTS = QAMAR_PRODUCTS as Product[];
const CATEGORIES = QAMAR_CATEGORIES as { slug: string; sizeChart?: string }[];

const assets = path.resolve(__dirname, '../../scripts/qamar-demo/assets');
const KB = 1024;

describe('qamar demo catalogue exercises every B0 feature', () => {
  const opts = PRODUCTS.flatMap(p => p.options ?? []);
  it('17 products, unique slugs', () => {
    expect(PRODUCTS).toHaveLength(17);
    expect(new Set(PRODUCTS.map(p => p.slug)).size).toBe(PRODUCTS.length);
  });
  it('colour hex swatch', () => expect(opts.some(o => o.values.some(v => v.hex))).toBe(true));
  it('image swatch', () => expect(opts.some(o => o.values.some(v => v.image))).toBe(true));
  it('more than 5 swatches on one product (+N)', () =>
    expect(
      PRODUCTS.some(p =>
        (p.options ?? []).some(o => o.values.filter(v => v.hex || v.image).length > 5)
      )
    ).toBe(true));
  it('Size × Length with a struck-out combo', () =>
    expect(PRODUCTS.some(p => (p.options?.length ?? 0) >= 3 && (p.soldOut?.length ?? 0) > 0)).toBe(
      true
    ));
  it('every sold-out tuple names real option values, one per option', () => {
    for (const p of PRODUCTS)
      for (const t of p.soldOut ?? []) {
        expect(t.length, p.slug).toBe(p.options?.length);
        t.forEach((v, i) =>
          expect(
            p.options![i].values.map(x => x.value),
            p.slug
          ).toContain(v)
        );
      }
  });
  it('facts with ≤ 2 on card, valid under the shared schema', () => {
    expect(PRODUCTS.some(p => (p.facts?.length ?? 0) > 0)).toBe(true);
    for (const p of PRODUCTS) {
      expect((p.facts ?? []).filter(f => f.onCard).length).toBeLessThanOrEqual(2);
      expect(productFactsSchema.safeParse(p.facts ?? []).success, p.slug).toBe(true);
    }
  });
  it('lead time', () => expect(PRODUCTS.some(p => (p.leadTimeDays ?? 0) > 0)).toBe(true));
  it('personalisation, valid once enabled (C17)', () => {
    const withP = PRODUCTS.filter(p => p.personalisation);
    expect(withP.length).toBeGreaterThan(0);
    for (const p of withP)
      expect(
        personalisationConfigSchema.safeParse({ enabled: true, ...p.personalisation }).success,
        p.slug
      ).toBe(true);
  });
  it('size chart linked by category, every chart valid', () => {
    expect(CATEGORIES.some(c => c.sizeChart)).toBe(true);
    for (const c of CATEGORIES.filter(x => x.sizeChart)) {
      const chart = (QAMAR_SIZE_CHARTS as Record<string, unknown>)[c.sizeChart!];
      expect(sizeChartSchema.safeParse(chart).success, c.slug).toBe(true);
    }
  });
  it('sale, backorder, no-image, long names', () => {
    expect(PRODUCTS.some(p => p.compareAtPrice && p.compareAtPrice > p.price)).toBe(true);
    expect(PRODUCTS.some(p => p.backorder)).toBe(true);
    expect(PRODUCTS.some(p => p.images.length === 0)).toBe(false); // DQ-1: the no-photo case is a scenario store
    expect(PRODUCTS.some(p => p.nameAr.length >= 60)).toBe(true);
    expect(PRODUCTS.some(p => p.name.length >= 60)).toBe(true);
  });
  it('every product is bilingual, priced in piastres, in a known category', () => {
    const slugs = new Set(CATEGORIES.map(c => c.slug));
    for (const p of PRODUCTS) {
      expect(p.name && p.nameAr && p.description && p.descriptionAr, p.slug).toBeTruthy();
      expect(Number.isInteger(p.price) && p.price >= 10000, p.slug).toBe(true);
      for (const c of [p.category, ...(p.alsoIn ?? [])])
        expect(slugs.has(c), `${p.slug} ${c}`).toBe(true);
    }
  });
  it("variant SKUs from full value slugs never collide (C17, the seed's own functions)", () => {
    for (const p of PRODUCTS) {
      if (!p.options) continue;
      const skus = (combos(p.options) as Value[][]).map(c =>
        variantSku(
          p.slug,
          c.map(v => v.value)
        )
      );
      expect(new Set(skus).size, p.slug).toBe(skus.length);
    }
  });
  it('shop-the-look and occasion data point at real products and categories', () => {
    const products = new Set(PRODUCTS.map(p => p.slug));
    for (const l of QAMAR_LOOKS_STORY as { items: string[] }[])
      for (const s of l.items) expect(products.has(s), s).toBe(true);
    const cats = new Set(CATEGORIES.map(c => c.slug));
    for (const o of QAMAR_OCCASIONS as { slug: string }[])
      expect(cats.has(o.slug), o.slug).toBe(true);
  });
});

describe('qamar demo assets (Ruling B1-9 as amended by C18)', () => {
  it('every referenced file exists, is webp/mp4 and within budget', () => {
    let total = 0;
    for (const f of ASSET_FILES as string[]) {
      const p = path.join(assets, f);
      expect(existsSync(p), f).toBe(true);
      expect(/\.(webp|mp4)$/.test(f), f).toBe(true);
      const size = statSync(p).size;
      total += size;
      if (f.endsWith('.webp'))
        expect(size, f).toBeLessThanOrEqual(/-2k\.webp$/.test(f) ? 400 * KB : 140 * KB);
      if (f.endsWith('.mp4')) expect(size, f).toBeLessThanOrEqual(3 * KB * KB);
    }
    expect(total).toBeLessThanOrEqual(7 * KB * KB);
  });
  it('no unreferenced file is committed (no hero.webm, C18)', () => {
    const onDisk = readdirSync(assets).filter(f => !f.startsWith('.'));
    expect(onDisk.sort()).toEqual([...new Set(ASSET_FILES as string[])].sort());
    expect(onDisk).not.toContain('hero.webm');
  });
});

// W2b (S-02 per look): the shared PDP trust line (`components/commerce/TrustLine.tsx`, main's S-02)
// renders only from store data, so the demo and the three look stores must declare COD and a
// return window or the looks are judged without their trust line.
describe('demo seed feeds the shared trust line (W2b)', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '../../scripts/storedemo/seed.mjs'),
    'utf8'
  ) as string;
  it('the store gets a 14-day return window', () => {
    expect(src).toMatch(/returnWindowDays:\s*14\b/);
  });
  it('the store gets an enabled COD payment config, found by provider then updated or created', () => {
    expect(src).toMatch(/provider:\s*'cod'/);
    expect(src).toMatch(/paymentConfig\.(findFirst|upsert)/);
    expect(src).toMatch(/isEnabled:\s*true/);
    expect(src).toMatch(/displayNameAr:\s*'الدفع عند الاستلام'/);
  });
});
