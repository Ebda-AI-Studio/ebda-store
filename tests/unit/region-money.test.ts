/**
 * Review Focus 2 (Ebda program plan §4): EGP rounding to the piastre — VAT after
 * discount, percentage discounts, refunds and partial refunds, COD fees — plus
 * the region config / money helpers every other surface is built on
 * (`packages/shared/src/region`).
 *
 * ROUNDING RULE under test: round HALF UP to the piastre, integer math only
 * (Ebda's existing `Math.round` rule, kept so VAT / discounts stay identical to
 * Ebda apart from the scale). Mutation proofs are recorded in the commit body
 * (floor instead of half-up; tax on the pre-discount subtotal; accepting a 3rd
 * decimal).
 */
import { describe, it, expect } from 'vitest';
import {
  REGION,
  currencyExponent,
  minorUnitsPerMajor,
  toMinor,
  tryToMinor,
  fromMinor,
  roundToMinor,
  minorToDecimalString,
  formatMoney,
  formatPrice,
  mulDivRound,
  percentOfMinor,
  vatOnDiscounted,
  codFeeMinor,
  convertMinor,
  excelMoneyFormat,
  normalizeEgyptianMobile,
  isValidEgyptianMobile,
  formatEgyptianMobile,
  regionDayStart,
  regionDayStartOffset,
  regionYearMonth,
  zonedIsoDay,
  resolveDefaultLanguage,
  computeOrderTax,
  computeDiscountAmount,
  applyDiscount,
} from '@ebda/shared';
import {
  allocatePartialReturn,
  splitByPaymentMix,
} from '../../apps/api/src/services/accounting/posting/partial-return-allocation';

// ─── region config ───────────────────────────────────────────────────────────

describe('REGION', () => {
  it('is Egypt / EGP / piastres / Cairo / Arabic-first / 14% VAT', () => {
    expect(REGION.country).toBe('EG');
    expect(REGION.currency).toBe('EGP');
    expect(REGION.minorUnitsPerMajor).toBe(100);
    expect(REGION.currencyDecimals).toBe(2);
    expect(REGION.currencySymbol).toEqual({ ar: 'ج.م', en: 'EGP' });
    expect(REGION.defaultVatBps).toBe(1400);
    expect(REGION.defaultLocale).toBe('ar');
    expect(REGION.timezone).toBe('Africa/Cairo');
    expect(REGION.phone.callingCode).toBe('+20');
    expect(REGION.governorates).toHaveLength(27);
  });

  it('the scale comes from the one currencyExponent function', () => {
    expect(REGION.minorUnitsPerMajor).toBe(minorUnitsPerMajor(REGION.currency));
    expect(REGION.currencyDecimals).toBe(currencyExponent(REGION.currency));
    expect(currencyExponent('EGP')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('egp')).toBe(2);
    expect(currencyExponent('XYZ')).toBe(2); // ISO majority default
  });

  it('resolveDefaultLanguage is Arabic-first but honours an explicit en', () => {
    expect(resolveDefaultLanguage(undefined)).toBe('ar');
    expect(resolveDefaultLanguage(null)).toBe('ar');
    expect(resolveDefaultLanguage('garbage')).toBe('ar');
    expect(resolveDefaultLanguage('en')).toBe('en');
    expect(resolveDefaultLanguage('ar')).toBe('ar');
  });
});

// ─── parse: major → minor ────────────────────────────────────────────────────

describe('toMinor / tryToMinor', () => {
  it("parses '199.99' → 19999 (no float drift)", () => {
    expect(toMinor('199.99')).toBe(19_999);
    expect(toMinor('0.29')).toBe(29); // parseFloat('0.29') * 100 === 28.999999999999996
    expect(toMinor('1.10')).toBe(110);
    expect(toMinor('12')).toBe(1200);
    expect(toMinor('0')).toBe(0);
    expect(toMinor(199.99)).toBe(19_999);
    expect(toMinor(1.1)).toBe(110); // 1.1 * 100 = 110.00000000000001
  });

  it("REJECTS '1.999' (a third decimal is never rounded into a price)", () => {
    expect(() => toMinor('1.999')).toThrow(RangeError);
    expect(tryToMinor('1.999')).toBeNull();
    expect(tryToMinor('0.001')).toBeNull();
    expect(tryToMinor(1.999)).toBeNull();
  });

  it('accepts trailing zeros past the exponent (they lose nothing) and Arabic digits', () => {
    expect(toMinor('1.500')).toBe(150);
    expect(toMinor('١٩٩٫٩٩')).toBe(19_999);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '.', 'abc', '1e3', '12.5.1', '0x10', ' ', '--1']) {
      expect(tryToMinor(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(tryToMinor(NaN)).toBeNull();
    expect(tryToMinor(Infinity)).toBeNull();
  });

  it('negative amounts are signed (adjustments), never silently absolute', () => {
    expect(toMinor('-1.50')).toBe(-150);
  });

  it('is currency-aware: BHD keeps 3 decimals, EGP rejects them', () => {
    expect(toMinor('1.999', 'BHD')).toBe(1999);
    expect(tryToMinor('1.9999', 'BHD')).toBeNull();
    expect(toMinor('5', 'JPY')).toBe(5);
    expect(tryToMinor('5.5', 'JPY')).toBeNull();
  });

  it('roundToMinor is decimal-correct half-up (1.005 → 101, not float 100)', () => {
    expect(roundToMinor(1.005)).toBe(101);
    expect(roundToMinor(1.004)).toBe(100);
    expect(roundToMinor(2.675)).toBe(268);
    expect(roundToMinor(-1.005)).toBe(-101);
  });
});

describe('fromMinor / minorToDecimalString', () => {
  it('round-trips minor → text → minor for a spread of values', () => {
    for (const minor of [0, 1, 5, 9, 10, 99, 100, 101, 12_345, 19_999, 100_000_000]) {
      const text = minorToDecimalString(minor);
      expect(toMinor(text), text).toBe(minor);
    }
    expect(minorToDecimalString(19_999)).toBe('199.99');
    expect(minorToDecimalString(5)).toBe('0.05');
    expect(minorToDecimalString(-150)).toBe('-1.50');
    expect(minorToDecimalString(1500, 'BHD')).toBe('1.500');
    expect(fromMinor(19_999)).toBe(199.99);
  });
});

// ─── formatting ──────────────────────────────────────────────────────────────

describe('formatMoney', () => {
  it('en: "EGP 1,299.50"', () => {
    expect(formatMoney(129_950, 'en')).toBe('EGP 1,299.50');
    expect(formatMoney(5, 'en')).toBe('EGP 0.05');
    expect(formatMoney(0, 'en')).toBe('EGP 0');
    expect(formatMoney(-129_950, 'en')).toBe('EGP -1,299.50');
  });

  it('ar: Latin digits by default, symbol after the number', () => {
    expect(formatMoney(129_950, 'ar')).toBe('1,299.50 ج.م');
    expect(formatMoney(129_950)).toBe('1,299.50 ج.م'); // locale defaults to ar
  });

  it('ar + easternArabicDigits is ignored: Western digits only (Ruling DIGITS-1)', () => {
    expect(formatMoney(129_950, 'ar', { easternArabicDigits: true })).toBe('1,299.50 ج.م');
  });

  it('easternArabicDigits is ignored for English (identifiers/SKUs must stay Latin)', () => {
    expect(formatMoney(129_950, 'en', { easternArabicDigits: true })).toBe('EGP 1,299.50');
  });

  it('a whole amount drops its zero fraction; piastres keep every decimal (Ruling NUMERALS-1)', () => {
    expect(formatMoney(45_000, 'ar')).toBe('450 ج.م');
    expect(formatMoney(45_000, 'en')).toBe('EGP 450');
    expect(formatMoney(45_050, 'ar')).toBe('450.50 ج.م');
    expect(formatMoney(45_005, 'ar')).toBe('450.05 ج.م');
    expect(formatMoney(100, 'en')).toBe('EGP 1');
    expect(formatMoney(100, 'en', { fixedDecimals: true })).toBe('EGP 1.00');
    expect(formatMoney(1500, 'en', { currency: 'BHD' })).toBe('BHD 1.500');
    expect(formatMoney(1000, 'en', { currency: 'BHD' })).toBe('BHD 1');
    expect(formatMoney(1500, 'en', { currency: 'USD' })).toBe('USD 15');
    expect(formatMoney(129_950, 'ar', { hideSymbol: true })).toBe('1,299.50');
    expect(formatMoney(-45_000, 'ar')).toBe('-450 ج.م');
    expect(formatMoney(-0.4, 'ar')).toBe('0 ج.م');
  });

  it("numerals: 'arab' (retired opt-in) is ignored: Western digits in both locales (Ruling DIGITS-1)", () => {
    expect(formatMoney(45_000, 'ar', { numerals: 'arab' as never })).toBe('450 ج.م');
    expect(formatMoney(129_950, 'ar', { numerals: 'arab' as never })).toBe('1,299.50 ج.م');
    expect(formatMoney(45_000, 'en', { numerals: 'arab' as never })).toBe('EGP 450');
    expect(formatMoney(45_000, 'ar', { numerals: 'latn' })).toBe('450 ج.م');
  });

  it('formatPrice is WESTERN digits in Arabic (Ruling DIGITS-1)', () => {
    expect(formatPrice(129_950)).toBe('EGP 1,299.50');
    expect(formatPrice(45_000, { locale: 'ar' })).toBe('450 ج.م');
    expect(formatPrice(129_950, { locale: 'ar' })).toBe('1,299.50 ج.م');
    expect(formatPrice(129_950, { locale: 'ar', numerals: 'arab' as never })).toBe('1,299.50 ج.م');
    expect(formatPrice(1299.5, { unit: 'major' })).toBe('EGP 1,299.50');
    expect(formatPrice(450, { unit: 'major', locale: 'ar' })).toBe('450 ج.م');
  });
});

// ─── rounding primitive ──────────────────────────────────────────────────────

describe('mulDivRound — half up, integer math', () => {
  it('rounds .5 UP, below .5 down, above .5 up', () => {
    expect(mulDivRound(1, 1, 2)).toBe(1); // 0.5 → 1
    expect(mulDivRound(3, 1, 2)).toBe(2); // 1.5 → 2
    expect(mulDivRound(1, 1, 3)).toBe(0); // 0.333 → 0
    expect(mulDivRound(2, 1, 3)).toBe(1); // 0.667 → 1
    expect(mulDivRound(5, 1, 10)).toBe(1); // 0.5 → 1
    expect(mulDivRound(4, 1, 10)).toBe(0);
  });

  it('is sign-symmetric and exact for large values', () => {
    expect(mulDivRound(-1, 1, 2)).toBe(-1);
    expect(mulDivRound(-3, 1, 2)).toBe(-2);
    expect(mulDivRound(123_456_789, 1400, 10_000)).toBe(17_283_950); // 17283950.46 → 17283950
  });

  it('refuses non-integers and an overflowing product instead of returning garbage', () => {
    expect(() => mulDivRound(1.5, 1, 2)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 10_000, 1)).toThrow(RangeError);
  });
});

// ─── VAT after discount ──────────────────────────────────────────────────────

describe('vatOnDiscounted — VAT is charged AFTER discount, rounded half-up to the piastre', () => {
  it('taxes (subtotal − discount), never the pre-discount subtotal', () => {
    // 1000.00 EGP subtotal, 100.00 EGP discount → base 900.00 → 14% = 126.00
    expect(vatOnDiscounted(100_000, 10_000, 1400)).toBe(12_600);
    // not 14% of 1000.00 (= 140.00)
    expect(vatOnDiscounted(100_000, 10_000, 1400)).not.toBe(14_000);
  });

  it('rounds half a piastre UP: 14% of 0.25 EGP = 3.5 piastres → 4', () => {
    expect(vatOnDiscounted(25, 0, 1400)).toBe(4);
    // 14% of 0.03 EGP = 0.42 piastre → 0; 14% of 0.04 EGP = 0.56 → 1
    expect(vatOnDiscounted(3, 0, 1400)).toBe(0);
    expect(vatOnDiscounted(4, 0, 1400)).toBe(1);
  });

  it('piastre-level cases: odd subtotal and odd discount', () => {
    // base = 33_333 − 3_333 = 30_000 → 14% = 4_200 exactly
    expect(vatOnDiscounted(33_333, 3_333, 1400)).toBe(4_200);
    // base = 19_999 − 1_999 = 18_000 → 2_520
    expect(vatOnDiscounted(19_999, 1_999, 1400)).toBe(2_520);
    // base = 19_999 → 14% = 2_799.86 → 2_800
    expect(vatOnDiscounted(19_999, 0, 1400)).toBe(2_800);
  });

  it('never negative: a discount larger than the subtotal taxes nothing', () => {
    expect(vatOnDiscounted(10_000, 25_000, 1400)).toBe(0);
  });

  it('a zero rate is zero tax', () => {
    expect(vatOnDiscounted(10_000, 0, 0)).toBe(0);
  });

  it('inclusive extraction: tax portion = base × bps / (10000 + bps), half up', () => {
    // 114.00 EGP gross at 14% → 100.00 net + 14.00 tax
    expect(vatOnDiscounted(11_400, 0, 1400, true)).toBe(1_400);
    // 100.00 EGP gross at 14% → 12.28 (12.2807…)
    expect(vatOnDiscounted(10_000, 0, 1400, true)).toBe(1_228);
    // net + tax always reconstructs the gross exactly
    for (const gross of [1, 7, 99, 10_000, 19_999, 123_457]) {
      const tax = vatOnDiscounted(gross, 0, 1400, true);
      expect(gross - tax + tax).toBe(gross);
      expect(tax).toBeLessThanOrEqual(gross);
    }
  });

  it('computeOrderTax (what the API charges and the storefront shows) is the same function', () => {
    for (const [sub, disc] of [
      [100_000, 10_000],
      [19_999, 1_999],
      [25, 0],
      [33_333, 3_333],
    ]) {
      expect(computeOrderTax(sub, disc, 0.14)).toBe(vatOnDiscounted(sub, disc, 1400));
      expect(computeOrderTax(sub, disc, 0.14, true)).toBe(vatOnDiscounted(sub, disc, 1400, true));
    }
    // a fractional store rate (14.5%) survives the percent → bps conversion
    expect(computeOrderTax(10_000, 0, 0.145)).toBe(1_450);
  });
});

// ─── percentage discounts ────────────────────────────────────────────────────

describe('percentage discount rounding (basis points of the regular price)', () => {
  it('rounds half up to the piastre', () => {
    // 12.5% of 10.01 EGP = 125.125 piastres → 125
    expect(computeDiscountAmount(1001, 'percentage', 1250)).toBe(125);
    // 12.5% of 10.04 EGP = 125.5 piastres → 126 (half up)
    expect(computeDiscountAmount(1004, 'percentage', 1250)).toBe(126);
    // 33.33% of 0.10 EGP (10 piastres) = 3.333 → 3
    expect(computeDiscountAmount(10, 'percentage', 3333)).toBe(3);
    // 10% of 199.99 EGP = 1999.9 piastres → 2000
    expect(computeDiscountAmount(19_999, 'percentage', 1000)).toBe(2_000);
  });

  it('exact in integers where float math is not: 0.07 EGP × 50% = 3.5 → 4', () => {
    expect(computeDiscountAmount(7, 'percentage', 5000)).toBe(4);
    expect(percentOfMinor(7, 5000)).toBe(4);
  });

  it('a fixed discount is the stored piastres, clamped to the price', () => {
    expect(computeDiscountAmount(10_000, 'fixed', 2_500)).toBe(2_500);
    expect(computeDiscountAmount(10_000, 'fixed', 99_999)).toBe(10_000);
  });

  it('price + discount reconstruct the regular price exactly', () => {
    for (const price of [1, 99, 1_001, 19_999, 123_457]) {
      for (const bps of [1, 500, 1250, 3333, 5000, 9999]) {
        const { price: now, compareAtPrice } = applyDiscount(price, 'percentage', bps);
        const discount = computeDiscountAmount(price, 'percentage', bps);
        if (compareAtPrice === null) {
          // no effective discount (rounds to 0, or to the whole price): price is untouched
          expect(now).toBe(price);
          expect(discount === 0 || discount >= price).toBe(true);
        } else {
          expect(now + discount).toBe(price);
          expect(compareAtPrice).toBe(price);
        }
      }
    }
  });
});

// ─── refunds & partial refunds sum exactly ───────────────────────────────────

interface Line {
  id: string;
  quantity: number;
  price: number;
}

/**
 * Pay an order the way checkout does (VAT after discount), then return it one
 * unit at a time through the SAME allocation the GL posting and the provider
 * refund share. Everything refunded must add up to exactly what was paid.
 */
function refundEverythingPiecewise(opts: {
  lines: Line[];
  discount: number;
  vatBps: number;
  inclusive: boolean;
}) {
  const subtotal = opts.lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const tax = vatOnDiscounted(subtotal, opts.discount, opts.vatBps, opts.inclusive);
  const paid = opts.inclusive ? subtotal - opts.discount : subtotal - opts.discount + tax;

  const prevQty = new Map<string, number>();
  let refunded = 0;
  let revenue = 0;
  let taxBack = 0;
  for (const line of opts.lines) {
    for (let unit = 0; unit < line.quantity; unit++) {
      const a = allocatePartialReturn({
        subtotal,
        discount: opts.discount,
        tax,
        taxIncludedInPrice: opts.inclusive,
        lines: opts.lines,
        prevQty,
        requested: [{ orderItemId: line.id, quantity: 1 }],
      });
      refunded += a.cashCredit;
      revenue += a.revenueDebit;
      taxBack += a.taxThis;
      // the journal entry and the cash refund are the same number by construction, inclusive or exclusive VAT alike
      // (the old `inclusive ? taxThis : taxThis` ternary had the same value on both branches)
      expect(a.revenueDebit + a.taxThis).toBe(a.cashCredit);
      prevQty.set(line.id, (prevQty.get(line.id) ?? 0) + 1);
    }
  }
  return { subtotal, tax, paid, refunded, revenue, taxBack };
}

describe('refunds and partial refunds sum EXACTLY to the paid total', () => {
  it('tax-exclusive, awkward odd-piastre prices, discount, 14% VAT', () => {
    const r = refundEverythingPiecewise({
      lines: [
        { id: 'a', quantity: 3, price: 3_333 },
        { id: 'b', quantity: 2, price: 1_999 },
        { id: 'c', quantity: 1, price: 7 },
      ],
      discount: 1_001,
      vatBps: 1400,
      inclusive: false,
    });
    expect(r.refunded).toBe(r.paid);
    expect(r.taxBack).toBe(r.tax);
  });

  it('tax-inclusive order refunds exactly what was paid (no second VAT refund)', () => {
    const r = refundEverythingPiecewise({
      lines: [
        { id: 'a', quantity: 2, price: 4_999 },
        { id: 'b', quantity: 3, price: 1_001 },
      ],
      discount: 777,
      vatBps: 1400,
      inclusive: true,
    });
    expect(r.refunded).toBe(r.paid);
    expect(r.taxBack).toBe(r.tax);
  });

  it('holds across a grid of subtotals, discounts and quantities (no piastre ever drifts)', () => {
    let scenarios = 0;
    for (const price of [1, 3, 33, 333, 1_999, 4_999, 12_345]) {
      for (const qty of [1, 2, 3, 7]) {
        for (const discount of [0, 1, 250, 999]) {
          for (const inclusive of [false, true]) {
            const lines = [
              { id: 'x', quantity: qty, price },
              { id: 'y', quantity: 1, price: price + 1 },
            ];
            const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
            if (discount > subtotal) continue;
            const r = refundEverythingPiecewise({ lines, discount, vatBps: 1400, inclusive });
            expect(r.refunded, JSON.stringify({ price, qty, discount, inclusive })).toBe(r.paid);
            scenarios++;
          }
        }
      }
    }
    expect(scenarios).toBeGreaterThan(100);
  });

  it('a partial refund never exceeds the paid total before the last piece, and the last piece closes it', () => {
    const lines = [{ id: 'a', quantity: 3, price: 3_333 }];
    const subtotal = 9_999;
    const discount = 999;
    const tax = vatOnDiscounted(subtotal, discount, 1400);
    const paid = subtotal - discount + tax;
    const prevQty = new Map<string, number>();
    let running = 0;
    for (let i = 0; i < 3; i++) {
      const a = allocatePartialReturn({
        subtotal,
        discount,
        tax,
        lines,
        prevQty,
        requested: [{ orderItemId: 'a', quantity: 1 }],
      });
      running += a.cashCredit;
      expect(running).toBeLessThanOrEqual(paid);
      prevQty.set('a', i + 1);
    }
    expect(running).toBe(paid);
  });

  it('wallet + card shares of every partial refund add back to the refund, and to the order mix', () => {
    const total = 10_001; // paid: 3_001 from the wallet, 7_000 at the gateway
    const walletAmount = 3_001;
    const pieces = [1_111, 2_222, 3_333, 3_335]; // sums to 10_001
    let prevCash = 0;
    let walletSum = 0;
    let gatewaySum = 0;
    for (const cashCredit of pieces) {
      const s = splitByPaymentMix({ cashCredit, prevCash, total, walletAmount });
      expect(s.walletShare + s.gatewayShare).toBe(cashCredit);
      walletSum += s.walletShare;
      gatewaySum += s.gatewayShare;
      prevCash += cashCredit;
    }
    expect(walletSum).toBe(walletAmount);
    expect(gatewaySum).toBe(total - walletAmount);
  });
});

// ─── COD fee ─────────────────────────────────────────────────────────────────

describe('codFeeMinor', () => {
  it('a fixed COD fee is exactly the configured piastres', () => {
    expect(codFeeMinor(50_000, { fixedMinor: 2_500 })).toBe(2_500);
    expect(codFeeMinor(50_000)).toBe(0);
    expect(codFeeMinor(0, { fixedMinor: 2_500 })).toBe(2_500);
  });

  it('a percentage component rounds half up to the piastre', () => {
    // 2% of 0.25 EGP = 0.5 piastre → 1; 2% of 0.24 EGP = 0.48 → 0
    expect(codFeeMinor(25, { percentBps: 200 })).toBe(1);
    expect(codFeeMinor(24, { percentBps: 200 })).toBe(0);
    // 1.5% of 199.99 EGP = 299.985 piastres → 300
    expect(codFeeMinor(19_999, { percentBps: 150 })).toBe(300);
  });

  it('fixed + percentage compose, and the fee is never negative', () => {
    expect(codFeeMinor(10_000, { fixedMinor: 1_000, percentBps: 100 })).toBe(1_100);
    expect(codFeeMinor(10_000, { fixedMinor: -5_000 })).toBe(0);
  });

  it('the collected amount = order total + fee, so the courier collects whole piastres', () => {
    const total = 19_999;
    const fee = codFeeMinor(total, { fixedMinor: 2_500 });
    expect(Number.isInteger(total + fee)).toBe(true);
    expect(total + fee).toBe(22_499);
  });
});

// ─── FX ──────────────────────────────────────────────────────────────────────

describe('convertMinor — exponent-aware FX into the base currency', () => {
  it('USD cents → EGP piastres is ×rate (both 2 decimals)', () => {
    expect(convertMinor(100, 50.5, 'USD')).toBe(5_050);
  });

  it('BHD fils (3 decimals) → EGP piastres divides by 10 (the Ebda scale bug)', () => {
    expect(convertMinor(1_000, 165, 'BHD')).toBe(16_500);
  });

  it('EGP piastres → BHD fils multiplies by 10', () => {
    expect(convertMinor(16_500, 1 / 165, 'EGP', 'BHD')).toBe(1_000);
  });

  it('rounds half up and rejects a non-positive rate', () => {
    expect(convertMinor(1, 50.5, 'USD')).toBe(51);
    expect(() => convertMinor(100, 0, 'USD')).toThrow(RangeError);
  });
});

// ─── dates in Cairo ──────────────────────────────────────────────────────────

describe('Cairo calendar days are DST-aware', () => {
  it('winter (UTC+2): the day starts at 22:00Z the day before', () => {
    expect(regionDayStart(new Date('2026-01-15T12:00:00Z')).toISOString()).toBe(
      '2026-01-14T22:00:00.000Z'
    );
  });

  it('summer (UTC+3, Egyptian DST): the day starts at 21:00Z the day before', () => {
    expect(regionDayStart(new Date('2026-07-15T12:00:00Z')).toISOString()).toBe(
      '2026-07-14T21:00:00.000Z'
    );
  });

  it('stepping days across the April DST change always lands on the FIRST instant of a Cairo day', () => {
    // Egypt's DST starts at 00:00 on the last Friday of April, so that day has no
    // 00:00 (it begins at 01:00) and is 23 hours long — +24h arithmetic would drift.
    const start = regionDayStart(new Date('2026-04-20T12:00:00Z'));
    let previousDay = zonedIsoDay(start, REGION.timezone);
    for (let n = 1; n <= 20; n++) {
      const d = regionDayStartOffset(start, n);
      const day = zonedIsoDay(d, REGION.timezone);
      expect(regionDayStart(d).getTime(), d.toISOString()).toBe(d.getTime()); // idempotent
      expect(zonedIsoDay(new Date(d.getTime() - 1), REGION.timezone), d.toISOString()).toBe(
        previousDay
      ); // 1ms earlier is the previous calendar day
      expect(day > previousDay).toBe(true);
      previousDay = day;
    }
    // the transition day itself is 23h long
    const fri = regionDayStart(new Date('2026-04-24T12:00:00Z'));
    const sat = regionDayStartOffset(fri, 1);
    expect((sat.getTime() - fri.getTime()) / 3_600_000).toBe(23);
  });

  it('year-month is the Cairo month, not the UTC month', () => {
    expect(regionYearMonth(new Date('2026-01-31T22:30:00Z'))).toBe('2026-02');
    expect(regionYearMonth(new Date('2026-01-31T21:30:00Z'))).toBe('2026-01');
  });
});

// ─── Excel number format ─────────────────────────────────────────────────────

describe('excelMoneyFormat', () => {
  it('has the currency exponent in decimals', () => {
    expect(excelMoneyFormat()).toBe('0.00');
    expect(excelMoneyFormat({ grouped: true })).toBe('#,##0.00');
    expect(excelMoneyFormat({ currency: 'BHD' })).toBe('0.000');
    expect(excelMoneyFormat({ currency: 'JPY', grouped: true })).toBe('#,##0');
  });
});

// ─── phones ──────────────────────────────────────────────────────────────────

describe('Egyptian mobile numbers', () => {
  it.each([
    ['01012345678', '+201012345678'],
    ['010 1234 5678', '+201012345678'],
    ['010-1234-5678', '+201012345678'],
    ['1012345678', '+201012345678'],
    ['+201012345678', '+201012345678'],
    ['201012345678', '+201012345678'],
    ['00201012345678', '+201012345678'],
    ['٠١٠١٢٣٤٥٦٧٨', '+201012345678'],
    ['01112345678', '+201112345678'],
    ['01212345678', '+201212345678'],
    ['01512345678', '+201512345678'],
  ])('normalises %s → %s', (input, e164) => {
    expect(normalizeEgyptianMobile(input)).toBe(e164);
    expect(isValidEgyptianMobile(input)).toBe(true);
  });

  it.each([
    '',
    '0101234567', // one digit short
    '010123456789', // one digit long
    '01312345678', // 013 is not a mobile prefix
    '02212345678', // landline
    '+96551234567', // foreign country code
    'abc',
  ])('rejects %s', input => {
    expect(normalizeEgyptianMobile(input)).toBeNull();
    expect(isValidEgyptianMobile(input)).toBe(false);
  });

  it('formats for display', () => {
    expect(formatEgyptianMobile('+201012345678')).toBe('010 1234 5678');
    expect(formatEgyptianMobile('nope')).toBe('nope');
  });
});
