import { describe, expect, it } from 'vitest';
import {
  colorToHex,
  contrastRatioOrNull,
  readVerdict,
  resolveColorForMeasure,
} from './color-measure';
import { contrastRatio } from './color';
import type { StoreTheme } from '../types/store-theme';

const legacy = {} as unknown as StoreTheme; // a theme row with none of the *Color fields

describe('resolveColorForMeasure', () => {
  it('resolves a token the theme lacks through the template defaults, never to a CSS variable', () => {
    for (const t of ['primary', 'secondary', 'accent', 'card', 'muted', 'foreground', 'border']) {
      const c = resolveColorForMeasure(`token:${t}`, legacy);
      expect(c, t).not.toBeNull();
      expect(c).not.toContain('var(');
    }
  });
  it('uses the merchant theme when it has the colour', () => {
    const theme = { primaryColor: '36 36% 52%' } as unknown as StoreTheme;
    expect(resolveColorForMeasure('token:primary', theme)).toBe('hsl(36 36% 52%)');
  });
  it('passes hex through and answers null for nothing or junk', () => {
    expect(resolveColorForMeasure('#B08D57', undefined)).toBe('#B08D57');
    expect(resolveColorForMeasure('', legacy)).toBeNull();
    expect(resolveColorForMeasure(undefined, legacy)).toBeNull();
    expect(resolveColorForMeasure('hsl(var(--primary))', legacy)).toBeNull();
    expect(resolveColorForMeasure('not-a-colour', legacy)).toBeNull();
  });
});

describe('contrastRatioOrNull', () => {
  it('matches the WCAG reference pairs', () => {
    expect(contrastRatioOrNull('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatioOrNull('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #777 on white is the classic 4.48 : 1 (just under AA)
    expect(contrastRatioOrNull('#ffffff', '#777777')).toBeCloseTo(4.48, 2);
    expect(contrastRatioOrNull('#B08D57', '#0A0B0C')!).toBeGreaterThan(6);
  });
  it('is null, not 1.0, when either side is not a real colour', () => {
    expect(contrastRatioOrNull('hsl(var(--primary))', '#000')).toBeNull();
    expect(contrastRatioOrNull('#fff', undefined)).toBeNull();
    // the old behaviour this replaces
    expect(contrastRatio('hsl(var(--primary))', '#000000')).toBe(1);
  });
});

describe('readVerdict', () => {
  it('draws the AA lines at 4.5 and 3', () => {
    expect(readVerdict(4.5)).toBe('easy');
    expect(readVerdict(4.49)).toBe('large');
    expect(readVerdict(3)).toBe('large');
    expect(readVerdict(2.99)).toBe('hard');
  });
});

describe('colorToHex', () => {
  it('turns hsl and triplets into hex and refuses non-colours', () => {
    expect(colorToHex('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(colorToHex('36 36% 52%')).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorToHex('#FFF')).toBe('#ffffff');
    expect(colorToHex('hsl(var(--x))')).toBeNull();
  });
});
