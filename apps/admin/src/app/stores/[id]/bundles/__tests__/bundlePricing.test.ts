import { describe, it, expect } from 'vitest';
import {
  computeAvailability,
  computeComponentSum,
  toBundleLines,
  percentToBasisPoints,
  basisPointsToPercent,
  majorToMinor,
  extractVariantOptions,
  zeroPriceWarning,
  UNTRACKED_AVAILABILITY_CAP,
} from '../bundlePricing';

describe('computeComponentSum', () => {
  it('sums unitPrice * quantity across lines', () => {
    expect(
      computeComponentSum([
        { unitPrice: 4500, quantity: 1 },
        { unitPrice: 2000, quantity: 2 },
      ])
    ).toBe(8500);
  });

  it('is 0 for an empty item list', () => {
    expect(computeComponentSum([])).toBe(0);
  });
});

describe('toBundleLines', () => {
  it('assigns a positional key to each line', () => {
    const lines = toBundleLines([
      { unitPrice: 1000, quantity: 1 },
      { unitPrice: 2000, quantity: 3 },
    ]);
    expect(lines).toEqual([
      { key: '0', unitPrice: 1000, quantity: 1 },
      { key: '1', unitPrice: 2000, quantity: 3 },
    ]);
  });
});

describe('computeAvailability', () => {
  it('is min(floor(stock/qty)) over tracked components', () => {
    // 12 makeable from the first line (24/2), 15 from the second (15/1) -> 12
    expect(
      computeAvailability([
        { quantity: 2, trackInventory: true, availableStock: 24 },
        { quantity: 1, trackInventory: true, availableStock: 15 },
      ])
    ).toBe(12);
  });

  it('ignores untracked components when at least one is tracked', () => {
    expect(
      computeAvailability([
        { quantity: 1, trackInventory: true, availableStock: 5 },
        { quantity: 1, trackInventory: false, availableStock: 0 },
      ])
    ).toBe(5);
  });

  it('returns UNTRACKED_AVAILABILITY_CAP when every component is untracked', () => {
    expect(
      computeAvailability([
        { quantity: 1, trackInventory: false, availableStock: 0 },
        { quantity: 3, trackInventory: false, availableStock: 0 },
      ])
    ).toBe(UNTRACKED_AVAILABILITY_CAP);
  });

  it('returns 0 for an empty bundle (not Infinity)', () => {
    expect(computeAvailability([])).toBe(0);
  });

  it('never returns negative availability', () => {
    expect(computeAvailability([{ quantity: 5, trackInventory: true, availableStock: 2 }])).toBe(0);
  });
});

describe('percentToBasisPoints / basisPointsToPercent', () => {
  it('converts 12.5% to 1250 basis points', () => {
    expect(percentToBasisPoints(12.5)).toBe(1250);
  });

  it('round-trips back to the same percent', () => {
    expect(basisPointsToPercent(percentToBasisPoints(12.5))).toBe(12.5);
  });

  it('rounds to the nearest basis point', () => {
    expect(percentToBasisPoints(12.505)).toBe(1251); // 12.505% -> 1250.5bps -> 1251
  });

  it('treats non-finite input as 0', () => {
    expect(percentToBasisPoints(NaN)).toBe(0);
  });
});

describe('majorToMinor', () => {
  it('converts a EGP decimal string to integer piastres', () => {
    expect(majorToMinor('119.99')).toBe(11999);
  });

  it('treats empty/invalid input as 0 piastres, not NaN', () => {
    expect(majorToMinor('')).toBe(0);
    expect(majorToMinor('not a number')).toBe(0);
  });

  it('rounds sub-piastres precision', () => {
    expect(majorToMinor('1.005')).toBe(101); // 100.5 -> half up to 101 (not float 100.49999…)
    expect(majorToMinor('1.0049')).toBe(100);
  });
});

describe('extractVariantOptions', () => {
  // Regression test for fix round 1, Finding 1 (CRITICAL): the picker read
  // `data.product.variants`, but `VariantService.getProductVariants`
  // (apps/api/src/services/variant.service.ts) returns `variants` as a
  // SIBLING of `product`/`options`, never nested inside `product`. Against
  // the real endpoint shape, `data.product.variants` is always
  // `undefined` — every product with variants showed an empty "choose a
  // variant" panel with zero buttons, so a variant-pinned component could
  // never be added at all, and on edit every variant-pinned line's
  // `availableStock` silently defaulted to 0.
  it('reads variants as a SIBLING of product — the real GET /products/:id/variants shape', () => {
    // Shaped like VariantService.getProductVariants's actual return value:
    // `product` carries only its own scalar fields (no `variants` key of
    // its own), and `variants` sits at the top level alongside it.
    const realisticPayload = {
      product: {
        id: 'prod-1',
        name: 'T-Shirt',
        nameAr: null,
        sku: 'TEE',
        price: 3000,
        hasVariants: true,
        inventory: 0,
      },
      options: [{ id: 'opt-1', name: 'Size' }],
      variants: [
        { id: 'var-1', title: 'Small', titleAr: 'صغير', price: 3000, inventory: 5, isActive: true },
        { id: 'var-2', title: 'Large', titleAr: 'كبير', price: 3200, inventory: 0, isActive: true },
      ],
    };

    const result = extractVariantOptions(realisticPayload);
    expect(result).toHaveLength(2);
    expect(result.map(v => v.id)).toEqual(['var-1', 'var-2']);
  });

  it('returns [] for a missing/null response rather than throwing', () => {
    expect(extractVariantOptions(null)).toEqual([]);
    expect(extractVariantOptions(undefined)).toEqual([]);
    expect(extractVariantOptions({})).toEqual([]);
  });

  it('does NOT fall back to variants nested inside product (the bug this guards against)', () => {
    // A payload shaped ONLY the buggy way — `variants` nested under
    // `product`, absent at the top level — must still yield [], not the
    // nested array. This is the exact shape mismatch that made the
    // pre-fix code (`data?.product?.variants`) silently return nothing
    // against the REAL endpoint response above; here it is inverted to
    // prove the current implementation does not reach into `product` at
    // all.
    const buggyShapedPayloadOnly = { product: { variants: [{ id: 'wrong' }] } } as unknown as {
      variants?: Array<{ id: string }>;
    };
    expect(extractVariantOptions(buggyShapedPayloadOnly)).toEqual([]);
  });
});

/**
 * P1 (zero-price drift, 2026-09-07): the editor's two pre-submit warnings.
 * `isPurchasable` (apps/api/src/services/bundle.service.ts) refuses to sell a
 * 0-priced bundle whose components are not themselves free, and
 * `assertPriceWithinComponentSum` (bundle.routes.ts) refuses to SAVE a
 * `fixed` discount worth the whole component total — this is what tells the
 * merchant BEFORE either refusal lands.
 */
describe('zeroPriceWarning', () => {
  const base = {
    pricingType: 'fixed' as const,
    componentSum: 20000,
    pricingValueFils: 5000,
    derivedPrice: 15000,
    itemCount: 1,
  };

  it('says nothing about a real discount that leaves a real price', () => {
    expect(zeroPriceWarning(base)).toBeNull();
  });

  it('flags a `fixed` discount worth the whole component total', () => {
    expect(zeroPriceWarning({ ...base, pricingValueFils: 20000, derivedPrice: 0 })).toBe(
      'discountAboveComponentSum'
    );
  });

  it('flags a `fixed` discount worth MORE than the components', () => {
    expect(zeroPriceWarning({ ...base, pricingValueFils: 25000, derivedPrice: 0 })).toBe(
      'discountAboveComponentSum'
    );
  });

  it('flags a literal `fixed_price: 0` over components that cost something — it saves, but never sells', () => {
    expect(
      zeroPriceWarning({
        ...base,
        pricingType: 'fixed_price',
        pricingValueFils: 0,
        derivedPrice: 0,
      })
    ).toBe('zeroPriceWillNotSell');
  });

  it('flags a 100% `percentage` the same way', () => {
    expect(
      zeroPriceWarning({
        ...base,
        pricingType: 'percentage',
        pricingValueFils: 10000,
        derivedPrice: 0,
      })
    ).toBe('zeroPriceWillNotSell');
  });

  it('says nothing when the components are themselves free — a free kit is a legitimate 0', () => {
    // The `componentSum === 0` half of `isPurchasable`'s clause: this bundle
    // DOES sell, so warning about it would be wrong.
    expect(
      zeroPriceWarning({
        ...base,
        pricingType: 'fixed_price',
        componentSum: 0,
        pricingValueFils: 0,
        derivedPrice: 0,
        itemCount: 1,
      })
    ).toBeNull();
  });

  it('says nothing while the picker is still empty — a merchant mid-edit is not misconfigured', () => {
    expect(
      zeroPriceWarning({ ...base, componentSum: 0, derivedPrice: 0, itemCount: 0 })
    ).toBeNull();
  });
});
