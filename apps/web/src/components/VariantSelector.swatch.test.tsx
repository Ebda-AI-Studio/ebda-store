// @vitest-environment jsdom
/**
 * Phase B0 Task 2: colour swatches + Size x Length chips. Existing chips are
 * role=button + aria-pressed (not radio), so queries use `button`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: false, t: (en: string) => en }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { VariantSelector } from './VariantSelector';
import type { Product, ProductVariant } from '@/lib/api';

type Opt = NonNullable<Product['options']>[number];

const options = [
  {
    id: 'o1',
    name: 'Color',
    nameAr: 'اللون',
    values: [
      { id: 'a', value: 'Teal', valueAr: 'تيل', swatchHex: '#1F4E54', swatchImageUrl: null },
      {
        id: 'b',
        value: 'Rose',
        valueAr: 'روز',
        swatchHex: '#C98B8B',
        swatchImageUrl: 'https://x.r2.dev/rose.webp',
      },
      { id: 'c', value: 'Plain', valueAr: 'سادة', swatchHex: null, swatchImageUrl: null },
    ],
  },
  { id: 'o2', name: 'Size', nameAr: 'المقاس', values: [{ value: 'S' }, { value: 'M' }] },
  { id: 'o3', name: 'Length', nameAr: 'الطول', values: [{ value: '52' }, { value: '56' }] },
] as unknown as Opt[];

const variants: ProductVariant[] = [];
for (const c of ['Teal', 'Rose', 'Plain'])
  for (const s of ['S', 'M'])
    for (const l of ['52', '56'])
      variants.push({
        id: `${c}-${s}-${l}`,
        price: 1000,
        inventory: c === 'Teal' && s === 'M' && l === '56' ? 0 : 5,
        options: { Color: c, Size: s, Length: l },
      } as ProductVariant);

afterEach(cleanup);

describe('VariantSelector swatches', () => {
  it('mixed swatch values', () => {
    render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
    const teal = screen.getByRole('button', { name: /Teal/ });
    expect(teal.querySelector('[data-swatch-hex="#1F4E54"]')).not.toBeNull();
    const rose = screen.getByRole('button', { name: /Rose/ });
    expect(rose.querySelector('img')).not.toBeNull(); // image wins over hex
    const plain = screen.getByRole('button', { name: /Plain/ });
    expect(plain.querySelector('[data-swatch-hex]')).toBeNull(); // text chip, no empty circle
    expect(plain.textContent).toMatch(/Plain/);
  });

  it('strikes the out-of-stock combo once the other axes are picked', () => {
    render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Teal/ }));
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    const l56 = screen.getByRole('button', { name: '56' }) as HTMLButtonElement;
    expect(l56.disabled).toBe(true);
    expect(l56.className).toMatch(/line-through/);
    expect((screen.getByRole('button', { name: '52' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the picked swatch name beside the axis label', () => {
    render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Teal/ }));
    expect(screen.getByText('Color:').parentElement?.textContent).toContain('Teal');
  });
});
