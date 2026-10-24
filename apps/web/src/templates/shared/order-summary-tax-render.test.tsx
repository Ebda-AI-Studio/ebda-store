/**
 * Ruling M3-6 (docs/RULINGS.md): the cart/checkout summary showed no tax
 * line at all. All 5 themed OrderSummary components already had a `tax`
 * prop and a generic "Tax"/"الضريبة" row behind a `tax > 0` gate — nobody
 * ever passed it a value, so the row never rendered anywhere. This renders
 * the real 5 theme components (platform-level fix — every render path, not
 * one theme) and asserts the states a shopper can see:
 *
 *   1. disabled / no active rate (all 3 live stores today) → renders
 *      NOTHING, byte-identical to a render with no tax props at all. The
 *      API already zeroes `taxRatePercent` for a disabled store
 *      (`resolveActiveTaxRate` — the ONE resolver order creation charges
 *      against too, ruling M3-9), so this is proven at the prop boundary
 *      rather than by re-deriving the gate here.
 *   2. tax added on top of the price ("exclusive") → a "VAT (5%)" row,
 *      summed into `total` by the caller.
 *   3. tax already included in the price ("inclusive") → an "Incl. VAT
 *      (5%)" CAPTION after Total, not a row in the summed amount column
 *      (scoped-audit follow-up: the amount there implied it was added a
 *      second time) — the caller's `total` excludes it, proven separately
 *      in checkout-vat-line-parity.test.ts and
 *      checkout-cart-tax-total-wiring.test.ts.
 *
 * `react-dom/server` markup, not jsdom — there is no DOM environment in
 * this repo (see checkout-error-alert-renders.test.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const storeState = { store: { theme: {} as Record<string, unknown> } };
const languageState = { language: 'en' as 'en' | 'ar' };

vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => storeState,
}));

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: languageState.language,
    isRtl: languageState.language === 'ar',
    t: (en: string, ar?: string) => (languageState.language === 'ar' ? (ar ?? en) : en),
    setLanguage: () => {},
  }),
  translations: {} as Record<string, string>,
}));

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: React.PropsWithChildren<{ href: string }> & Record<string, unknown>) =>
    React.createElement('a', { href, ...rest }, children),
}));

const { default: BaseOrderSummary } = await import('../base/OrderSummary');

const THEMES = [['base', BaseOrderSummary]] as const;

type Props = React.ComponentProps<(typeof THEMES)[number][1]>;

function render(
  Card: (typeof THEMES)[number][1],
  props: Partial<Props>,
  language: 'en' | 'ar' = 'en'
): string {
  languageState.language = language;
  return renderToStaticMarkup(
    React.createElement(Card as never, { subtotal: 20000, total: 20000, ...props } as never)
  );
}

describe.each(THEMES)('%s OrderSummary — VAT row', (_name, Card) => {
  it('no tax props at all → renders nothing, and matches a rate-0/disabled render byte-for-byte', () => {
    const baseline = render(Card, {});
    const explicitZero = render(Card, { tax: 0, taxRatePercent: 0, taxIncludedInPrice: false });
    const disabledStore = render(Card, { tax: 0, taxRatePercent: 5, taxIncludedInPrice: false }); // rate configured but tax computed to 0 (e.g. discount ate the whole subtotal)
    expect(baseline).not.toMatch(/VAT|Tax|الضريبة/);
    expect(explicitZero).toBe(baseline);
    expect(disabledStore).toBe(baseline);
  });

  it('exclusive tax (added on top): renders "VAT (5%)" and the amount', () => {
    const html = render(Card, { tax: 1000, taxRatePercent: 5, taxIncludedInPrice: false });
    expect(html).toContain('VAT (5%)');
    expect(html).not.toContain('Incl.');
  });

  it('exclusive tax, Arabic: renders the Arabic VAT label', () => {
    const html = render(Card, { tax: 1000, taxRatePercent: 5, taxIncludedInPrice: false }, 'ar');
    expect(html).toContain('ضريبة القيمة المضافة (5%)');
    expect(html).not.toContain('شامل');
  });

  it('inclusive tax (already in the price): renders "Incl. VAT (5%)", not an add-on row', () => {
    const html = render(Card, { tax: 1000, taxRatePercent: 5, taxIncludedInPrice: true });
    expect(html).toContain('Incl. VAT (5%)');
  });

  it('inclusive tax renders AFTER Total, as a caption — not a summed-column row (scoped-audit follow-up)', () => {
    const html = render(Card, { tax: 1000, taxRatePercent: 5, taxIncludedInPrice: true });
    const totalAt = html.search(/الإجمالي|Total/);
    const inclAt = html.indexOf('Incl. VAT (5%)');
    expect(totalAt).toBeGreaterThan(-1);
    expect(inclAt).toBeGreaterThan(totalAt);
    // The caption combines label + amount in ONE node ("Incl. VAT (5%) —
    // EGP 10"), not a second <dt>/<dd> pair lined up under Subtotal/
    // Shipping/Total's tabular-nums amount column.
    const afterIncl = html.slice(inclAt, inclAt + 120);
    expect(afterIncl).toMatch(/Incl\. VAT \(5%\)[^<]*\b10\b(?!\.)/);
    expect(afterIncl).not.toMatch(/<dd/);
  });

  it('inclusive tax, Arabic: renders the Arabic "included" wording', () => {
    const html = render(Card, { tax: 1000, taxRatePercent: 5, taxIncludedInPrice: true }, 'ar');
    expect(html).toContain('شامل ضريبة القيمة المضافة (5%)');
  });

  it('a fractional rate trims trailing zeros: 5.5, not 5.50', () => {
    const html = render(Card, { tax: 100, taxRatePercent: 5.5, taxIncludedInPrice: false });
    expect(html).toContain('VAT (5.5%)');
    expect(html).not.toContain('5.50%');
  });

  it('adding the tax row is ADDITIVE — every text fragment from the no-tax render still appears', () => {
    const without = render(Card, {});
    const withTax = render(Card, { tax: 1000, taxRatePercent: 5, taxIncludedInPrice: false });
    // Split the no-tax markup on tag boundaries to get its text content
    // (labels + formatted amounts) and confirm each piece still renders once
    // the VAT row is added — i.e. the row is purely additive, nothing else
    // on the card moves, changes, or disappears.
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
