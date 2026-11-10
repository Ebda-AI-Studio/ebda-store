// @vitest-environment jsdom
/**
 * C-03 (Qamar taste audit 2026-10-15, quality-bar § 1): the cart's checkout
 * action is the heaviest element on the desktop summary and has ONE label.
 * The minimal summary (also Qamar's) drew it as an underlined text link with a
 * "←"/"→" glyph, and the desktop said "المتابعة للدفع" while the phone bar said
 * "إتمام الطلب". Every skin's summary now renders a full-width filled button,
 * 48px tall, with a mirrored arrow icon; the label comes from CART_CHECKOUT_CTA,
 * the same key the sticky bar reads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { code, nodesOf, parseText } from './helpers/ast-query';
import { render, cleanup } from '@testing-library/react';
import { formatMoney, localizeDigits } from '@ebda/shared';

let lang: 'en' | 'ar' = 'ar';
const langMock = vi.hoisted(() => () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
const numeralsMock = vi.hoisted(() => () => ({
  useStoreNumerals: () => 'latn',
  useNumerals: () => ({
    localize: (v: string | number) => localizeDigits(v, 'latn'),
    money: (m: number) => formatMoney(m, 'ar', { hideSymbol: true, numerals: 'latn' }),
    numerals: 'latn',
  }),
}));
const storeMock = vi.hoisted(() => () => ({
  useStore: () => ({ store: { id: 'demo', theme: {}, currency: 'EGP' } }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', langMock);
vi.mock('../../apps/web/src/contexts/StoreContext', storeMock);
vi.mock('../../apps/web/src/hooks/useNumerals', numeralsMock);
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { get: () => Promise.resolve({ success: false }) },
}));

import { CART_CHECKOUT_CTA } from '../../apps/web/src/lib/checkout-cta';
import Base from '../../apps/web/src/templates/base/OrderSummary';
import Dahab from '../../apps/web/src/templates/dahab/OrderSummary';

const SKINS = {
  base: Base,
  dahab: Dahab,
};

afterEach(() => {
  cleanup();
  lang = 'ar';
});

function cta(el: HTMLElement): HTMLElement {
  const c = el.querySelector<HTMLElement>('[data-cta]');
  if (!c) throw new Error('no CTA');
  return c;
}

describe.each(Object.entries(SKINS))('C-03: %s summary checkout CTA', (_name, Summary) => {
  const props = {
    subtotal: 10000,
    total: 10000,
    ctaLabel: CART_CHECKOUT_CTA.en,
    ctaLabelAr: CART_CHECKOUT_CTA.ar,
  };

  for (const l of ['ar', 'en'] as const)
    it(`is a full-width filled 48px button with a mirrored icon (${l})`, () => {
      lang = l;
      const { container } = render(<Summary {...props} isRtl={l === 'ar'} ctaHref="/checkout" />);
      const a = cta(container);
      expect(a.tagName).toBe('A');
      expect(a.getAttribute('data-cta')).toBe('button');
      const cls = a.className;
      expect(cls).toMatch(/(?:^|\s)w-full(?:\s|$)/);
      expect(cls).toMatch(/(?:^|\s)(?:h-12|min-h-\[48px\])(?:\s|$)/);
      expect(cls).toMatch(/(?:^|\s)bg-(?:primary|foreground)(?:\s|$)/);
      expect(cls).not.toMatch(/border-b(?:\s|$)/);
      expect(a.textContent).toBe(l === 'ar' ? 'إتمام الطلب' : 'Checkout');
      const svg = a.querySelector('svg')!;
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('style') ?? '').toBe(l === 'ar' ? 'transform: rotate(180deg);' : '');
    });

  it('the button form (no href) is the same filled button', () => {
    const { container } = render(<Summary {...props} isRtl onCtaClick={() => {}} />);
    const b = cta(container);
    expect(b.tagName).toBe('BUTTON');
    expect(b.className).toMatch(/(?:^|\s)w-full(?:\s|$)/);
    expect(b.textContent).toBe('إتمام الطلب');
  });
});

describe('C-03: one label on the desktop summary and the phone sticky bar', () => {
  const src = readFileSync(join(__dirname, '../../apps/web/src/app/cart/CartClient.tsx'), 'utf8');
  it('the themed summary, the fallback summary and the sticky bar read CART_CHECKOUT_CTA', () => {
    expect(src).toMatch(/ctaLabel=\{CART_CHECKOUT_CTA\.en\}/);
    expect(src).toMatch(/ctaLabelAr=\{CART_CHECKOUT_CTA\.ar\}/);
    expect(src.match(/t\(CART_CHECKOUT_CTA\.en, CART_CHECKOUT_CTA\.ar\)/g)?.length).toBe(3);
    // AST: the `label` attribute of the <StickyCartTotal> element itself (not whatever text follows it in the file).
    const sticky = nodesOf(parseText(src, 'CartClient.tsx')).filter(
      (n): n is ts.JsxSelfClosingElement | ts.JsxOpeningElement =>
        (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
        code(n.tagName) === 'StickyCartTotal'
    );
    expect(sticky).toHaveLength(1);
    const label = sticky[0].attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && code(p.name) === 'label'
    );
    expect(label && code(label.initializer!)).toBe(
      '{t(CART_CHECKOUT_CTA.en, CART_CHECKOUT_CTA.ar)}'
    );
  });
  it('no other checkout label is left on the cart', () => {
    expect(src).not.toMatch(
      /Proceed to Checkout|المتابعة للدفع|\\u0627\\u0644\\u0645\\u062a\\u0627\\u0628\\u0639\\u0629 \\u0644\\u0644\\u062f\\u0641\\u0639/
    );
  });
});
