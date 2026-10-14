// @vitest-environment jsdom
/**
 * Phase B0 Task 2: colour swatches + Size x Length chips. Existing chips are
 * role=button + aria-pressed (not radio), so queries use `button`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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

afterEach(() => {
  cleanup();
  lang = 'en';
});

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

  it('an unselected colour circle keeps a 35% foreground ring on dark skins (F7)', () => {
    render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
    const teal = screen.getByRole('button', { name: /Teal/ });
    expect(teal.className).toContain('ring-foreground/35');
    expect(teal.className).not.toContain('ring-foreground/15');
  });

  it('strikes the out-of-stock combo once the other axes are picked', () => {
    render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Teal/ }));
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    const l56 = screen.getByRole('button', { name: '56' }) as HTMLButtonElement;
    expect(l56.disabled).toBe(true);
    // Text chip keeps the visible strike.
    expect(l56.className).toMatch(/line-through/);
    expect((screen.getByRole('button', { name: '52' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the picked swatch name beside the axis label', () => {
    render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Teal/ }));
    expect(screen.getByText('Color:').parentElement?.textContent).toContain('Teal');
  });

  it('sold-out swatch announces itself and carries no dead line-through', () => {
    // Teal is out of stock for every Length once Size M + Length 56 are picked.
    const soldOut = variants.map(v => ({ ...v, inventory: v.options.Color === 'Rose' ? 0 : 5 }));
    render(<VariantSelector variants={soldOut} options={options} onVariantSelect={() => {}} />);
    const rose = screen.getByRole('button', { name: /Rose, Sold out/ }) as HTMLButtonElement;
    expect(rose.disabled).toBe(true);
    expect(rose.className).not.toMatch(/line-through/);
    expect(rose.className).toMatch(/before:-inset-1\.5/); // 32px + 2x6px = 44px hit area
  });

  it('arabic: axis label, picked name and sold-out suffix', () => {
    lang = 'ar';
    const soldOut = variants.map(v => ({ ...v, inventory: v.options.Color === 'Rose' ? 0 : 5 }));
    render(
      <div dir="rtl">
        <VariantSelector variants={soldOut} options={options} onVariantSelect={() => {}} />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'تيل' }));
    expect(screen.getByText('اللون:').parentElement?.textContent).toContain('تيل');
    expect(screen.getByRole('button', { name: /روز, نفدت الكمية/ })).toBeTruthy();
  });
});

describe('VariantSelector value thumbnails', () => {
  const thumbOptions = (names: string[]) =>
    names.map(n => ({
      id: n,
      name: n,
      values:
        n === 'Size'
          ? [{ value: 'S' }, { value: 'M' }]
          : n === 'Length'
            ? [{ value: '52' }, { value: '56' }]
            : [{ value: 'Rose' }, { value: 'Teal' }],
    })) as unknown as Opt[];

  it('multi-axis: one variant image does not put a thumbnail on Size or Length chips', () => {
    const opts = thumbOptions(['Color', 'Size', 'Length']);
    const vs = variants
      .filter(v => v.options.Color !== 'Plain')
      .map(v => ({
        ...v,
        imageUrl: v.id === 'Rose-S-52' ? 'https://x.r2.dev/rose-s-52.webp' : undefined,
      }));
    render(<VariantSelector variants={vs} options={opts} onVariantSelect={() => {}} />);
    for (const name of ['S', 'M', '52', '56', 'Teal', 'Rose']) {
      expect(screen.getByRole('button', { name }).querySelector('img')).toBeNull();
    }
  });

  it('every Rose variant sharing one image gives the Rose chip that thumbnail', () => {
    const opts = thumbOptions(['Color']);
    const vs = [
      {
        id: 'r1',
        price: 1,
        inventory: 5,
        options: { Color: 'Rose' },
        imageUrl: 'https://x.r2.dev/rose.webp',
      },
      {
        id: 'r2',
        price: 1,
        inventory: 5,
        options: { Color: 'Rose' },
        imageUrl: 'https://x.r2.dev/rose.webp',
      },
      { id: 't1', price: 1, inventory: 5, options: { Color: 'Teal' } },
    ] as ProductVariant[];
    render(<VariantSelector variants={vs} options={opts} onVariantSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Rose' }).querySelector('img')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Teal' }).querySelector('img')).toBeNull();
  });

  it('swatch rendering wins over a shared thumbnail', () => {
    const vs = variants.map(v => ({
      ...v,
      imageUrl: v.options.Color === 'Teal' ? 'https://x.r2.dev/t.webp' : undefined,
    }));
    render(<VariantSelector variants={vs} options={options} onVariantSelect={() => {}} />);
    const teal = screen.getByRole('button', { name: /Teal/ });
    expect(teal.querySelectorAll('img')).toHaveLength(0);
    expect(teal.querySelector('[data-swatch-hex="#1F4E54"]')).not.toBeNull();
  });

  it('single axis: each value with its own image keeps its thumbnail', () => {
    const opts = [
      { id: 'w', name: 'Weight', values: [{ value: '200g' }, { value: '50g' }] },
    ] as unknown as Opt[];
    const vs = [
      {
        id: 'a',
        price: 1,
        inventory: 5,
        options: { Weight: '200g' },
        imageUrl: 'https://x.r2.dev/200.webp',
      },
      { id: 'b', price: 1, inventory: 5, options: { Weight: '50g' } },
    ] as ProductVariant[];
    render(<VariantSelector variants={vs} options={opts} onVariantSelect={() => {}} />);
    expect(screen.getByRole('button', { name: '200g' }).querySelector('img')).not.toBeNull();
    expect(screen.getByRole('button', { name: '50g' }).querySelector('img')).toBeNull();
  });
});
