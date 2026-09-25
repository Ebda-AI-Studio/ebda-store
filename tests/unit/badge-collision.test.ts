/**
 * `avoidReservedCorner` — the one algorithm behind the 2026-09-25
 * heart/badge collision fix (issues #1609, #1611, #548), shared by
 * `custom-badge.ts` (physical left/right corners) and `ProductCardCta.tsx`'s
 * `OutOfStockRibbon` (logical start/end corners). Tested once here, on its
 * own generic contract, so both call sites can trust it without re-deriving
 * the truth table themselves.
 */
import { describe, it, expect } from 'vitest';
import { avoidReservedCorner } from '../../apps/web/src/templates/shared/badge-collision';

describe('avoidReservedCorner', () => {
  it('never touches a bottom corner — no action button ever renders there', () => {
    const r = avoidReservedCorner({
      v: 'bottom',
      h: 'left',
      otherH: 'right',
      hReserved: true,
      otherHReserved: true,
    });
    expect(r).toEqual({ v: 'bottom', h: 'left' });
  });

  it('leaves a top corner alone when it is not reserved', () => {
    const r = avoidReservedCorner({
      v: 'top',
      h: 'left',
      otherH: 'right',
      hReserved: false,
      otherHReserved: true,
    });
    expect(r).toEqual({ v: 'top', h: 'left' });
  });

  it('swaps to the other top corner when only this one is reserved', () => {
    const r = avoidReservedCorner({
      v: 'top',
      h: 'left',
      otherH: 'right',
      hReserved: true,
      otherHReserved: false,
    });
    expect(r).toEqual({ v: 'top', h: 'right' });
  });

  it('drops to the bottom, same side, when BOTH top corners are reserved', () => {
    const r = avoidReservedCorner({
      v: 'top',
      h: 'left',
      otherH: 'right',
      hReserved: true,
      otherHReserved: true,
    });
    expect(r).toEqual({ v: 'bottom', h: 'left' });
  });

  it('works identically over the logical start/end alphabet', () => {
    const r = avoidReservedCorner<'start' | 'end'>({
      v: 'top',
      h: 'start',
      otherH: 'end',
      hReserved: true,
      otherHReserved: false,
    });
    expect(r).toEqual({ v: 'top', h: 'end' });
  });
});
