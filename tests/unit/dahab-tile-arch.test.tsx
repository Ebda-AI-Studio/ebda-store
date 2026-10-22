// Ruling B5-3: a stored tileShape 'arch' still renders (the tile never throws), and renders as the
// look's rectangle; the arch frame is not drawn by any shape.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DahabTile } from '../../apps/web/src/templates/dahab/CategoryCard';

const tile = (shape?: 'arch' | 'rectangle' | 'circle') =>
  renderToStaticMarkup(<DahabTile href="/products?category=rings" label="خواتم" shape={shape} />);

describe('DahabTile shapes', () => {
  it('a stored "arch" renders as the rectangle, byte for byte', () => {
    expect(tile('arch')).toBe(tile('rectangle'));
    expect(tile()).toBe(tile('rectangle'));
  });
  it('no shape draws the arch frame', () => {
    for (const s of ['arch', 'rectangle', 'circle'] as const)
      expect(tile(s), s).not.toContain('rounded-t-[999px]');
  });
  it('the circle still exists and is round', () => {
    expect(tile('circle')).toContain('rounded-full');
  });
});
