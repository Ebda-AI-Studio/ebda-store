// Gold-rate pricing, Task 8: Zod at every edge. Each schema accepts a valid fixture and rejects
// every bound +/- 1; unknown keys are refused (strict), and the shopper payload has no margin,
// rate id or source key (the margin is the merchant's business, Ruling B5-13).
import { describe, it, expect } from 'vitest';
import {
  goldPriceSpecSchema,
  productGoldPricingInputSchema,
  variantGoldPricingInputSchema,
  goldRateInputSchema,
  goldRateSettingsSchema,
  goldLineSnapshotSchema,
  publicGoldPricingSchema,
} from '../../packages/shared/src/schemas/gold-pricing';

const spec = {
  karat: 21,
  weightMg: 3250,
  makingChargeType: 'per_gram',
  makingChargeValue: 15000,
  marginBps: 0,
};
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

describe('goldPriceSpecSchema', () => {
  it('accepts a valid spec and refuses every bound +/- 1', () => {
    expect(ok(goldPriceSpecSchema, spec)).toBe(true);
    for (const bad of [
      { weightMg: 0 },
      { weightMg: 1_000_001 },
      { weightMg: 1.5 },
      { karat: 22 },
      { makingChargeValue: -1 },
      { makingChargeValue: 2_147_483_648 },
      { marginBps: -5001 },
      { marginBps: 10_001 },
      { marginBps: 1.5 },
      { makingChargeType: 'percent' },
    ])
      expect(ok(goldPriceSpecSchema, { ...spec, ...bad }), JSON.stringify(bad)).toBe(false);
    for (const good of [
      { weightMg: 1 },
      { weightMg: 1_000_000 },
      { marginBps: -5000 },
      { marginBps: 10_000 },
      { makingChargeValue: 0 },
    ])
      expect(ok(goldPriceSpecSchema, { ...spec, ...good }), JSON.stringify(good)).toBe(true);
  });
  it('is strict: an unknown key (a client-supplied price) is refused, not stripped', () => {
    expect(ok(goldPriceSpecSchema, { ...spec, unitPrice: 1 })).toBe(false);
  });
});

describe('productGoldPricingInputSchema', () => {
  const gold = { pricingMode: 'gold_rate', ...spec };
  it('accepts fixed with nothing else and gold with a complete spec', () => {
    expect(ok(productGoldPricingInputSchema, { pricingMode: 'fixed' })).toBe(true);
    expect(ok(productGoldPricingInputSchema, gold)).toBe(true);
  });
  it('gold needs every spec field', () => {
    for (const k of ['karat', 'weightMg', 'makingChargeType', 'makingChargeValue'] as const) {
      const { [k]: _omit, ...rest } = gold;
      expect(ok(productGoldPricingInputSchema, rest), k).toBe(false);
      expect(ok(productGoldPricingInputSchema, { ...gold, [k]: null }), `${k}=null`).toBe(false);
    }
  });
  it('gold + compareAtPrice, discountType or discountValue is refused (Ruling B5-19)', () => {
    expect(ok(productGoldPricingInputSchema, { ...gold, compareAtPrice: 100 })).toBe(false);
    expect(ok(productGoldPricingInputSchema, { ...gold, discountType: 'percentage' })).toBe(false);
    expect(ok(productGoldPricingInputSchema, { ...gold, discountValue: 10 })).toBe(false);
    // a null / "none" discount is no discount
    expect(
      ok(productGoldPricingInputSchema, { ...gold, compareAtPrice: null, discountType: 'none' })
    ).toBe(true);
    // a fixed product may keep its sale fields
    expect(
      ok(productGoldPricingInputSchema, {
        pricingMode: 'fixed',
        compareAtPrice: 100,
        discountType: 'percentage',
      })
    ).toBe(true);
  });
  it('is strict', () => {
    expect(ok(productGoldPricingInputSchema, { ...gold, price: 1 })).toBe(false);
  });
});

describe('variantGoldPricingInputSchema', () => {
  it('null mode and null fields mean inherit', () => {
    expect(ok(variantGoldPricingInputSchema, { pricingMode: null })).toBe(true);
    expect(
      ok(variantGoldPricingInputSchema, { pricingMode: null, weightMg: 4200, karat: null })
    ).toBe(true);
    expect(ok(variantGoldPricingInputSchema, { pricingMode: 'gold_rate', weightMg: 0 })).toBe(
      false
    );
  });
  it('a gold variant cannot carry a compare-at', () => {
    expect(ok(variantGoldPricingInputSchema, { pricingMode: 'gold_rate', compareAtPrice: 5 })).toBe(
      false
    );
    expect(ok(variantGoldPricingInputSchema, { pricingMode: 'fixed', compareAtPrice: 5 })).toBe(
      true
    );
  });
});

describe('goldRateInputSchema', () => {
  it('accepts 1..3 rates, each karat once, rate bounds +/- 1', () => {
    expect(ok(goldRateInputSchema, { rates: [{ karat: 21, ratePerGram: 576323 }] })).toBe(true);
    expect(
      ok(goldRateInputSchema, {
        rates: [
          { karat: 24, ratePerGram: 10_000 },
          { karat: 21, ratePerGram: 10_000_000 },
          { karat: 18, ratePerGram: 500_000 },
        ],
        confirm: true,
      })
    ).toBe(true);
    expect(ok(goldRateInputSchema, { rates: [{ karat: 21, ratePerGram: 9_999 }] })).toBe(false);
    expect(ok(goldRateInputSchema, { rates: [{ karat: 21, ratePerGram: 10_000_001 }] })).toBe(
      false
    );
    expect(ok(goldRateInputSchema, { rates: [{ karat: 21, ratePerGram: 5763.5 }] })).toBe(false);
  });
  it('rejects a duplicate karat, no rates, four rates, an unknown key', () => {
    expect(
      ok(goldRateInputSchema, {
        rates: [
          { karat: 21, ratePerGram: 576323 },
          { karat: 21, ratePerGram: 576324 },
        ],
      })
    ).toBe(false);
    expect(ok(goldRateInputSchema, { rates: [] })).toBe(false);
    expect(
      ok(goldRateInputSchema, {
        rates: [24, 21, 18, 24].map(k => ({ karat: k, ratePerGram: 500_000 })),
      })
    ).toBe(false);
    expect(
      ok(goldRateInputSchema, { rates: [{ karat: 21, ratePerGram: 576323, source: 'feed' }] })
    ).toBe(false);
    expect(
      ok(goldRateInputSchema, { rates: [{ karat: 21, ratePerGram: 576323 }], status: 'applied' })
    ).toBe(false);
  });
});

describe('goldRateSettingsSchema', () => {
  const s = {
    enabled: true,
    feedEnabled: false,
    feedPremiumBps: 0,
    maxAgeMinutes: 1560,
    jumpConfirmBps: 500,
    roundingStep: 100,
    showBreakdown: false,
  };
  it('accepts the defaults and refuses every bound +/- 1', () => {
    expect(ok(goldRateSettingsSchema, s)).toBe(true);
    expect(
      goldRateSettingsSchema.parse({ ...s, jumpConfirmBps: undefined, showBreakdown: undefined })
    ).toMatchObject({ jumpConfirmBps: 500, showBreakdown: false });
    for (const bad of [
      { feedPremiumBps: -1001 },
      { feedPremiumBps: 1001 },
      { maxAgeMinutes: 59 },
      { maxAgeMinutes: 1561 },
      { jumpConfirmBps: 99 },
      { jumpConfirmBps: 5001 },
      { roundingStep: 50 },
    ])
      expect(ok(goldRateSettingsSchema, { ...s, ...bad }), JSON.stringify(bad)).toBe(false);
    for (const good of [
      { feedPremiumBps: -1000 },
      { feedPremiumBps: 1000 },
      { maxAgeMinutes: 60 },
      { jumpConfirmBps: 100 },
      { jumpConfirmBps: 5000 },
      { roundingStep: 1 },
      { roundingStep: 1000 },
    ])
      expect(ok(goldRateSettingsSchema, { ...s, ...good }), JSON.stringify(good)).toBe(true);
  });
  it('26 hours is the ceiling: a merchant can lower the max age, never raise it', () => {
    expect(ok(goldRateSettingsSchema, { ...s, maxAgeMinutes: 1561 })).toBe(false);
  });
});

describe('goldLineSnapshotSchema', () => {
  const snap = {
    v: 1,
    karat: 21,
    weightMg: 3250,
    ratePerGram: 576323,
    rateId: 'rate-1',
    rateAppliedAt: '2026-10-22T08:00:00.000Z',
    makingChargeType: 'per_gram',
    makingChargeValue: 15000,
    marginBps: 0,
    roundingStep: 100,
    unitPrice: 1921800,
  };
  it('accepts a complete snapshot, refuses a wrong version, a missing field, a non-ISO time', () => {
    expect(ok(goldLineSnapshotSchema, snap)).toBe(true);
    expect(ok(goldLineSnapshotSchema, { ...snap, v: 2 })).toBe(false);
    const { rateId: _r, ...noRate } = snap;
    expect(ok(goldLineSnapshotSchema, noRate)).toBe(false);
    expect(ok(goldLineSnapshotSchema, { ...snap, rateAppliedAt: 'yesterday' })).toBe(false);
    expect(ok(goldLineSnapshotSchema, { ...snap, unitPrice: 0 })).toBe(false);
  });
});

describe('publicGoldPricingSchema (the shopper payload)', () => {
  it('has NO margin, rate id or source key: a test enumerates the shape', () => {
    const keys = Object.keys(publicGoldPricingSchema.shape).sort();
    expect(keys).toEqual([
      'breakdown',
      'karat',
      'maxAgeMinutes',
      'rateAppliedAt',
      'ratePerGram',
      'weightMg',
    ]);
    for (const banned of [
      'marginBps',
      'rateId',
      'source',
      'makingChargeValue',
      'makingChargeType',
      'feedReference',
    ])
      expect(keys).not.toContain(banned);
  });
  it('is strict: a payload that leaks the margin does not parse', () => {
    const base = {
      karat: 21,
      weightMg: 3250,
      ratePerGram: 576323,
      rateAppliedAt: '2026-10-22T08:00:00.000Z',
      maxAgeMinutes: 1560,
    };
    expect(ok(publicGoldPricingSchema, base)).toBe(true);
    expect(ok(publicGoldPricingSchema, { ...base, marginBps: 250 })).toBe(false);
    expect(
      ok(publicGoldPricingSchema, { ...base, breakdown: { metalValue: 1, makingValue: 2 } })
    ).toBe(true);
  });
});
