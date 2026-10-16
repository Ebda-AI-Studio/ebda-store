import { describe, it, expect } from 'vitest';
import { contrastRatio, parseColorToRgb, rgbToHslTriplet } from '@ebda/shared';
import { resolveFooterInk, footerRootPaint } from './footer-ink';

const hexOf = (t: string) => {
  const rgb = parseColorToRgb(`hsl(${t})`)!;
  return '#' + [rgb.r, rgb.g, rgb.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
};

describe('resolveFooterInk (B0-46 I-1)', () => {
  const SOLIDS = [
    '#7c3bed',
    '#e92063',
    '#ff6f00',
    '#111111',
    '#1a2b4c',
    '#ffffff',
    '#f5efe6',
    '#808080',
    '#777777',
    '#a0a0a0',
  ];
  it.each(SOLIDS)('%s: ink and muted clear 4.5:1 after the hsl triplet round trip', bg => {
    const paint = footerRootPaint(bg);
    const st = paint.style as Record<string, string>;
    expect(contrastRatio(bg, st['--footer-ink'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, hexOf(st['--foreground']))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, hexOf(st['--muted-foreground']))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, st['--footer-ink-muted'])).toBeGreaterThanOrEqual(4.5);
    expect(paint['data-footer-ink']).toBe('');
  });
  it('a gradient is judged on its worst stop', () => {
    const g = 'linear-gradient(90deg, #111111 0%, #e92063 50%, #ffffff 100%)';
    const ink = resolveFooterInk(g)!;
    for (const stop of ['#111111', '#e92063', '#ffffff']) {
      // The best single ink cannot be 4.5 on both a near-black and a white stop; it must be the
      // better of the two on the worst stop, never worse than the alternative.
      const alt = ink.fg === '#ffffff' ? '#000000' : '#ffffff';
      const worstOf = (f: string) =>
        Math.min(...['#111111', '#e92063', '#ffffff'].map(s => contrastRatio(s, f)));
      expect(worstOf(ink.fg)).toBeGreaterThanOrEqual(worstOf(alt));
      expect(stop).toBeTruthy();
    }
    const two = resolveFooterInk('linear-gradient(135deg, #7c3bed, #1a2b4c)')!;
    expect(two.fg).toBe('#ffffff');
    expect(
      Math.min(contrastRatio('#7c3bed', two.muted), contrastRatio('#1a2b4c', two.muted))
    ).toBeGreaterThanOrEqual(4.5);
  });
  it('hsl()/rgb() paints parse; unparseable paint and no paint add no override', () => {
    expect(resolveFooterInk('hsl(262 83% 58%)')?.fg).toBeDefined();
    expect(resolveFooterInk('rgb(124, 59, 237)')?.fg).toBe('#ffffff');
    expect(resolveFooterInk('token:primary')).toBeUndefined();
    expect(footerRootPaint(undefined)).toEqual({ style: undefined });
    expect(footerRootPaint('token:primary').style).toEqual({ backgroundColor: 'token:primary' });
  });
  it('rgbToHslTriplet is what the vars carry', () => {
    const st = footerRootPaint('#7c3bed').style as Record<string, string>;
    expect(st['--foreground']).toBe(rgbToHslTriplet({ r: 255, g: 255, b: 255 }));
  });
});
