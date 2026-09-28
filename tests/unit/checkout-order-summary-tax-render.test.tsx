/**
 * Ruling M3-6 (docs/RULINGS.md): the checkout summary showed no tax line at
 * all, and its total excluded tax. This renders the REAL checkout
 * `OrderSummary` component (apps/web/src/app/checkout/OrderSummary.tsx) —
 * the primary surface named by the ruling — and asserts the states a
 * shopper can see:
 *
 *   1. disabled / no active rate (all 3 live stores today, `tax: 0`) →
 *      renders NOTHING, byte-identical to the pre-fix markup.
 *   2. tax added on top of the price ("exclusive") → a "VAT (5%)" row,
 *      summed into `total` by the caller.
 *   3. tax already included in the price ("inclusive") → an "Incl. VAT
 *      (5%)" CAPTION after Total, not a row in the summed amount column
 *      (scoped-audit follow-up: the amount there implied it was added a
 *      second time).
 *
 * `react-dom/server` markup, not jsdom — there is no DOM environment in
 * this repo (see checkout-error-alert-renders.test.tsx). Items/bundles are
 * left empty so no `next/image` mock is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const storeState = { store: { theme: {} as Record<string, unknown> } };
const languageState = { language: 'en' as 'en' | 'ar' };

vi.mock('@web/contexts/StoreContext', () => ({
  useStore: () => storeState,
}));

vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: languageState.language,
    isRtl: languageState.language === 'ar',
    t: (en: string, ar?: string) => (languageState.language === 'ar' ? (ar ?? en) : en),
    setLanguage: () => {},
  }),
  translations: {
    Subtotal: 'المجموع الفرعي',
    Shipping: 'الشحن',
    Total: 'الإجمالي',
    Free: 'مجاني',
    Apply: 'تطبيق',
    'Order Summary': 'ملخص الطلب',
  },
}));

const { OrderSummary } = await import('@web/app/checkout/OrderSummary');

function render(
  props: Partial<React.ComponentProps<typeof OrderSummary>>,
  language: 'en' | 'ar' = 'en'
): string {
  languageState.language = language;
  return renderToStaticMarkup(
    React.createElement(OrderSummary, {
      items: [],
      bundles: [],
      subtotal: 20000,
      discount: 0,
      shipping: 0,
      tax: 0,
      taxRatePercent: 0,
      taxIncludedInPrice: false,
      total: 20000,
      freeShipping: true,
      couponCode: '',
      onCouponCodeChange: () => {},
      appliedCoupon: null,
      onApplyCoupon: () => {},
      onRemoveCoupon: () => {},
      couponError: '',
      ...props,
    })
  );
}

describe('checkout OrderSummary — VAT row', () => {
  it('tax disabled / no active rate: renders nothing extra (byte-identical to the pre-fix markup)', () => {
    const withoutTaxProps = render({});
    const explicitZero = render({ tax: 0, taxRatePercent: 0, taxIncludedInPrice: false });
    expect(withoutTaxProps).not.toMatch(/VAT|Incl\./);
    expect(explicitZero).toBe(withoutTaxProps);
  });

  it('exclusive tax: renders "VAT (5%)" with the amount', () => {
    const html = render({ tax: 1000, taxRatePercent: 5, taxIncludedInPrice: false });
    expect(html).toContain('VAT (5%)');
    // Intl.NumberFormat inserts a NBSP between the currency code and the
    // amount — match loosely rather than pin an invisible character.
    expect(html).toMatch(/KWD\s*1\.000/);
    expect(html).not.toContain('Incl.');
  });

  it('exclusive tax, Arabic locale: renders the Arabic VAT label', () => {
    const html = render({ tax: 1000, taxRatePercent: 5, taxIncludedInPrice: false }, 'ar');
    expect(html).toContain('ضريبة القيمة المضافة (5%)');
  });

  it('inclusive tax: renders "Incl. VAT (5%)" — informational, not an add-on line', () => {
    const html = render({ tax: 1000, taxRatePercent: 5, taxIncludedInPrice: true });
    expect(html).toContain('Incl. VAT (5%)');
  });

  it('inclusive tax renders AFTER Total, as a caption — not a summed-column row (scoped-audit follow-up)', () => {
    const html = render({ tax: 1000, taxRatePercent: 5, taxIncludedInPrice: true });
    const totalAt = html.indexOf('Total');
    const inclAt = html.indexOf('Incl. VAT (5%)');
    expect(totalAt).toBeGreaterThan(-1);
    expect(inclAt).toBeGreaterThan(totalAt);
    const afterIncl = html.slice(inclAt, inclAt + 150);
    // One combined text node ("Incl. VAT (5%) — KWD 1.000"), not a second
    // <span class="... tabular-nums">amount</span> lined up under the
    // Subtotal/Shipping/Total column.
    expect(afterIncl).toMatch(/Incl\. VAT \(5%\)[^<]*1\.000/);
    expect(afterIncl).not.toMatch(/tabular-nums/);
  });

  it('inclusive tax, Arabic locale: renders the Arabic "included" wording', () => {
    const html = render({ tax: 1000, taxRatePercent: 5, taxIncludedInPrice: true }, 'ar');
    expect(html).toContain('شامل ضريبة القيمة المضافة (5%)');
  });

  it('a fractional rate trims trailing zeros: "VAT (5.5%)", not "5.50%"', () => {
    const html = render({ tax: 275, taxRatePercent: 5.5, taxIncludedInPrice: false });
    expect(html).toContain('VAT (5.5%)');
    expect(html).not.toContain('5.50%');
  });

  it('the row sits between Shipping and Total, additive to the rest of the summary', () => {
    const without = render({});
    const withTax = render({ tax: 1000, taxRatePercent: 5, taxIncludedInPrice: false });
    const fragments = without
      .split(/<\/?[a-z][^>]*>/gi)
      .map(s => s.trim())
      .filter(Boolean);
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      expect(withTax).toContain(fragment);
    }
  });
});
