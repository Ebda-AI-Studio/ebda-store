/**
 * #1766 — a cart line whose product was deleted is marked on /cart in EVERY
 * theme's CartTable (platform-level rule: all five render paths), with the
 * quantity steppers disabled and remove still available. Rendered, not
 * source-grepped, because the defect was precisely that the line LOOKED
 * normal.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CartTableItem, CartTableProps } from '../types';

const { lang } = vi.hoisted(() => ({ lang: { current: 'en' as 'en' | 'ar' } }));

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang.current,
    isRtl: lang.current === 'ar',
    t: (en: string, ar: string) => (lang.current === 'ar' ? ar : en),
  }),
}));
vi.mock('../../hooks/useNumerals', () => ({
  useNumerals: () => ({
    localize: (v: string | number) => String(v),
    money: (minor: number) => String(minor / 100),
    numerals: 'latn',
  }),
  useStoreNumerals: () => 'latn',
}));

const themes = {
  modern: (await import('../modern/CartTable')).default,
  classic: (await import('../classic/CartTable')).default,
  elegant: (await import('../elegant/CartTable')).default,
  minimal: (await import('../minimal/CartTable')).default,
  bold: (await import('../bold/CartTable')).default,
};

const line = (extra: Partial<CartTableItem> = {}): CartTableItem => ({
  id: 'line-1',
  productId: 'p-1',
  name: 'Oud Oil',
  nameAr: 'دهن عود',
  slug: 'oud-oil',
  price: 12000,
  quantity: 2,
  ...extra,
});

function render(Table: React.ComponentType<CartTableProps>, items: CartTableItem[]) {
  return renderToStaticMarkup(
    React.createElement(Table, { items, onRemove: () => {}, onUpdateQuantity: () => {} })
  );
}

/** Buttons whose aria-label says remove/إزالة. */
const removeButtons = (html: string) =>
  (html.match(/<button[^>]*>/g) ?? []).filter(b => /aria-label="(Remove|إزالة)/.test(b));
/** Quantity stepper buttons (everything that is not remove). */
const stepperButtons = (html: string) =>
  (html.match(/<button[^>]*>/g) ?? []).filter(b => !/aria-label="(Remove|إزالة)/.test(b));

describe.each(Object.entries(themes))('%s CartTable — #1766 unavailable line', (_name, Table) => {
  it('marks the line, disables both steppers, and keeps remove enabled', () => {
    lang.current = 'en';
    const html = render(Table, [line({ unavailable: true })]);
    expect(html).toContain('data-cart-line-unavailable');
    expect(html).toContain('No longer available');
    const steppers = stepperButtons(html);
    expect(steppers.length).toBeGreaterThanOrEqual(2);
    for (const b of steppers) expect(b).toMatch(/\sdisabled=""/);
    const removes = removeButtons(html);
    expect(removes.length).toBeGreaterThanOrEqual(1);
    for (const b of removes) expect(b).not.toMatch(/\sdisabled=""/);
  });

  it('shows the Arabic notice on the Arabic storefront', () => {
    lang.current = 'ar';
    const html = render(Table, [line({ unavailable: true })]);
    expect(html).toContain('لم يعد متوفراً');
    lang.current = 'en';
  });

  it('a live line is unchanged — no notice, increase stepper enabled', () => {
    lang.current = 'en';
    const html = render(Table, [line()]);
    expect(html).not.toContain('data-cart-line-unavailable');
    const increase = stepperButtons(html).filter(b => /Increase|زيادة/.test(b));
    expect(increase.length).toBe(1);
    expect(increase[0]).not.toMatch(/\sdisabled=""/);
  });
});

// Taste re-audit P2-2 (Y-05, one fact in one place): at quantity 1 the unit price under the
// name repeated the line total beside it. The unit price shows only when quantity > 1.
describe.each(Object.entries({ ...themes, dahab: (await import('../dahab/CartTable')).default }))(
  '%s CartTable — unit price only when it differs from the line total',
  (_name, Table) => {
    it('quantity 1: the price appears once; quantity 3: unit and total both appear', () => {
      lang.current = 'en';
      const one = render(Table, [line({ quantity: 1, price: 14900 })]);
      expect(one.split('149').length - 1).toBe(1);
      const three = render(Table, [line({ quantity: 3, price: 14900 })]);
      expect(three).toContain('149');
      expect(three).toContain('447');
    });
  }
);

describe('the default cart (no theme table) follows the same rule (P2-2)', () => {
  it('its "each" unit price is gated on quantity > 1', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../app/cart/CartClient.tsx'), 'utf8');
    expect(src).toMatch(/item\.quantity > 1 && \(\s*<p[\s\S]{0,400}?t\('each'/);
  });
});

// a11y re-audit P1-N2 / P2-N4 class (rule (d)): the cart line's remove button measured 20x44 and
// its product-name link 49x21 in the browser; the W4 class gate never rendered a cart table.
describe.each(Object.entries({ ...themes, dahab: (await import('../dahab/CartTable')).default }))(
  '%s CartTable — every control is a 44px target',
  (_name, Table) => {
    it('remove, steppers and the name link', async () => {
      // @ts-expect-error jsdom ships no types in this workspace
      const { JSDOM } = (await import('jsdom')) as {
        JSDOM: new (html: string) => { window: { document: Document } };
      };
      const { smallTargets } = await import('../../../../../tests/helpers/target-size');
      lang.current = 'ar';
      const html = render(Table, [line({ quantity: 2 })]);
      const doc = new JSDOM(`<body>${html}</body>`).window.document;
      // A photo link is sized by its image, which a class read cannot see; the browser probe
      // (scripts/taste/purchase-path-probe.mjs) measures it. Everything else is checked here.
      for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a')))
        if (a.querySelector('img') || /\baspect-/.test(a.className)) a.remove();
      expect(smallTargets(doc.body, 44, { requireWidth: true })).toEqual([]);
    });
  }
);
