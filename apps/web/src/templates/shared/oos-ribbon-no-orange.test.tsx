// @vitest-environment jsdom
/**
 * Taste re-audit P1-2 (2026-10-16): the default sold-out sash was a fixed terracotta,
 * hsl(15 60% 33%) = #873B22, orange and in no look's palette, rotated like a sale flyer.
 * Ahmad 2026-10-16: Ebda has no orange. The default sash reads the theme's ink tokens on
 * every store; on a look store it is a flat chip on the look radius, never rotated. The
 * English label is sentence case ("Sold out").
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutOfStockRibbon } from './ProductCardCta';

afterEach(cleanup);

describe('the sold-out sash has no orange (P1-2)', () => {
  it('default: ink on paper tokens, sentence-case label', () => {
    const { container } = render(<OutOfStockRibbon inStock={false} />);
    const band = Array.from(container.querySelectorAll('span')).find(s =>
      /Sold out/.test(s.textContent ?? '')
    )!;
    expect(band).toBeTruthy();
    const style = band.getAttribute('style') ?? '';
    expect(style).toMatch(/background-color:\s*hsl\(var\(--foreground\)\)/);
    expect(style).toMatch(/(^|;)\s*color:\s*hsl\(var\(--background\)\)/);
  });

  it('a look store: a flat chip on the look radius, no rotation', () => {
    const { container } = render(<OutOfStockRibbon inStock={false} isRtl flat />);
    const chip = Array.from(container.querySelectorAll('span')).find(s =>
      /نفدت الكمية/.test(s.textContent ?? '')
    )!;
    expect(chip.className).toContain('rounded-[var(--radius)]');
    expect(container.innerHTML).not.toMatch(/rotate\(/);
  });

  it('no storefront source hard-codes the old terracotta', () => {
    const src = readFileSync(join(__dirname, 'ProductCardCta.tsx'), 'utf8');
    expect(src).not.toMatch(/hsl\(15 60% 33%\)/);
  });
});
