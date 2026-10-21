// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { vi } from 'vitest';
const lang = { value: 'en' as 'en' | 'ar' };
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: lang.value }),
}));
const { SwatchDots } = await import('./SwatchDots');

afterEach(() => {
  cleanup();
  lang.value = 'en';
});

describe('SwatchDots', () => {
  it('renders up to max dots then +N', () => {
    const p = {
      options: [
        {
          name: 'Color',
          values: Array.from({ length: 7 }, (_, i) => ({
            id: `${i}`,
            value: `c${i}`,
            swatchHex: '#000000',
            swatchImageUrl: null,
          })),
        },
      ],
    };
    render(<SwatchDots product={p} max={5} />);
    expect(screen.getAllByTestId('swatch-dot')).toHaveLength(5);
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('renders nothing without swatches', () => {
    const { container } = render(
      <SwatchDots
        product={{ options: [{ name: 'Size', values: [{ id: '1', value: 'S' }] }] }}
        max={5}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('image wins over hex and skips swatch-less values', () => {
    const { container } = render(
      <SwatchDots
        product={{
          options: [
            {
              name: 'Color',
              values: [
                {
                  id: 'a',
                  value: 'A',
                  swatchHex: '#111111',
                  swatchImageUrl: 'https://x.dev/a.webp',
                },
                { id: 'b', value: 'B' },
              ],
            },
          ],
        }}
      />
    );
    expect(screen.getAllByTestId('swatch-dot')).toHaveLength(1);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('+N counts the real total, not just the shipped rows', () => {
    const p = {
      options: [
        {
          name: 'Color',
          _count: { values: 12 },
          values: Array.from({ length: 8 }, (_, i) => ({
            id: `${i}`,
            value: `c${i}`,
            swatchHex: '#000000',
          })),
        },
      ],
    };
    render(<SwatchDots product={p} max={5} />);
    expect(screen.getAllByTestId('swatch-dot')).toHaveLength(5);
    expect(screen.getByText('+7')).toBeTruthy();
  });

  it('a black dot on an ink skin keeps a solid foreground edge (F7, LB-b, B1-107)', () => {
    const p = {
      options: [
        {
          name: 'Color',
          _count: { values: 1 },
          values: [{ id: 'b', value: 'Black', swatchHex: '#000000' }],
        },
      ],
    };
    render(<SwatchDots product={p as never} max={5} />);
    const dot = screen.getByTestId('swatch-dot');
    // solid foreground: a black dot on a dark look still has a >= 3:1 outline (B1-107)
    expect(dot.className).toMatch(/\bborder-foreground(?!\/)/);
    expect(dot.className).not.toMatch(/border-foreground\//);
  });
});

// R-14 (W3): the dots are decorative, but the COUNT is information; screen readers get it.
describe('SwatchDots colour count for assistive tech', () => {
  const p = (n: number) => ({
    options: [
      {
        name: 'Color',
        values: Array.from({ length: n }, (_, i) => ({
          id: `${i}`,
          value: `c${i}`,
          swatchHex: '#111111',
        })),
      },
    ],
  });
  it('en: "7 colours" in an sr-only span, the dots stay aria-hidden', () => {
    const { container } = render(<SwatchDots product={p(7)} max={5} />);
    expect(container.querySelector('.sr-only')?.textContent).toBe('7 colours');
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
  it('ar: the counted noun takes its Arabic plural form', () => {
    lang.value = 'ar';
    const two = render(<SwatchDots product={p(2)} max={5} />).container;
    expect(two.querySelector('.sr-only')?.textContent).toBe('لونان');
    cleanup();
    const three = render(<SwatchDots product={p(3)} max={5} />).container;
    expect(three.querySelector('.sr-only')?.textContent).toBe('3 ألوان');
  });
});
