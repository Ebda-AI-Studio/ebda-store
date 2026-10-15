// @vitest-environment jsdom
/**
 * X-02 (P0) / X-03 (Lookbook/Vitrine taste gate 2026-10-15): ONE answer to "can
 * this be bought now?" — `apps/web/src/lib/can-buy-now.ts` (stock OR backorder,
 * published) — read by the variant selector, the PDP buttons + sticky bars (via
 * `addDisabled`), every card path, the delivery-date line and the JSON-LD
 * availability. The selector used to disable every sold-out size even when the
 * merchant accepted backorders, so the pre-order was unreachable on every store.
 * PDP behaviour on both paths: tests/unit/pdp-sticky-parity.test.tsx (X-02/X-03).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canBuyNow, inStockNow } from '../../apps/web/src/lib/can-buy-now';
import { autoSelectVariant, variantWithoutPicker } from '../../apps/web/src/lib/single-variant';
import { itemList, productJsonLd } from '../../apps/web/src/lib/structured-data';

vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'en',
      direction: 'ltr',
      isRtl: false,
      setLanguage: () => {},
      t: (en: string) => en,
    }),
  };
});

afterEach(cleanup);

describe('canBuyNow', () => {
  it('in stock → yes; sold out → no; sold out + backorder → yes (pre-order)', () => {
    expect(canBuyNow({ inStock: true })).toBe(true);
    expect(canBuyNow({ inStock: false })).toBe(false);
    expect(canBuyNow({ inStock: false, acceptsBackorder: true })).toBe(true);
  });
  it('the variant decides when there is one', () => {
    const product = { inStock: true };
    expect(canBuyNow(product, { inventory: 0, inStock: false })).toBe(false);
    expect(canBuyNow(product, { inventory: 0, inStock: false, acceptsBackorder: true })).toBe(true);
    expect(canBuyNow({ inStock: false }, { inventory: 2, inStock: true })).toBe(true);
  });
  it('a disabled variant (server: inStock false, no backorder) is not buyable even with inventory', () => {
    expect(canBuyNow(null, { inventory: 7, inStock: false, acceptsBackorder: false })).toBe(false);
  });
  it('falls back to inventory when the flag is absent (null = untracked = available)', () => {
    expect(canBuyNow(null, { inventory: 0 })).toBe(false);
    expect(canBuyNow(null, { inventory: -1 })).toBe(false);
    expect(canBuyNow(null, { inventory: null })).toBe(true);
    expect(canBuyNow(null, {})).toBe(true);
  });
  it('an unpublished product is never buyable', () => {
    expect(canBuyNow({ status: 'draft', inStock: true })).toBe(false);
    expect(canBuyNow({ status: 'active', inStock: true })).toBe(true);
  });
  it('inStockNow is the on-hand half only', () => {
    expect(inStockNow({ inStock: false, acceptsBackorder: true })).toBe(false);
    expect(inStockNow(null, { inventory: 3 })).toBe(true);
  });
});

describe('X-02: the variant selector', () => {
  const options = [
    { id: 'o1', name: 'Size', values: [{ value: 'S' }, { value: 'M' }, { value: 'L' }] },
  ];
  const variants = [
    {
      id: 'v1',
      price: 100,
      inventory: 0,
      inStock: false,
      acceptsBackorder: true,
      options: { Size: 'S' },
    },
    {
      id: 'v2',
      price: 100,
      inventory: 0,
      inStock: false,
      acceptsBackorder: false,
      options: { Size: 'M' },
    },
    { id: 'v3', price: 100, inventory: 4, inStock: true, options: { Size: 'L' } },
  ];

  it('keeps a backorderable sold-out size pickable, disables a plain sold-out one', async () => {
    const { VariantSelector } = await import('../../apps/web/src/components/VariantSelector');
    render(
      <VariantSelector
        variants={variants as never}
        options={options as never}
        onVariantSelect={() => {}}
      />
    );
    const pill = (v: string) =>
      screen
        .getAllByRole('button')
        .find(b => b.textContent?.trim().startsWith(v)) as HTMLButtonElement;
    expect(pill('S').disabled).toBe(false);
    expect(pill('M').disabled).toBe(true);
    expect(pill('L').disabled).toBe(false);
  });

  it('pre-selects a single backorderable variant (same rule as the pill)', () => {
    expect(autoSelectVariant([variants[0]], ['Size'])).toBe(variants[0]);
    expect(autoSelectVariant([variants[1]], ['Size'])).toBeNull();
    expect(variantWithoutPicker([variants[1], variants[0]], [])).toBe(variants[0]);
  });
});

describe('X-03: JSON-LD availability agrees with the buy button', () => {
  const store = { id: 's', slug: 's', name: 'S', currency: 'EGP', domain: null } as never;
  const base = { name: 'P', slug: 'p', price: 100, images: [] };
  const availability = (p: Record<string, unknown>) =>
    (productJsonLd({ ...base, ...p } as never, store) as { offers: { availability: string } })
      .offers.availability;
  it('a stocked variant product (own inventory 0) is InStock', () => {
    expect(availability({ inventory: 0, inStock: true })).toBe('https://schema.org/InStock');
  });
  it('sold out + backorder is BackOrder; sold out is OutOfStock', () => {
    expect(availability({ inventory: 0, inStock: false, acceptsBackorder: true })).toBe(
      'https://schema.org/BackOrder'
    );
    expect(availability({ inventory: 0, inStock: false })).toBe('https://schema.org/OutOfStock');
  });
});

describe('X-03 (fix round): the collection ItemList agrees with the PDP', () => {
  const avail = (p: Record<string, unknown>) =>
    (
      itemList([{ name: 'P', url: 'u', price: 100, ...p }]) as {
        itemListElement: Array<{ item: { offers: { availability: string } } }>;
      }
    ).itemListElement[0].item.offers.availability;
  it('in stock / backorder / sold out', () => {
    expect(avail({ inStock: true })).toBe('https://schema.org/InStock');
    expect(avail({ inStock: false, acceptsBackorder: true })).toBe('https://schema.org/BackOrder');
    expect(avail({ inStock: false })).toBe('https://schema.org/OutOfStock');
  });
  it('the PLP and home lists pass the backorder flag through the helper', () => {
    for (const f of [
      'apps/web/src/app/HomePageBody.tsx',
      'apps/web/src/app/products/ProductsPageBody.tsx',
    ]) {
      expect(readFileSync(join(__dirname, '../..', f), 'utf8'), f).toMatch(
        /acceptsBackorder: canBuyNow\(p\) && !inStockNow\(p\)/
      );
    }
  });
});

/** Static half: no buy surface re-derives the rule from raw flags. */
describe('X-02: one stock rule in the storefront', () => {
  const ROOT = join(__dirname, '../..');
  const ALLOWED = new Set([
    'apps/web/src/lib/can-buy-now.ts', // the rule
    'apps/web/src/templates/adapters.ts', // mappers copy the server flag onto TemplateProduct
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(tsx|ts)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  // A read of the backorder flag, or a stock decision on raw inventory.
  const BANNED = [
    /\.acceptsBackorder\b/,
    /\binventory\s*(?:===|<=|>|<)\s*0\b/,
    /\binventory\s*\?\?\s*1\b/,
  ];

  it('acceptsBackorder / raw inventory decisions only inside lib/can-buy-now.ts', () => {
    const hits = walk(join(ROOT, 'apps/web/src'))
      .map(f => relative(ROOT, f))
      .filter(f => !ALLOWED.has(f))
      .flatMap(f =>
        readFileSync(join(ROOT, f), 'utf8')
          .split('\n')
          .flatMap((l, i) =>
            !/^\s*(\*|\/\/|\/\*)/.test(l) && BANNED.some(r => r.test(l))
              ? [`${f}:${i + 1}: ${l.trim()}`]
              : []
          )
      );
    expect(hits).toEqual([]);
  });
});
