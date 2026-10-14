// @vitest-environment jsdom
/**
 * F1: the cart's phone sticky bar must quote the SAME figure, label and money format as the
 * cart summary. While shipping reads "calculated at checkout", the bar repeats the summary's
 * Subtotal row, and the cart's total never already carries a zone fee.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { formatMoney, localizeDigits } from '@ebda/shared';

let lang: 'en' | 'ar' = 'ar';
let numerals: 'latn' | 'arab' = 'latn';
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
import { summaryMoneyFormatter } from '../../templates/shared/useOrderSummaryBase';
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
const money = (m: number) => formatMoney(m, 'ar', { hideSymbol: true, numerals });

describe.each([
  ['minimal', Minimal],
  ['modern', Modern],
  ['classic', Classic],
  ['elegant', Elegant],
  ['bold', Bold],
  ['dahab', Dahab],
] as const)('%s cart: sticky bar value == summary subtotal value', (_n, Summary) => {
  for (const [l, n] of [
    ['ar', 'latn'],
    ['ar', 'arab'],
    ['en', 'latn'],
  ] as const) {
    it(`${l}/${n}`, () => {
      lang = l;
      numerals = n;
      const fp = (a: number) => formatPriceBase(a, { locale: l, numerals: n });
      const { container } = render(
        <Summary
          subtotal={SUBTOTAL}
          shipping={5000}
          shippingPending
          total={SUBTOTAL}
          currency="EGP"
          isRtl={l === 'ar'}
        />
      );
      render(
        <StickyCartTotal
          totalLabel={l === 'ar' ? 'المجموع الفرعي' : 'Subtotal'}
          total={summaryMoneyFormatter(Summary, money, 'EGP', fp)(SUBTOTAL)}
          itemCount={2}
          itemCountLabel="2"
          href="/checkout"
          label="Checkout"
        />
      );
      const bar = screen.getByTestId('sticky-cart-total-value').textContent!;
      // The summary prints this exact string as its Subtotal value.
      expect(container.textContent).toContain(bar);
      expect(container.textContent).toContain(l === 'ar' ? 'المجموع الفرعي' : 'Subtotal');
      // and never the subtotal plus the pending 50 EGP fee
      expect(container.textContent).not.toContain(
        summaryMoneyFormatter(Summary, money, 'EGP', fp)(SUBTOTAL + 5000)
      );
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
  it('the sticky bar repeats the summary Subtotal row in the summary money format', () => {
    const bar = src.slice(src.indexOf('<StickyCartTotal'));
    expect(bar).toMatch(/totalLabel=\{t\('Subtotal', 'المجموع الفرعي'\)\}/);
    expect(bar).toMatch(
      /summaryMoneyFormatter\(\s*T\?\.OrderSummary,\s*money,\s*store\.currency \?\? REGION\.currency,\s*formatPrice\s*\)\(subtotal\)/
    );
  });
});
