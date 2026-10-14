// @vitest-environment jsdom
/** B0 Task 9: where the size-guide trigger sits in the selector. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: false, t: (en: string) => en }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { VariantSelector, isSizeOption } from './VariantSelector';
import type { Product, ProductVariant } from '@/lib/api';

type Opt = NonNullable<Product['options']>[number];
const opt = (name: string, nameAr: string, values: string[]) =>
  ({ id: name, name, nameAr, values: values.map(value => ({ value })) }) as unknown as Opt;
const variant = (options: Record<string, string>) =>
  ({ id: JSON.stringify(options), price: 1, inventory: 1, options }) as ProductVariant;

afterEach(cleanup);

const guide = <button type="button">Size guide</button>;

describe('VariantSelector size guide', () => {
  it('matches size-like options in either language', () => {
    expect(isSizeOption({ name: 'Size', nameAr: null })).toBe(true);
    expect(isSizeOption({ name: 'Ring size' })).toBe(true);
    expect(isSizeOption({ name: 'Option', nameAr: 'المقاس' })).toBe(true);
    expect(isSizeOption({ name: 'Color', nameAr: 'اللون' })).toBe(false);
  });

  it('sits beside the size option label', () => {
    const options = [opt('Color', 'اللون', ['Teal']), opt('Size', 'المقاس', ['S', 'M'])];
    render(
      <VariantSelector
        variants={[variant({ Color: 'Teal', Size: 'S' }), variant({ Color: 'Teal', Size: 'M' })]}
        options={options}
        onVariantSelect={() => {}}
        sizeGuide={guide}
      />
    );
    const buttons = screen.getAllByRole('button', { name: 'Size guide' });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText('Size:').parentElement?.contains(buttons[0])).toBe(true);
  });

  it('goes under the selector when no option is a size', () => {
    const options = [opt('Color', 'اللون', ['Teal', 'Rose'])];
    const { container } = render(
      <VariantSelector
        variants={[variant({ Color: 'Teal' }), variant({ Color: 'Rose' })]}
        options={options}
        onVariantSelect={() => {}}
        sizeGuide={guide}
      />
    );
    const btn = screen.getByRole('button', { name: 'Size guide' });
    expect(screen.getByText('Color:').parentElement?.contains(btn)).toBe(false);
    expect(container.firstElementChild?.contains(btn)).toBe(true);
  });

  it('renders no guide when none is passed', () => {
    render(
      <VariantSelector
        variants={[variant({ Size: 'S' })]}
        options={[opt('Size', 'المقاس', ['S'])]}
        onVariantSelect={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Size guide' })).toBeNull();
  });
});
