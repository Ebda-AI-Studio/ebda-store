// @vitest-environment jsdom
/**
 * F1: the cart's phone sticky bar must quote the SAME figure, label and money format as the
 * cart summary. The bar repeats the summary's Total row: net of the promo discount, and never
 * already carrying a zone fee while shipping reads "calculated at checkout".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { formatMoney, localizeDigits } from '@ebda/shared';

let lang: 'en' | 'ar' = 'ar';
let numerals: 'latn' = 'latn';
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
const numeralsMock = vi.hoisted(() => () => ({
  useStoreNumerals: () => numerals,
  useNumerals: () => ({
    localize: (v: string | number) => localizeDigits(v, numerals),
    money: (m: number) => formatMoney(m, 'ar', { hideSymbol: true, numerals }),
    numerals,
  }),
}));
const storeMock = vi.hoisted(() => () => ({
  useStore: () => ({ store: { id: 's1', theme: {}, currency: 'EGP' } }),
}));
vi.mock('@/contexts/StoreContext', storeMock);
vi.mock('../../contexts/StoreContext', storeMock);
vi.mock('@/hooks/useNumerals', numeralsMock);
vi.mock('../../hooks/useNumerals', numeralsMock);

import { StickyCartTotal } from '../../components/commerce/StickyCartTotal';
import { formatPrice as formatPriceBase } from '@/lib/format';
import Minimal from '../../templates/minimal/OrderSummary';
import Modern from '../../templates/modern/OrderSummary';
import Classic from '../../templates/classic/OrderSummary';
import Elegant from '../../templates/elegant/OrderSummary';
import Bold from '../../templates/bold/OrderSummary';
import Dahab from '../../templates/dahab/OrderSummary';

afterEach(() => {
  cleanup();
  lang = 'ar';
  numerals = 'latn';
});

const SUBTOTAL = 298000;
const DISCOUNT = 30000;
const TOTAL = SUBTOTAL - DISCOUNT;

describe.each([
  ['minimal', Minimal],
  ['modern', Modern],
  ['classic', Classic],
  ['elegant', Elegant],
  ['bold', Bold],
  ['dahab', Dahab],
] as const)('%s cart: sticky bar value == summary total value (after discount)', (_n, Summary) => {
  for (const [l, n] of [
    ['ar', 'latn'],
    ['en', 'latn'],
  ] as const) {
    it(`${l}/${n}`, () => {
      lang = l;
      numerals = n;
      // the storefront's formatter joins number and currency with a no-break space (B2-25 (1)); the
      // sticky bar and the summary both read it, so the fixture builds the bar the same way
      const fp = (a: number) =>
        formatPriceBase(a, { locale: l, numerals: n }).replace(' ', '\u00A0');
      const { container } = render(
        <Summary
          subtotal={SUBTOTAL}
          discount={DISCOUNT}
          shipping={5000}
          shippingPending
          total={TOTAL}
          currency="EGP"
          isRtl={l === 'ar'}
        />
      );
      render(
        <StickyCartTotal
          totalLabel={l === 'ar' ? 'الإجمالي' : 'Total'}
          total={fp(TOTAL)}
          itemCount={2}
          itemCountLabel="2"
          href="/checkout"
          label="Checkout"
        />
      );
      const bar = screen.getByTestId('sticky-cart-total-value').textContent!;
      const fmt = fp;
      // The summary prints this exact string as its Total value.
      expect(container.textContent).toContain(bar);
      expect(bar).toBe(fmt(TOTAL));
      expect(container.textContent).toContain(l === 'ar' ? 'الإجمالي' : 'Total');
      // never the pre-discount subtotal, and never the total plus the pending 50 EGP fee
      expect(bar).not.toBe(fmt(SUBTOTAL));
      expect(container.textContent).not.toContain(fmt(TOTAL + 5000));
    });
  }
});

describe('CartClient wiring', () => {
  const src = readFileSync(join(__dirname, 'CartClient.tsx'), 'utf8');
  it('the cart total excludes the zone fee while shipping is calculated at checkout', () => {
    const call = src.slice(src.indexOf('computeOrderAmounts({'));
    expect(call).toMatch(
      /^computeOrderAmounts\(\{\s*subtotal,\s*discount,\s*shipping: CART_SHIPPING_PENDING,/
    );
    expect(src).toMatch(/const CART_SHIPPING_PENDING = 0;/);
  });
  it('the sticky bar repeats the summary Total row (after discounts) in the summary money format', () => {
    const bar = src.slice(src.indexOf('<StickyCartTotal'));
    expect(bar).toMatch(/totalLabel=\{t\('Total', 'الإجمالي'\)\}/);
    // every themed summary and the bar print the ONE storefront format (B1-28)
    expect(bar).toMatch(/total=\{formatPrice\(total\)\}/);
  });
});
