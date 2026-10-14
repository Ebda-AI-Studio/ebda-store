import { describe, it, expect } from 'vitest';
import { computeOrderTax } from '@ebda/shared';
import { computeOrderTax as apiComputeOrderTax } from '@api/lib/order-tax';

/**
 * Ruling M3-6 (docs/RULINGS.md): the checkout summary showed no tax line at
 * all, and its total excluded tax — a store with tax added on top of prices
 * showed the shopper a total lower than what they were actually charged.
 *
 * The fix moves `computeOrderTax` into `@ebda/shared` so the storefront
 * (checkout + cart summary) and the API (order creation — the authoritative
 * charge) call the SAME function rather than two implementations that could
 * drift apart. `apps/api/src/lib/order-tax.ts` re-exports it for the
 * existing `@api/lib/order-tax` import path.
 *
 * This is the parity proof: the re-export IS the shared function (no copy to
 * drift), and a wide sweep of subtotal/discount/rate combinations — the same
 * combinations `@api/lib/order-tax`'s own test uses plus rounding edges —
 * matches the closed-form formula exactly.
 */
describe('computeOrderTax — client display vs. server charge, parity', () => {
  it('the API re-export IS the shared implementation, not a second copy', () => {
    // Reference equality: if anyone ever re-implements this in the API
    // instead of re-exporting, this assertion breaks immediately.
    expect(apiComputeOrderTax).toBe(computeOrderTax);
  });

  // Fractions, as both the checkout (taxRatePercent / 100) and the API
  // (Number(taxRates[0].rate) / 100) derive them.
  const RATES = [0, 0.05, 0.055, 0.15, 0.075, 0.1925, 1];
  const SUBTOTALS = [0, 1, 999, 1000, 1010, 7990, 20000, 33333, 999999];
  const DISCOUNTS = [0, 1, 500, 1198, 5000, 11111, 40000];

  it('matches the closed-form formula over every subtotal/discount/rate combination', () => {
    for (const rate of RATES) {
      for (const subtotal of SUBTOTALS) {
        for (const discount of DISCOUNTS) {
          const expected = Math.round(Math.max(0, subtotal - discount) * rate);
          expect(
            computeOrderTax(subtotal, discount, rate),
            `subtotal=${subtotal} discount=${discount} rate=${rate}`
          ).toBe(expected);
        }
      }
    }
  });

  it('rounds half away from zero at a fil boundary (known edge: 7990 base after a 1198 discount, 5%)', () => {
    // base 6792 (7990 − 1198) × 5% = 339.6 → 340.
    expect(computeOrderTax(7990, 1198, 0.05)).toBe(340);
    expect(computeOrderTax(1010, 0, 0.05)).toBe(51); // 50.5 → 51
  });

  it('never goes negative when the discount exceeds the subtotal, at any rate', () => {
    for (const rate of RATES) {
      expect(computeOrderTax(1000, 5000, rate)).toBe(0);
    }
  });

  it('is zero for a store with no active tax rate — the 3 live stores today', () => {
    for (const subtotal of SUBTOTALS) {
      for (const discount of DISCOUNTS) {
        expect(computeOrderTax(subtotal, discount, 0)).toBe(0);
      }
    }
  });
});

/**
 * Scoped-audit P1 follow-up: order creation never read `taxIncludedInPrice`
 * anywhere, so it ALWAYS added tax on top even when the listed price already
 * contained it — a store with inclusive VAT would be shown "Incl. VAT" and
 * charged as if it were exclusive, the exact display-vs-charge gap M3-3 was
 * about. `computeOrderTax`'s 4th argument selects EXTRACTION instead: the
 * tax portion of an already-tax-inclusive base, `base − base / (1 + rate)`,
 * which order creation and the storefront both now call identically.
 */
describe('computeOrderTax — inclusive-price extraction (scoped-audit P1 follow-up)', () => {
  it('extracts VAT from a tax-inclusive base: 21000 at 5% inclusive contains exactly 1000 tax', () => {
    // net 20000 * 1.05 = 21000 exactly — a clean round-trip.
    expect(computeOrderTax(21000, 0, 0.05, true)).toBe(1000);
  });

  it('the exclusive and inclusive branches genuinely disagree on the same inputs', () => {
    // Exclusive: 20000 * 5% = 1000 added on top → total would be 21000.
    // Inclusive: 20000 already contains tax → extract ~952 → total stays 20000.
    const exclusive = computeOrderTax(20000, 0, 0.05, false);
    const inclusive = computeOrderTax(20000, 0, 0.05, true);
    expect(exclusive).toBe(1000);
    expect(inclusive).toBe(952); // round(20000 - 20000/1.05) = round(952.38) = 952
    expect(inclusive).not.toBe(exclusive);
  });

  it('defaults to exclusive when the 4th argument is omitted (back-compat: every existing 3-arg call)', () => {
    expect(computeOrderTax(20000, 5000, 0.05)).toBe(computeOrderTax(20000, 5000, 0.05, false));
  });

  it('is zero at rate 0 regardless of includedInPrice — tax off stays off', () => {
    expect(computeOrderTax(20000, 0, 0, true)).toBe(0);
    expect(computeOrderTax(20000, 5000, 0, true)).toBe(0);
  });

  it('never goes negative when the discount exceeds the subtotal, inclusive or not', () => {
    expect(computeOrderTax(1000, 5000, 0.05, true)).toBe(0);
  });

  it('the API re-export of the 4-arg signature stays reference-identical', () => {
    expect(apiComputeOrderTax(21000, 0, 0.05, true)).toBe(computeOrderTax(21000, 0, 0.05, true));
  });
});
