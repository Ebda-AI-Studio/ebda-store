// @vitest-environment jsdom
/**
 * C-02: a blocked add-to-cart nudges the FIRST unset option group (focus, ring,
 * live text) — in Arabic, with the merchant's Arabic axis name.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';

vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: true, t: (_en: string, ar?: string) => ar ?? _en }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { VariantSelector } from './VariantSelector';
import type { Product, ProductVariant } from '@/lib/api';

type Opt = NonNullable<Product['options']>[number];
const opt = (name: string, nameAr: string, values: string[]) =>
  ({ id: name, name, nameAr, values: values.map(value => ({ value })) }) as unknown as Opt;
const variant = (options: Record<string, string>) =>
  ({ id: JSON.stringify(options), price: 1, inventory: 1, options }) as ProductVariant;

const options = [opt('Color', 'اللون', ['Teal', 'Sand']), opt('Size', 'المقاس', ['S', 'M'])];
const variants = [
  variant({ Color: 'Teal', Size: 'S' }),
  variant({ Color: 'Sand', Size: 'M' }),
  variant({ Color: 'Teal', Size: 'M' }),
];

afterEach(cleanup);

function Harness({ nudge }: { nudge: number }) {
  return (
    <VariantSelector
      variants={variants}
      options={options}
      onVariantSelect={() => {}}
      nudge={nudge}
    />
  );
}

describe('VariantSelector nudge (C-02)', () => {
  it('no nudge: no ring, an empty live region per group', () => {
    const { container } = render(<Harness nudge={0} />);
    const hints = container.querySelectorAll('[data-testid="variant-nudge"]');
    expect(hints).toHaveLength(2);
    hints.forEach(h => {
      expect(h.getAttribute('aria-live')).toBe('polite');
      expect(h.textContent).toBe('');
    });
    expect(container.querySelector('[data-nudged]')).toBeNull();
  });

  it('a nudge focuses the first unset group and announces it in Arabic', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { container, rerender } = render(<Harness nudge={0} />);
    rerender(<Harness nudge={1} />);
    const color = container.querySelector('[data-option-group="Color"]') as HTMLElement;
    expect(document.activeElement).toBe(color);
    expect(color.getAttribute('role')).toBe('group');
    expect(color.querySelector('[data-testid="variant-nudge"]')?.textContent).toBe('اختر اللون');

    // Colour picked: the next nudge moves on to the size.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    });
    expect(color.querySelector('[data-testid="variant-nudge"]')?.textContent).toBe('');
    rerender(<Harness nudge={2} />);
    const size = container.querySelector('[data-option-group="Size"]') as HTMLElement;
    expect(document.activeElement).toBe(size);
    expect(size.querySelector('[data-testid="variant-nudge"]')?.textContent).toBe('اختر المقاس');
  });
});
