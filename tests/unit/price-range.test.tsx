// @vitest-environment jsdom
/**
 * Audit 2026-11-03 #9: the products filter's price range. Pure maths (snap, ratio, keys incl. RTL)
 * and the rendered slider: ARIA slider pattern, formatted numbers, keyboard, thumbs never cross.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import {
  moveThumb,
  ratioOf,
  snap,
  valueForKey,
  valueFromRatio,
} from '../../apps/web/src/app/products/price-range';
import { PriceRangeSlider } from '../../apps/web/src/app/products/PriceRangeSlider';

afterEach(cleanup);

describe('price-range maths', () => {
  it('snaps to the step grid and clamps', () => {
    expect(snap(103, 0, 1000, 50)).toBe(100);
    expect(snap(-5, 0, 1000, 50)).toBe(0);
    expect(snap(5000, 0, 1000, 50)).toBe(1000);
    expect(snap(7, 3, 100, 5)).toBe(8);
  });
  it('ratio to value and back', () => {
    expect(valueFromRatio(0.5, 0, 1000, 10)).toBe(500);
    expect(valueFromRatio(2, 0, 1000, 10)).toBe(1000);
    expect(ratioOf(250, 0, 1000)).toBe(0.25);
    expect(ratioOf(5, 5, 5)).toBe(0);
  });
  it('thumbs never cross', () => {
    expect(moveThumb('min', 900, 100, 500)).toEqual([500, 500]);
    expect(moveThumb('max', 50, 100, 500)).toEqual([100, 100]);
  });
  it('keys: LTR ArrowRight raises, RTL ArrowLeft raises; Home/End/PageUp', () => {
    const o = { floor: 0, ceil: 1000, step: 10 };
    expect(valueForKey('ArrowRight', 100, { ...o, rtl: false })).toBe(110);
    expect(valueForKey('ArrowLeft', 100, { ...o, rtl: false })).toBe(90);
    expect(valueForKey('ArrowLeft', 100, { ...o, rtl: true })).toBe(110);
    expect(valueForKey('ArrowRight', 100, { ...o, rtl: true })).toBe(90);
    expect(valueForKey('ArrowUp', 100, { ...o, rtl: true })).toBe(110);
    expect(valueForKey('PageUp', 100, { ...o, rtl: false })).toBe(200);
    expect(valueForKey('Home', 100, { ...o, rtl: false })).toBe(0);
    expect(valueForKey('End', 100, { ...o, rtl: false })).toBe(1000);
    expect(valueForKey('Tab', 100, { ...o, rtl: false })).toBeNull();
  });
});

describe('PriceRangeSlider', () => {
  const setup = (over: Partial<React.ComponentProps<typeof PriceRangeSlider>> = {}) => {
    const onChange = vi.fn();
    render(
      <PriceRangeSlider
        idPrefix="t"
        floor={0}
        ceil={1000}
        min={200}
        max={800}
        step={10}
        onChange={onChange}
        format={v => `${v.toLocaleString('en-US')} EGP`}
        minLabel="Minimum price"
        maxLabel="Maximum price"
        {...over}
      />
    );
    return onChange;
  };

  it('two named sliders with value, bounds and a formatted aria-valuetext', () => {
    setup();
    const lo = screen.getByRole('slider', { name: 'Minimum price' });
    const hi = screen.getByRole('slider', { name: 'Maximum price' });
    expect(lo.getAttribute('aria-valuenow')).toBe('200');
    expect(lo.getAttribute('aria-valuemin')).toBe('0');
    expect(lo.getAttribute('aria-valuemax')).toBe('1000');
    expect(lo.getAttribute('aria-valuetext')).toBe('200 EGP');
    expect(hi.getAttribute('aria-valuetext')).toBe('800 EGP');
    expect(lo.tabIndex).toBe(0);
    expect(screen.getByTestId('price-range-min').textContent).toBe('200 EGP');
    expect(screen.getByTestId('price-range-max').textContent).toBe('800 EGP');
  });

  it('the keyboard moves a thumb by a step and reports both bounds', () => {
    const onChange = setup();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Minimum price' }), {
      key: 'ArrowRight',
    });
    expect(onChange).toHaveBeenCalledWith(210, 800);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Maximum price' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(200, 1000);
  });

  it('the min thumb cannot pass the max thumb', () => {
    const onChange = setup({ min: 790, max: 800 });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Minimum price' }), { key: 'End' });
    expect(onChange).toHaveBeenCalledWith(800, 800);
  });

  it('no call when a key does not change the value', () => {
    const onChange = setup({ min: 0 });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Minimum price' }), { key: 'Home' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
