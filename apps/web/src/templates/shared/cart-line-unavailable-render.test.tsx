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
  useNumerals: () => ({ localize: (v: string | number) => String(v) }),
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
