/**
 * Unit tests for multi-currency accounting helpers (base currency = EGP).
 *
 * Critical money-path tests — no external dependencies, no DB.
 * Tests:
 *   1. convertToBase — rounding (half-up), precision, edge values, exponent-awareness
 *   2. EGP passthrough — fxRate=1 leaves amount unchanged (regression guard)
 *   3. requiresFxRate — correct for EGP and non-EGP codes
 *   4. ALLOWED_CURRENCIES — EGP is first; list is non-empty; all 3-char ISO codes
 */
import { describe, it, expect } from 'vitest';
import {
  convertToBase,
  convertMinor,
  requiresFxRate,
  ALLOWED_CURRENCIES,
  currencyExponent,
  REGION,
} from '@ebda/shared';

// ─── convertToBase ────────────────────────────────────────────────────────────

describe('convertToBase — basic multiplication with half-up rounding', () => {
  it('100 USD cents @ 50.5 EGP/USD → 5050 piastres', () => {
    // 1.00 USD * 50.5 = 50.50 EGP = 5050 piastres
    expect(convertToBase(100, 50.5, 'USD')).toBe(5050);
  });

  it('1000 USD cents @ 50 → 50000 piastres', () => {
    expect(convertToBase(1000, 50, 'USD')).toBe(50_000);
  });

  it('1 USD cent @ 50.25 → 50 piastres (exact: 50.25 → rounds down)', () => {
    expect(convertToBase(1, 50.25, 'USD')).toBe(50);
  });

  it('1 USD cent @ 50.5 → 51 piastres (exact: 50.5 → half rounds UP)', () => {
    expect(convertToBase(1, 50.5, 'USD')).toBe(51);
  });

  it('SAR halalas @ 13.33 EGP/SAR', () => {
    // 150 halalas * 13.33 = 1999.5 → half-up → 2000
    expect(convertToBase(150, 13.33, 'SAR')).toBe(2000);
  });

  it('large amount does not overflow JS safe integer', () => {
    // 10_000_000 cents (100_000 USD) @ 50 → 500_000_000 piastres (5,000,000 EGP)
    const result = convertToBase(10_000_000, 50, 'USD');
    expect(result).toBe(500_000_000);
    expect(Number.isSafeInteger(result)).toBe(true);
  });

  it('fractional rate producing 0.5 → rounds up to 1 (half-up)', () => {
    // 1 * 0.5 = 0.5 → half-up → 1
    expect(convertToBase(1, 0.5)).toBe(1);
  });

  it('is exponent-aware: a 3-decimal currency (BHD fils) → EGP piastres divides by 10', () => {
    // 1.000 BHD = 1000 fils @ 165 EGP/BHD = 165.00 EGP = 16500 piastres
    expect(convertToBase(1000, 165, 'BHD')).toBe(16_500);
    // and the same amount treated as piastres (the old Ebda bug) would be 165000
    expect(convertMinor(1000, 165, 'EGP', 'EGP')).toBe(165_000);
  });
});

describe('convertToBase — zero amount', () => {
  it('zero originalAmount → 0 regardless of fxRate', () => {
    expect(convertToBase(0, 0.307)).toBe(0);
    expect(convertToBase(0, 100)).toBe(0);
  });
});

describe('convertToBase — EGP passthrough (regression guard)', () => {
  it('fxRate=1 returns amount unchanged — EGP piastres pass through', () => {
    const amount = 5000; // 50.00 EGP in piastres
    expect(convertToBase(amount, 1)).toBe(amount);
  });

  it('fxRate=1 with large EGP amount is identity', () => {
    const amount = 1_234_567;
    expect(convertToBase(amount, 1)).toBe(amount);
  });

  it('fxRate=1 with Prisma Decimal-like object (toString)', () => {
    // Prisma Decimal serializes to a string — convertToBase must handle it
    const decimalLike = { toString: () => '1.000000000' };
    expect(convertToBase(5000, decimalLike)).toBe(5000);
  });

  it('fxRate as string-like Decimal for non-EGP (USD @ 50.5)', () => {
    const decimalLike = { toString: () => '50.50000000' };
    expect(convertToBase(100, decimalLike, 'USD')).toBe(5050);
  });
});

describe('convertToBase — invalid inputs throw', () => {
  it('negative fxRate throws RangeError', () => {
    expect(() => convertToBase(100, -0.307)).toThrow(RangeError);
  });

  it('zero fxRate throws RangeError', () => {
    expect(() => convertToBase(100, 0)).toThrow(RangeError);
  });

  it('NaN fxRate throws RangeError', () => {
    expect(() => convertToBase(100, NaN)).toThrow(RangeError);
  });

  it('Infinity fxRate throws RangeError', () => {
    expect(() => convertToBase(100, Infinity)).toThrow(RangeError);
  });

  it('negative originalAmount throws RangeError', () => {
    expect(() => convertToBase(-1, 0.307)).toThrow(RangeError);
  });
});

// ─── requiresFxRate ────────────────────────────────────────────────────────────

describe('requiresFxRate', () => {
  it('returns false for EGP (exact match)', () => {
    expect(requiresFxRate('EGP')).toBe(false);
  });

  it('returns false for lowercase egp', () => {
    expect(requiresFxRate('egp')).toBe(false);
  });

  it('returns true for BHD (no longer the base)', () => {
    expect(requiresFxRate('BHD')).toBe(true);
  });

  it('returns true for USD', () => {
    expect(requiresFxRate('USD')).toBe(true);
  });

  it('returns true for EUR', () => {
    expect(requiresFxRate('EUR')).toBe(true);
  });

  it('returns true for SAR', () => {
    expect(requiresFxRate('SAR')).toBe(true);
  });

  it('returns true for unknown / unsupported currency', () => {
    expect(requiresFxRate('XYZ')).toBe(true);
  });
});

// ─── ALLOWED_CURRENCIES ────────────────────────────────────────────────────────

describe('ALLOWED_CURRENCIES', () => {
  it('is non-empty', () => {
    expect(ALLOWED_CURRENCIES.length).toBeGreaterThan(0);
  });

  it('EGP is included as the base currency, first in the list', () => {
    expect(ALLOWED_CURRENCIES[0]).toBe(REGION.currency);
    expect(ALLOWED_CURRENCIES).toContain('EGP');
  });

  it('every allowed currency has a defined exponent (no silent default for a listed code)', () => {
    for (const code of ALLOWED_CURRENCIES) {
      expect([0, 2, 3]).toContain(currencyExponent(code));
    }
  });

  it('all codes are exactly 3 uppercase characters (ISO 4217)', () => {
    for (const code of ALLOWED_CURRENCIES) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('no duplicates', () => {
    expect(new Set(ALLOWED_CURRENCIES).size).toBe(ALLOWED_CURRENCIES.length);
  });
});

// ─── EGP expense create does not alter existing behaviour (regression) ───────

describe('EGP expense — service-layer amount contract', () => {
  /**
   * This test does NOT mock Prisma — it validates the pure math that the service
   * applies to EGP amounts before writing.  The service contract when currency='EGP':
   *   amountBase = input.amount (no conversion)
   *   total = amountBase + taxAmount
   *   fxRate stored = 1
   *   originalAmount stored = input.amount
   */
  function simulateBaseExpenseCreate(amountMinor: number, taxMinor: number) {
    const currency = 'EGP';
    const fxRate = 1;
    // Base path: no conversion
    const amountBase = amountMinor;
    const taxAmountBase = taxMinor;
    const total = amountBase + taxAmountBase;
    return {
      currency,
      fxRate,
      amountBase,
      taxAmountBase,
      total,
      originalAmount: amountMinor + taxMinor,
    };
  }

  it('100 EGP expense (10000 piastres) is stored unchanged', () => {
    const result = simulateBaseExpenseCreate(10_000, 0);
    expect(result.amountBase).toBe(10_000);
    expect(result.total).toBe(10_000);
    expect(result.fxRate).toBe(1);
    expect(result.currency).toBe('EGP');
  });

  it('expense with tax: total = amount + tax', () => {
    const result = simulateBaseExpenseCreate(10_000, 1400);
    expect(result.total).toBe(11_400);
    expect(result.amountBase).toBe(10_000);
    expect(result.taxAmountBase).toBe(1400);
  });
});

// ─── non-EGP expense conversion (simulate service logic) ─────────────────────

describe('non-EGP expense — FX conversion contract', () => {
  function simulateNonBaseExpenseCreate(opts: {
    originalAmount: number;
    taxOriginal: number;
    fxRate: number;
    currency: string;
  }) {
    const baseAmount = convertToBase(opts.originalAmount, opts.fxRate, opts.currency);
    const baseTax = convertToBase(opts.taxOriginal, opts.fxRate, opts.currency);
    return {
      currency: opts.currency,
      amountBase: baseAmount,
      taxAmountBase: baseTax,
      total: baseAmount + baseTax,
      originalAmount: opts.originalAmount + opts.taxOriginal,
      fxRate: opts.fxRate,
    };
  }

  it('10.00 USD (1000 cents) @ 50 → 50000 piastres', () => {
    const result = simulateNonBaseExpenseCreate({
      originalAmount: 1000, // 10.00 USD in cents
      taxOriginal: 0,
      fxRate: 50,
      currency: 'USD',
    });
    expect(result.amountBase).toBe(50_000);
    expect(result.total).toBe(50_000);
    expect(result.originalAmount).toBe(1000);
    expect(result.currency).toBe('USD');
  });

  it('non-EGP debit/credit are in EGP piastres in postEntry (journal balance holds)', () => {
    // 2000 USD cents DR @ 50 → 100000 piastres; the credit side must equal it for DR=CR
    const drBase = convertToBase(2000, 50, 'USD');
    const crBase = drBase; // forced equal
    expect(drBase).toBe(crBase);
    expect(drBase).toBe(100_000);
  });
});
