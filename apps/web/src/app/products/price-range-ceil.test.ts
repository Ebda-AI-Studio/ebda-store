import { describe, it, expect } from 'vitest';
import { priceSliderCeil } from './price-range';

/** PL1: ameliaaurum.com showed 0-5,000 while products went to 7,400 and moving the slider dropped them. */
describe('priceSliderCeil', () => {
  it("covers the catalogue's dearest price (minor units in, major out, rounded up to the step)", () => {
    expect(priceSliderCeil(740_000)).toBe(7400);
    expect(priceSliderCeil(740_050)).toBe(7410);
    expect(priceSliderCeil(999)).toBe(10);
  });
  it('is never below the old bound by accident: a cheap store gets a cheap slider, not a fixed 5,000', () => {
    expect(priceSliderCeil(120_000)).toBe(1200);
  });
  it('falls back to 5,000 only when the API gave no figure', () => {
    for (const v of [undefined, 0, -5, NaN]) expect(priceSliderCeil(v)).toBe(5000);
  });
});
