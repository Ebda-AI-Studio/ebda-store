// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { SwatchDots } from './SwatchDots';

afterEach(cleanup);

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

  it('a black dot on an ink skin keeps a 35% foreground edge (F7, WCAG 1.4.11)', () => {
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
    expect(dot.className).toContain('border-foreground/35');
    expect(dot.className).not.toContain('border-foreground/15');
  });
});
