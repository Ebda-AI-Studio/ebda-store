// @vitest-environment jsdom
/**
 * Owner report 2026-09-30 (pecannbee): a product with exactly ONE variant
 * ("Size: 380 Gram") made the shopper tap the only option before Add to Cart
 * worked. The picker now starts with that option picked — and nothing else
 * about it changes (owner: no visual changes): same pills, same labels, the
 * only difference is the pill's selected state and the value echoed next to
 * the axis label, exactly what a tap produces.
 *
 * Both locales; the Arabic run renders inside dir="rtl" like the storefront.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

let lang: 'en' | 'ar' = 'en';
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { VariantSelector } from './VariantSelector';
import type { Product, ProductVariant } from '@/lib/api';

type Opt = NonNullable<Product['options']>[number];

const sizeOption = (values: string[]): Opt =>
  ({
    id: 'opt-size',
    name: 'Size',
    values: values.map(value => ({ value })),
  }) as unknown as Opt;

const variant = (id: string, value: string, inventory: number | undefined): ProductVariant =>
  ({ id, price: 4000, inventory, options: { Size: value } }) as ProductVariant;

function renderSelector(variants: ProductVariant[], options: Opt[], onVariantSelect = vi.fn()) {
  const utils = render(
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <VariantSelector variants={variants} options={options} onVariantSelect={onVariantSelect} />
    </div>
  );
  const pills = Array.from(utils.container.querySelectorAll('button'));
  return { ...utils, pills, onVariantSelect };
}

afterEach(() => {
  cleanup();
  lang = 'en';
});

describe.each(['en', 'ar'] as const)('VariantSelector — single variant (%s)', locale => {
  const axis = locale === 'ar' ? 'الحجم:' : 'Size:';
  const shown = locale === 'ar' ? '380 جرام' : '380 Gram';

  it('starts with the only option selected and reports it to the page', () => {
    lang = locale;
    const only = variant('v1', '380 Gram', 7);
    const { container, pills, onVariantSelect } = renderSelector(
      [only],
      [sizeOption(['380 Gram'])]
    );

    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute('aria-pressed')).toBe('true');
    expect(pills[0].disabled).toBe(false);
    expect(pills[0].textContent).toBe(shown);
    // The selected value is echoed beside the axis label — the same thing a tap shows.
    expect(container.textContent).toContain(`${axis}${shown}`);
    expect(onVariantSelect).toHaveBeenLastCalledWith(only);
    if (locale === 'ar') expect(container.firstElementChild?.getAttribute('dir')).toBe('rtl');
  });

  it('keeps the markup a tap would produce: tapping again still deselects', () => {
    lang = locale;
    const only = variant('v1', '380 Gram', 7);
    const { pills, onVariantSelect } = renderSelector([only], [sizeOption(['380 Gram'])]);
    fireEvent.click(pills[0]);
    expect(pills[0].getAttribute('aria-pressed')).toBe('false');
    expect(onVariantSelect).toHaveBeenLastCalledWith(null);
  });

  it('the pre-selection is not a shopper pick (the gallery does not swap); a tap is', () => {
    lang = locale;
    const onShopperSelect = vi.fn();
    const only = variant('v1', '380 Gram', 7);
    const { container } = render(
      <VariantSelector
        variants={[only]}
        options={[sizeOption(['380 Gram'])]}
        onVariantSelect={vi.fn()}
        onShopperSelect={onShopperSelect}
      />
    );
    expect(onShopperSelect).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('button')!);
    expect(onShopperSelect).toHaveBeenCalledTimes(1);
  });

  it('untracked stock (inventory undefined) is tappable, so it is pre-selected too', () => {
    lang = locale;
    const { pills } = renderSelector(
      [variant('v1', '380 Gram', undefined)],
      [sizeOption(['380 Gram'])]
    );
    expect(pills[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('a sold-out single variant is NOT pre-selected (its pill cannot be tapped today)', () => {
    lang = locale;
    const { pills, onVariantSelect } = renderSelector(
      [variant('v1', '380 Gram', 0)],
      [sizeOption(['380 Gram'])]
    );
    expect(pills[0].getAttribute('aria-pressed')).toBe('false');
    expect(pills[0].disabled).toBe(true);
    expect(onVariantSelect).toHaveBeenLastCalledWith(null);
  });

  it('two variants: nothing is pre-selected — the shopper has a real choice', () => {
    lang = locale;
    const { pills, onVariantSelect } = renderSelector(
      [variant('v1', '380 Gram', 7), variant('v2', '1 Kg', 7)],
      [sizeOption(['380 Gram', '1 Kg'])]
    );
    expect(pills.map(p => p.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(onVariantSelect).toHaveBeenLastCalledWith(null);
  });
});
