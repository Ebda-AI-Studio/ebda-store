/**
 * Ruling NUMERALS-1 (Ahmad 2026-10-07): Western digits (0-9) are the default
 * everywhere, in Arabic AND English. Arabic-Indic (٠-٩) only for an Arabic
 * reader of a store that opted in (`theme.arabicNumerals === true`).
 *
 * The defect this pins: an Arabic store with the option OFF rendered product
 * card prices as `٤٥٠٫٠٠ ج.م` because `<Price isRtl>` asked the formatter for
 * `locale: 'ar'` and the formatter's Arabic default was Arabic-Indic.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  effectiveNumerals,
  formatCount,
  formatDateIntl,
  formatMoney,
  formatPrice,
  intlLocale,
  localizeDigits,
  storeNumerals,
  withNumerals,
} from '@ebda/shared';
import { Price } from '@ebda/ui';
import { getDiscountBadgeText } from '../../apps/web/src/lib/product-pricing';
import { formatDate } from '../../apps/web/src/lib/format-date';

const ARAB = /[٠-٩]/;
const DATE = new Date('2026-10-07T10:00:00Z');

describe('the default is Western digits in both languages', () => {
  it('a store with no / false / malformed flag is Western', () => {
    for (const theme of [undefined, null, {}, { arabicNumerals: false }, { arabicNumerals: 'yes' }])
      expect(storeNumerals(theme as never)).toBe('latn');
    expect(storeNumerals({ arabicNumerals: true })).toBe('arab');
  });

  it('prices: 450 ج.م in Arabic, EGP 450 in English, no Arabic-Indic', () => {
    expect(formatPrice(45_000, { locale: 'ar' })).toBe('450 ج.م');
    expect(formatPrice(45_000, { locale: 'en' })).toBe('EGP 450');
    expect(formatMoney(45_050, 'ar')).toBe('450.50 ج.م');
  });

  it('<Price isRtl> on a store that did not opt in renders Western digits', () => {
    const html = renderToStaticMarkup(<Price price={45_000} compareAtPrice={54_000} isRtl />);
    expect(html).toContain('450 ج.م');
    expect(html).toContain('540 ج.م');
    expect(html).not.toMatch(ARAB);
  });

  it('dates and counts in Arabic keep Arabic words but Western digits', () => {
    const ar = formatDate(DATE, { language: 'ar', timezone: 'Africa/Cairo' });
    expect(ar).toMatch(/2026/);
    expect(ar).not.toMatch(ARAB);
    expect(ar).toMatch(/[؀-ۿ]/); // still Arabic month/day names
    expect(formatDateIntl(DATE, 'ar')).not.toMatch(ARAB);
    expect(formatCount(1234, 'ar')).toBe('1,234');
    // the control: bare ar-EG really is Arabic-Indic on this ICU, so the pin is doing the work
    expect(new Intl.NumberFormat('ar-EG').format(42)).toMatch(ARAB);
    expect(new Intl.NumberFormat(intlLocale('ar')).format(42)).toBe('42');
    expect((42).toLocaleString('ar-EG', withNumerals())).toBe('42');
  });

  it('discount badges are Western unless the store opted in', () => {
    const product = { price: 45_000, compareAtPrice: 54_000 };
    expect(getDiscountBadgeText(product, true)).toBe('\u2066\u221217%\u2069');
    const fixed = { ...product, discountType: 'fixed', discountValue: 90 };
    expect(getDiscountBadgeText(fixed as never, true)).toBe('وفّر 90 ج.م');
  });
});

describe('the opt-in: Arabic-Indic only for Arabic readers of an opted-in store', () => {
  it('prices', () => {
    expect(formatPrice(45_000, { locale: 'ar', numerals: 'arab' })).toBe('٤٥٠ ج.م');
    expect(formatPrice(45_000, { locale: 'en', numerals: 'arab' })).toBe('EGP 450');
    const html = renderToStaticMarkup(<Price price={45_000} isRtl numerals="arab" />);
    expect(html).toContain('٤٥٠ ج.م');
    const en = renderToStaticMarkup(<Price price={45_000} numerals="arab" />);
    expect(en).not.toMatch(ARAB);
  });

  it('dates, counts, badges', () => {
    expect(formatDate(DATE, { language: 'ar', numerals: 'arab' })).toMatch(ARAB);
    expect(formatDate(DATE, { language: 'en', numerals: 'arab' })).not.toMatch(ARAB);
    expect(formatCount(1234, 'ar', 'arab')).toMatch(ARAB);
    expect(
      getDiscountBadgeText(
        { price: 45_000, compareAtPrice: 54_000 },
        true,
        undefined,
        undefined,
        'arab'
      )
    ).toBe('\u2066\u2212١٧%\u2069');
    expect(effectiveNumerals('en', 'arab')).toBe('latn');
    expect(localizeDigits('12', 'arab')).toBe('١٢');
    expect(localizeDigits('12')).toBe('12');
  });
});
