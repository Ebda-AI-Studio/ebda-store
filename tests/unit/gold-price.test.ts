/**
 * Gold-rate pricing, Task 8 (Rulings B5-13, B5-14): the ONE price formula. Vectors A-G were
 * computed with BigInt while the plan was written; each is re-derived by hand in a comment below.
 * Units: rate = piastres per gram, weight = milligrams, margin = basis points, making = piastres
 * (fixed) or piastres per gram (per_gram), step = piastres (100 = whole pounds).
 * Imports the SOURCE file (not the built @ebda/shared): the defence-mutation record edits the source.
 */
import { describe, it, expect } from 'vitest';
import {
  computeGoldUnitPrice,
  resolveVariantGoldSpec,
  goldRateJumpBps,
  karatCoherenceBps,
  GoldPriceError,
  bpsToPercentString,
  mgToGramsString,
  parseGramsToMg,
  parsePercentToBps,
  GOLD_KARATS,
  GOLD_ROUNDING_STEPS,
  type GoldPriceSpec,
  type GoldRoundingStep,
} from '../../packages/shared/src/commerce/gold-price';

const spec = (over: Partial<GoldPriceSpec> = {}): GoldPriceSpec => ({
  karat: 21,
  weightMg: 3250,
  makingChargeType: 'per_gram',
  makingChargeValue: 15000,
  marginBps: 0,
  ...over,
});
const price = (s: GoldPriceSpec, rate: number, step: GoldRoundingStep) =>
  computeGoldUnitPrice(s, rate, step).unitPrice;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof GoldPriceError ? e.code : `other:${String(e)}`;
  }
  return 'none';
};

describe('vectors (re-derived by hand)', () => {
  // metal = 3250 mg * 576 323 = 1 873 049 750 ; making = 3250 * 15 000 = 48 750 000 ;
  // base = 1 921 799 750 ; * 10 000 = 19 217 997 500 000 ; / (10^7 * 100) = 19 217.9975 -> 19 218 ; * 100 = 1 921 800
  it('A: per-gram making, no margin, whole pounds = 1 921 800', () => {
    expect(price(spec(), 576323, 100)).toBe(1_921_800);
  });
  // base * 10 250 = 19 698 447 437 500 ; / 10^9 = 19 698.4474 -> 19 698 -> 1 969 800
  it('B: +250 bps = 1 969 800', () => {
    expect(price(spec({ marginBps: 250 }), 576323, 100)).toBe(1_969_800);
  });
  // fixed 50 000 piastres * 1000 = 50 000 000 ; base = 1 923 049 750 ; * 10 000 / 10^9 = 19 230.4975 -> 19 230 -> 1 923 000
  it('C: fixed making = 1 923 000 (true 19 230.4975 pounds rounds DOWN to 19 230)', () => {
    expect(price(spec({ makingChargeType: 'fixed', makingChargeValue: 50000 }), 576323, 100)).toBe(
      1_923_000
    );
  });
  it('C negative control: a piastre-then-pound (two-stage) rounding returns 1 923 100 and must differ', () => {
    // 19 230.4975 EGP = 1 923 049.75 piastres -> 1 923 050 (round to piastre) -> 19 230.50 EGP -> 19 231 -> 1 923 100
    const twoStage = (() => {
      const base = 3250n * 576323n + 50000n * 1000n; // piastre*mg/g
      const piastres = (2n * base * 10000n + 10n ** 7n) / (2n * 10n ** 7n); // round to the piastre
      return ((2n * piastres + 100n) / 200n) * 100n; // then to the pound
    })();
    expect(Number(twoStage)).toBe(1_923_100);
    expect(
      price(spec({ makingChargeType: 'fixed', makingChargeValue: 50000 }), 576323, 100)
    ).not.toBe(Number(twoStage));
  });
  it('C1: the same piece at step 1 = 1 923 050', () => {
    expect(price(spec({ makingChargeType: 'fixed', makingChargeValue: 50000 }), 576323, 1)).toBe(
      1_923_050
    );
  });
  // base * 9 500 = 18 257 097 625 000 ; / 10^9 = 18 257.0976 -> 18 257 -> 1 825 700
  it('D: -500 bps = 1 825 700', () => {
    expect(price(spec({ marginBps: -500 }), 576323, 100)).toBe(1_825_700);
  });
  // 1e6 mg * 1e7 = 1e13 metal, 1e13 making, base 2e13, * 20 000 = 4e17, / 1e7 = 4e10 > 2 147 483 647
  it('E: a product over int4 throws GOLD_PRICE_OUT_OF_RANGE', () => {
    expect(
      code(() =>
        price(
          spec({ weightMg: 1_000_000, makingChargeValue: 10_000_000, marginBps: 10_000 }),
          10_000_000,
          1
        )
      )
    ).toBe('GOLD_PRICE_OUT_OF_RANGE');
  });
  // 1 mg * 10 000 = 10 000 ; * 5 000 = 5e7 ; / 1e7 = 5
  it('F: the smallest piece, -50 % = 5 piastres', () => {
    expect(
      price(
        spec({ weightMg: 1, makingChargeType: 'fixed', makingChargeValue: 0, marginBps: -5000 }),
        10_000,
        1
      )
    ).toBe(5);
  });
  // 1e6 mg * 658 655 = 6.58655e11 ; * 10 000 = 6.58655e15 ; / 1e9 = 6 586 550 ; * 100
  it('G: a 1 kg bar at step 100 = 658 655 000', () => {
    expect(
      price(
        spec({ weightMg: 1_000_000, makingChargeType: 'fixed', makingChargeValue: 0 }),
        658_655,
        100
      )
    ).toBe(658_655_000);
  });
  it('a price that rounds to zero is out of range, not a free piece', () => {
    expect(
      code(() =>
        price(
          spec({ weightMg: 1, makingChargeType: 'fixed', makingChargeValue: 0, marginBps: -5000 }),
          10_000,
          100
        )
      )
    ).toBe('GOLD_PRICE_OUT_OF_RANGE');
  });
  it('display splits are each rounded half-up on their own and are not summed into the price', () => {
    const r = computeGoldUnitPrice(spec(), 576323, 100);
    expect(r.metalValue).toBe(1_873_050); // 1 873 049 750 / 1000 = 1 873 049.75 -> 1 873 050
    expect(r.makingValue).toBe(48_750);
    expect(r.unitPrice).toBe(1_921_800);
    // vector C: the splits (1 873 050 + 50 000 = 1 923 050) are NOT the price (1 923 000): the price rounds once
    const c = computeGoldUnitPrice(
      spec({ makingChargeType: 'fixed', makingChargeValue: 50000 }),
      576323,
      100
    );
    expect(c.metalValue + c.makingValue).toBe(1_923_050);
    expect(c.unitPrice).toBe(1_923_000);
  });
});

describe('exact half boundaries at every step', () => {
  // choose weight and rate so that base / 10^5 sits exactly on x.5 of the step
  for (const step of GOLD_ROUNDING_STEPS) {
    it(`step ${step}: x.5 rounds up, just under rounds down`, () => {
      // fixed making of N piastres, weight 1 mg, rate 10 000: base = 10 000 + N*1000 ; price = base / 1000 piastres
      // want unrounded piastres = k*step + step/2 exactly (needs step even, else x.5 does not exist at step 1)
      const s = (n: number) =>
        spec({ weightMg: 1, makingChargeType: 'fixed', makingChargeValue: n, marginBps: 0 });
      if (step === 1) {
        // 1 mg * rate 10 001 = 10 001 piastre*mg/g = 10.001 piastres -> 10 ; add making 1 piastre (=1000) -> 11.001 -> 11
        expect(price(s(0), 10_001, 1)).toBe(10);
        expect(price(s(0), 10_500, 1)).toBe(11); // 10.5 exactly rounds UP
        expect(price(s(0), 10_499, 1)).toBe(10); // 10.499 rounds down
        return;
      }
      // unrounded piastres = 10 + N ; want 10 + N = step/2 + k*step
      const n = step / 2 - 10 + step; // 1.5 steps -> rounds to 2 steps
      expect(price(s(n), 10_000, step)).toBe(2 * step);
      expect(price(s(n - 1), 10_000, step)).toBe(step);
    });
  }
});

describe('bounds +/- 1 are refused with the right code', () => {
  it('weight 0 and 1 000 001, non-integer weight', () => {
    expect(code(() => price(spec({ weightMg: 0 }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ weightMg: 1_000_001 }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ weightMg: 3.5 }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ weightMg: 1 }), 576323, 100))).not.toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ weightMg: 1_000_000 }), 10_000, 100))).not.toBe(
      'GOLD_SPEC_INVALID'
    );
  });
  it('rate 9 999 and 10 000 001, non-integer rate, NaN', () => {
    expect(code(() => price(spec(), 9_999, 100))).toBe('GOLD_RATE_INVALID');
    expect(code(() => price(spec(), 10_000_001, 100))).toBe('GOLD_RATE_INVALID');
    expect(code(() => price(spec(), 576323.5, 100))).toBe('GOLD_RATE_INVALID');
    expect(code(() => price(spec(), Number.NaN, 100))).toBe('GOLD_RATE_INVALID');
    expect(code(() => price(spec(), 10_000, 100))).not.toBe('GOLD_RATE_INVALID');
  });
  it('margin -5 001 and 10 001, non-integer margin', () => {
    expect(code(() => price(spec({ marginBps: -5001 }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ marginBps: 10_001 }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ marginBps: 0.5 }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ marginBps: -5000 }), 576323, 100))).toBe('none');
  });
  it('karat, making type, negative making, bad step', () => {
    expect(code(() => price(spec({ karat: 22 as never }), 576323, 100))).toBe('GOLD_SPEC_INVALID');
    expect(code(() => price(spec({ makingChargeType: 'x' as never }), 576323, 100))).toBe(
      'GOLD_SPEC_INVALID'
    );
    expect(code(() => price(spec({ makingChargeValue: -1 }), 576323, 100))).toBe(
      'GOLD_SPEC_INVALID'
    );
    expect(code(() => price(spec(), 576323, 7 as never))).toBe('GOLD_SPEC_INVALID');
  });
});

describe('property: equals an independent BigInt oracle across 10 000 random in-range specs', () => {
  // mulberry32: a fixed seed, so a failure reproduces
  let a = 0x5eed1234;
  const rnd = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

  // Oracle: exact rational N/D, rounded half up to the step, written with a different shape from the
  // implementation (one fraction, no intermediate named base/num).
  const oracle = (s: GoldPriceSpec, rate: number, step: number): bigint | null => {
    const w = BigInt(s.weightMg);
    const making =
      s.makingChargeType === 'fixed'
        ? BigInt(s.makingChargeValue) * 1000n
        : w * BigInt(s.makingChargeValue);
    const N = (w * BigInt(rate) + making) * BigInt(10000 + s.marginBps);
    const D = 1000n * 10000n * BigInt(step); // mg->g, bps, step
    const q = (2n * N + D) / (2n * D);
    const out = q * BigInt(step);
    return out >= 1n && out <= 2147483647n ? out : null;
  };
  it('10 000 draws agree with the oracle; draws the oracle calls out of range throw', () => {
    let inRange = 0;
    for (let i = 0; i < 10_000; i++) {
      const s: GoldPriceSpec = {
        karat: GOLD_KARATS[between(0, 2)],
        weightMg: between(1, 1_000_000),
        makingChargeType: rnd() < 0.5 ? 'fixed' : 'per_gram',
        makingChargeValue: between(0, 20_000_000),
        marginBps: between(-5000, 10_000),
      };
      const rate = between(10_000, 10_000_000);
      const step = GOLD_ROUNDING_STEPS[between(0, 3)];
      const want = oracle(s, rate, step);
      if (want === null) {
        expect(
          code(() => price(s, rate, step)),
          JSON.stringify({ s, rate, step })
        ).toBe('GOLD_PRICE_OUT_OF_RANGE');
        continue;
      }
      inRange++;
      expect(BigInt(price(s, rate, step)), JSON.stringify({ s, rate, step })).toBe(want);
    }
    expect(inRange).toBeGreaterThan(500);
  });

  // Float-path negative control, found by exhaustive search over exact half-pound cases: 1.15 g at
  // EGP 110.00 per gram is EXACTLY 126.5 pounds, which half-up rounds to 127. The obvious Number
  // implementation (grams * pounds, then Math.round) returns 126 because 1.15 * 110 is 126.49999999999999.
  it('float negative control: 1.15 g at EGP 110.00/g is exactly 126.50 and rounds UP to 127; a Number path says 126', () => {
    const naive = Math.round((1150 / 1000) * (11000 / 100));
    expect(naive).toBe(126);
    const s = spec({ weightMg: 1150, makingChargeType: 'fixed', makingChargeValue: 0 });
    expect(price(s, 11_000, 100)).toBe(12_700);
    expect(oracle(s, 11_000, 100)).toBe(12_700n);
  });
});

describe('resolveVariantGoldSpec', () => {
  const product = {
    pricingMode: 'gold_rate' as const,
    karat: 21,
    weightMg: 3000,
    makingChargeType: 'per_gram' as const,
    makingChargeValue: 15000,
    marginBps: 250,
  };
  it('a variant with only weightMg inherits karat, making and margin from the product', () => {
    const r = resolveVariantGoldSpec(product, { pricingMode: null, weightMg: 4200 });
    expect(r).toEqual({
      karat: 21,
      weightMg: 4200,
      makingChargeType: 'per_gram',
      makingChargeValue: 15000,
      marginBps: 250,
    });
  });
  it('a variant pricingMode "fixed" on a gold product is null (priced by its own price)', () => {
    expect(resolveVariantGoldSpec(product, { pricingMode: 'fixed' })).toBeNull();
  });
  it('a fixed product with a null variant mode is fixed; a variant may switch itself to gold', () => {
    const fixed = { pricingMode: 'fixed' as const };
    expect(resolveVariantGoldSpec(fixed, { pricingMode: null })).toBeNull();
    expect(
      resolveVariantGoldSpec(fixed, {
        pricingMode: 'gold_rate',
        karat: 18,
        weightMg: 1000,
        makingChargeType: 'fixed',
        makingChargeValue: 0,
      })
    ).toEqual({
      karat: 18,
      weightMg: 1000,
      makingChargeType: 'fixed',
      makingChargeValue: 0,
      marginBps: 0,
    });
  });
  it('an incomplete or out-of-range gold spec throws GOLD_SPEC_INVALID', () => {
    expect(
      code(() => resolveVariantGoldSpec({ pricingMode: 'gold_rate' }, { pricingMode: null }))
    ).toBe('GOLD_SPEC_INVALID');
    expect(code(() => resolveVariantGoldSpec(product, { pricingMode: null, weightMg: 0 }))).toBe(
      'GOLD_SPEC_INVALID'
    );
  });
});

describe('gate helpers', () => {
  it('goldRateJumpBps rounds UP: 500 000 -> 525 001 is 501', () => {
    expect(goldRateJumpBps(500_000, 525_001)).toBe(501);
    expect(goldRateJumpBps(500_000, 525_000)).toBe(500);
    expect(goldRateJumpBps(500_000, 475_000)).toBe(500);
    expect(goldRateJumpBps(500_000, 500_000)).toBe(0);
  });
  it('goldRateJumpBps refuses non-positive previous and non-integers', () => {
    expect(code(() => goldRateJumpBps(0, 5))).toBe('GOLD_RATE_INVALID');
    expect(code(() => goldRateJumpBps(5.5, 6))).toBe('GOLD_RATE_INVALID');
  });
  it('karatCoherenceBps: a coherent 21k is 0, swapped 21k/18k fields are ~1667 bps off', () => {
    expect(karatCoherenceBps(720_000, 630_000, 21)).toBe(0); // 720 000 * 21/24 = 630 000
    expect(karatCoherenceBps(720_000, 540_000, 18)).toBe(0); // 720 000 * 18/24 = 540 000
    expect(karatCoherenceBps(720_000, 540_000, 21)).toBe(1429); // 540 000 vs 630 000: 14.29 % -> rounds up
    expect(karatCoherenceBps(720_000, 630_000, 18)).toBe(1667); // 630 000 vs 540 000 = 16.67 %
    // 4 % gate: 21k at 3.9 % off passes, 4.1 % does not
    expect(karatCoherenceBps(720_000, Math.round(630_000 * 1.039), 21)).toBeLessThanOrEqual(400);
    expect(karatCoherenceBps(720_000, Math.round(630_000 * 1.041), 21)).toBeGreaterThan(400);
  });
});

describe('typed units: grams, percent', () => {
  it('parses grams with at most two decimals into milligrams, exactly', () => {
    expect(parseGramsToMg('4.35')).toBe(4350);
    expect(parseGramsToMg('12')).toBe(12000);
    expect(parseGramsToMg('0.01')).toBe(10);
    expect(parseGramsToMg(' 7.5 ')).toBe(7500);
    expect(parseGramsToMg('4.355')).toBeNull(); // a third decimal is refused, never rounded
    expect(parseGramsToMg('4,35')).toBeNull();
    expect(parseGramsToMg('')).toBeNull();
    expect(parseGramsToMg('0')).toBeNull();
    expect(parseGramsToMg('-1')).toBeNull();
    expect(parseGramsToMg('1001')).toBeNull(); // over the 1 000 g ceiling
  });

  it('round-trips milligrams through the grams string', () => {
    for (const mg of [10, 4350, 12000, 999990])
      expect(parseGramsToMg(mgToGramsString(mg))).toBe(mg);
    expect(mgToGramsString(4350)).toBe('4.35');
    expect(mgToGramsString(12000)).toBe('12.00');
    // Ruling B5-36: the hundredths carry into the whole part, never "0.100"
    expect(mgToGramsString(995)).toBe('1.00');
    expect(mgToGramsString(1995)).toBe('2.00');
    expect(mgToGramsString(5)).toBe('0.01');
    expect(mgToGramsString(4)).toBe('0.00');
  });

  it('parses a margin percent into basis points inside the allowed range', () => {
    expect(parsePercentToBps('7.5')).toBe(750);
    expect(parsePercentToBps('-2')).toBe(-200);
    expect(parsePercentToBps('0')).toBe(0);
    expect(parsePercentToBps('100')).toBe(10000);
    expect(parsePercentToBps('100.01')).toBeNull();
    expect(parsePercentToBps('-50.01')).toBeNull();
    expect(parsePercentToBps('1.234')).toBeNull();
    expect(bpsToPercentString(750)).toBe('7.5');
    expect(bpsToPercentString(-200)).toBe('-2');
    expect(bpsToPercentString(5)).toBe('0.05');
    expect(bpsToPercentString(0)).toBe('0');
  });
});
