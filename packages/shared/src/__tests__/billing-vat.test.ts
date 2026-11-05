import { describe, expect, it } from 'vitest';
import { BILLING_VAT_RATE_BP, addVat, splitGross } from '../brand/billing-vat';

describe('billing VAT math (integer minor units)', () => {
  it('the default rate is 14%', () => expect(BILLING_VAT_RATE_BP).toBe(1400));

  it.each([0, 1, 99, 100, 101, 999, 12_345, 2_000_000])(
    'gross = net + vat at 14% and 0% for %i',
    n => {
      for (const bp of [1400, 0]) {
        const a = addVat(n, bp);
        expect(a.grossMinor).toBe(a.netMinor + a.vatMinor);
        const s = splitGross(n, bp);
        expect(s.grossMinor).toBe(s.netMinor + s.vatMinor);
        expect(s.vatMinor).toBeGreaterThanOrEqual(0);
        expect(s.vatMinor).toBeLessThanOrEqual(n);
      }
    }
  );

  it('round half up at the boundaries', () => {
    expect(addVat(100).vatMinor).toBe(14);
    expect(addVat(1).vatMinor).toBe(0); // 0.14 -> 0
    expect(addVat(4).vatMinor).toBe(1); // 0.56 -> 1
    expect(addVat(25).vatMinor).toBe(4); // 3.5 -> 4
    expect(splitGross(114).vatMinor).toBe(14);
    expect(splitGross(99).vatMinor).toBe(12); // 12.18 -> 12
    expect(splitGross(100).vatMinor).toBe(12); // 12.28 -> 12
  });

  it('the two directions agree within one minor unit', () => {
    for (let n = 0; n < 5000; n++) {
      const g = addVat(n).grossMinor;
      expect(Math.abs(splitGross(g).netMinor - n)).toBeLessThanOrEqual(1);
    }
  });

  it('0% rate has no VAT', () => {
    expect(addVat(500, 0)).toMatchObject({ vatMinor: 0, grossMinor: 500 });
    expect(splitGross(500, 0)).toMatchObject({ vatMinor: 0, netMinor: 500 });
  });

  it('refuses non-integers, negatives and absurd rates', () => {
    expect(() => addVat(1.5)).toThrow(RangeError);
    expect(() => addVat(-1)).toThrow(RangeError);
    expect(() => splitGross(10, 10_001)).toThrow(RangeError);
    expect(() => splitGross(10, 0.5)).toThrow(RangeError);
  });
});
