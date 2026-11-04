/**
 * Money fixes batch B — the pure money core (rulings MONEYB-1..3, MONEYB-7).
 *
 *  - VAT base = goods after discount + shipping + COD fee (VAT Law 67/2016
 *    Art. 10), exclusive and inclusive; one order of operations.
 *  - COD fee = fixed + % of (goods after discount + shipping), quoted and
 *    frozen by the same function.
 *  - Sale-document lines (items, shipping, COD fee, extra) minus discounts
 *    (+ VAT when exclusive) equal the order total.
 *  - Phones stored as E.164 whatever digits the shopper typed.
 */
import { describe, expect, it } from 'vitest';
import {
  codFeeForOrder,
  computeOrderAmounts,
  normalizePhoneForStorage,
  orderAddressLines,
  taxInvoiceInfo,
} from '@ebda/shared';
import {
  buildSaleLines,
  documentBalance,
  fiscalNumber,
  retainUntil,
} from '@api/services/fiscal-document.service';

describe('computeOrderAmounts — VAT base includes shipping and the COD fee', () => {
  it('exclusive 14%: 1000 goods − 100 discount + 50 shipping + 10 COD → VAT on 960', () => {
    const a = computeOrderAmounts({
      subtotal: 100_000,
      discount: 10_000,
      shipping: 5_000,
      codFee: 1_000,
      ratePercent: 14,
    });
    expect(a.taxableAmount).toBe(96_000);
    expect(a.tax).toBe(13_440);
    expect(a.total).toBe(96_000 + 13_440);
  });

  it('shipping alone carries VAT (the old base ignored it)', () => {
    const withShip = computeOrderAmounts({
      subtotal: 10_000,
      discount: 0,
      shipping: 5_000,
      ratePercent: 14,
    });
    const noShip = computeOrderAmounts({
      subtotal: 10_000,
      discount: 0,
      shipping: 0,
      ratePercent: 14,
    });
    expect(withShip.tax - noShip.tax).toBe(700); // 14% of 50 EGP
  });

  it('inclusive: everything is gross, VAT is extracted and the total is not raised', () => {
    const a = computeOrderAmounts({
      subtotal: 11_400,
      discount: 0,
      shipping: 5_700,
      codFee: 0,
      ratePercent: 14,
      includedInPrice: true,
    });
    expect(a.total).toBe(17_100);
    expect(a.tax).toBe(2_100);
    expect(a.taxableAmount).toBe(15_000);
  });

  it('no rate → no tax, total = goods − discount + shipping + COD', () => {
    expect(
      computeOrderAmounts({
        subtotal: 5_000,
        discount: 6_000,
        shipping: 1_000,
        codFee: 200,
        ratePercent: 0,
      })
    ).toEqual({ taxableAmount: 1_200, tax: 0, total: 1_200 });
  });
});

describe('codFeeForOrder — quoted before the order, frozen by the same function', () => {
  it('fixed + percentage of goods-after-discount + shipping, half up', () => {
    // cart 540 EGP, fixed 10 + 2%: 2% of 540 = 10.80 → 20.80 EGP (audit O4 example)
    expect(
      codFeeForOrder(
        { subtotal: 54_000, discount: 0, shipping: 0 },
        { fixedFee: 1_000, percentBps: 200 }
      )
    ).toBe(2_080);
    // the percentage includes shipping, never VAT or the fee itself
    expect(
      codFeeForOrder({ subtotal: 10_000, discount: 2_000, shipping: 3_000 }, { percentBps: 100 })
    ).toBe(110);
  });
  it('no config / COD off → 0; negative inputs never produce a negative fee', () => {
    expect(codFeeForOrder({ subtotal: 10_000, discount: 0, shipping: 0 }, null)).toBe(0);
    expect(codFeeForOrder({ subtotal: 10_000, discount: 0, shipping: 0 }, { fixedFee: -500 })).toBe(
      0
    );
  });
});

describe('sale document lines balance to the order total', () => {
  const base = {
    items: [
      {
        id: 'i1',
        productName: 'Tee',
        variantName: null,
        sku: 'T1',
        quantity: 2,
        price: 10_000,
        total: 20_000,
        product: { nameAr: 'تيشيرت' },
      },
    ] as never,
    subtotal: 20_000,
    discount: 2_000,
    couponDiscount: 2_000,
    couponCode: 'EID',
    promotionDiscount: 0,
    loyaltyDiscount: 0,
    loyaltyPointsRedeemed: null,
    shipping: 5_000,
    codFee: 1_000,
    extraAmount: 0,
    extraAmountNote: null,
    appliedPromotion: null,
  };

  it('items + shipping + COD fee − discount + exclusive VAT = total', () => {
    const amounts = computeOrderAmounts({
      subtotal: 20_000,
      discount: 2_000,
      shipping: 5_000,
      codFee: 1_000,
      ratePercent: 14,
    });
    const { lines, discounts } = buildSaleLines(base);
    expect(lines.map(l => l.kind)).toEqual(['item', 'shipping', 'cod_fee']);
    expect(discounts).toEqual([{ kind: 'coupon', label: 'EID', amount: 2_000 }]);
    expect(
      documentBalance({
        lines,
        discounts,
        vat: amounts.tax,
        taxIncludedInPrice: false,
        total: amounts.total,
      })
    ).toBe(0);
  });

  it('a missing COD line would unbalance it (mutation guard for the old invoice)', () => {
    const { lines, discounts } = buildSaleLines({ ...base, codFee: 0 });
    // total still contains the fee: the document is off by exactly the fee
    expect(
      documentBalance({ lines, discounts, vat: 0, taxIncludedInPrice: false, total: 24_000 })
    ).toBe(-1_000);
  });

  it('a payment-link extra amount is its own line', () => {
    const { lines } = buildSaleLines({ ...base, extraAmount: 3_000, extraAmountNote: 'Deposit' });
    expect(lines.find(l => l.kind === 'extra')).toMatchObject({
      description: 'Deposit',
      amount: 3_000,
    });
  });
});

describe('document numbers and retention', () => {
  it('per-type prefixes, zero-padded serial — never the order number', () => {
    expect(fiscalNumber('tax_invoice', 42)).toBe('INV-000042');
    expect(fiscalNumber('receipt', 1)).toBe('RCT-000001');
    expect(fiscalNumber('credit_note', 7)).toBe('CRN-000007');
    expect(fiscalNumber('refund_receipt', 1234567)).toBe('RFR-1234567');
  });
  it('kept 7 years from issue (Ruling RETENTION-1)', () => {
    expect(retainUntil(new Date('2026-10-08T10:00:00Z')).toISOString()).toBe(
      '2033-10-08T10:00:00.000Z'
    );
  });
});

describe('taxInvoiceInfo reads the frozen base', () => {
  const order = {
    sellerTaxRegistrationNumber: '123-456-789',
    sellerTaxLegalName: 'Shop LLC',
    taxRateBps: 1400,
    subtotal: 20_000,
    discount: 2_000,
    tax: 3_360,
    taxIncludedInPrice: false,
  };
  it('new order: taxable = goods − discount + shipping + COD as frozen', () => {
    expect(taxInvoiceInfo({ ...order, taxableAmount: 24_000 })?.taxableAmount).toBe(24_000);
  });
  it('legacy order (no frozen base): goods − discount, as it was taxed', () => {
    expect(taxInvoiceInfo({ ...order, taxableAmount: null })?.taxableAmount).toBe(18_000);
  });
});

describe('normalizePhoneForStorage — one stored phone form', () => {
  it.each([
    ['01012345678', '+201012345678'],
    ['٠١٠١٢٣٤٥٦٧٨', '+201012345678'],
    ['+20 10 1234 5678', '+201012345678'],
    ['0020-115-123-4567', '+201151234567'],
    ['(012) 3456-7890', '+201234567890'],
  ])('%s → %s', (raw, e164) => {
    expect(normalizePhoneForStorage(raw)).toBe(e164);
  });
  it('a landline / foreign number keeps its digits (ASCII), separators dropped', () => {
    expect(normalizePhoneForStorage('٠٢ ٢٣٤٥ ٦٧٨٩')).toBe('0223456789');
    expect(normalizePhoneForStorage('+966 50 123 4567')).toBe('+966501234567');
  });
  it('empty / absent stay as they are', () => {
    expect(normalizePhoneForStorage('')).toBe('');
    expect(normalizePhoneForStorage(undefined)).toBeUndefined();
    expect(normalizePhoneForStorage(null)).toBeNull();
  });
});

describe('orderAddressLines — governorate, area and landmark, never ", "', () => {
  const addr = {
    address1: 'شارع النصر، مبنى 5',
    address2: 'بجوار مسجد الرحمن',
    area: 'Nasr City',
    areaAr: 'مدينة نصر',
    governorate: 'Cairo',
    governorateAr: 'القاهرة',
    city: '',
    state: '',
    postalCode: '',
    country: 'Egypt',
  };
  it('Arabic', () => {
    expect(orderAddressLines(addr, 'ar')).toEqual([
      'شارع النصر، مبنى 5',
      'علامة مميزة: بجوار مسجد الرحمن',
      'مدينة نصر، القاهرة',
      'مصر',
    ]);
  });
  it('English', () => {
    expect(orderAddressLines(addr, 'en')).toEqual([
      'شارع النصر، مبنى 5',
      'Landmark: بجوار مسجد الرحمن',
      'Nasr City, Cairo',
      'Egypt',
    ]);
  });
  it('empty city/state never print a stray separator', () => {
    expect(orderAddressLines({ address1: 'X', city: '', state: '', country: '' }, 'en')).toEqual([
      'X',
    ]);
  });
});
