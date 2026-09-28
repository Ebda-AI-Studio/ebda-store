import { describe, it, expect } from 'vitest';
import { formatTaxRowLabel } from './tax-display';

const identity = (v: string | number) => String(v);

describe('formatTaxRowLabel', () => {
  it('returns undefined for tax <= 0 (disabled / no active rate / discount ate the base)', () => {
    expect(formatTaxRowLabel(0, 5, false, false, identity)).toBeUndefined();
    expect(formatTaxRowLabel(-1, 5, false, false, identity)).toBeUndefined();
  });

  it('exclusive: "VAT (5%)" in English, "ضريبة القيمة المضافة (5%)" in Arabic', () => {
    expect(formatTaxRowLabel(1000, 5, false, false, identity)).toBe('VAT (5%)');
    expect(formatTaxRowLabel(1000, 5, false, true, identity)).toBe('ضريبة القيمة المضافة (5%)');
  });

  it('inclusive: "Incl. VAT (5%)" in English, "شامل ضريبة القيمة المضافة (5%)" in Arabic', () => {
    expect(formatTaxRowLabel(1000, 5, true, false, identity)).toBe('Incl. VAT (5%)');
    expect(formatTaxRowLabel(1000, 5, true, true, identity)).toBe('شامل ضريبة القيمة المضافة (5%)');
  });

  it('trims trailing zeros off the rate: 5 not 5.00, 5.5 not 5.50', () => {
    expect(formatTaxRowLabel(1000, 5, false, false, identity)).toBe('VAT (5%)');
    expect(formatTaxRowLabel(1000, 5.5, false, false, identity)).toBe('VAT (5.5%)');
    expect(formatTaxRowLabel(1000, 5.25, false, false, identity)).toBe('VAT (5.25%)');
  });

  it('passes the formatted percentage through `localize` (Arabic-numeral opt-in)', () => {
    const toArabicDigits = (v: string | number) => String(v).replace(/5/g, '٥');
    expect(formatTaxRowLabel(1000, 5, false, false, toArabicDigits)).toBe('VAT (٥%)');
  });
});
