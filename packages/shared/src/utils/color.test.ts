// packages/shared/src/utils/color.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveColor,
  pickReadableForeground,
  contrastRatio,
  parseColorToRgb,
  relativeLuminance,
  generateSectionPalette,
  lightenColor,
  darkenColor,
} from './color';
import type { PalettePattern } from './color';
import type { StoreTheme } from '../types/store-theme';

const TEST_THEME = {
  primary: '24 100% 50%', // brand orange ~#FF6E00
  secondary: '220 13% 91%',
  accent: '210 80% 60%',
  card: '0 0% 100%', // white
  muted: '210 16% 96%',
  foreground: '224 71% 4%', // near-black
  border: '220 13% 91%',
  background: '0 0% 100%',
} as unknown as StoreTheme;

describe('parseColorToRgb', () => {
  it('parses #RRGGBB', () => {
    expect(parseColorToRgb('#FF6E00')).toEqual({ r: 255, g: 110, b: 0 });
  });

  it('parses #RGB shorthand', () => {
    expect(parseColorToRgb('#F00')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses hsl(H S% L%) space-separated', () => {
    expect(parseColorToRgb('hsl(0 100% 50%)')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses bare HSL triplet "H S% L%"', () => {
    expect(parseColorToRgb('0 100% 50%')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('returns null for invalid input', () => {
    expect(parseColorToRgb('not-a-color')).toBeNull();
    expect(parseColorToRgb('')).toBeNull();
  });
});

describe('resolveColor', () => {
  it('returns undefined for empty input', () => {
    expect(resolveColor(undefined, TEST_THEME)).toBeUndefined();
    expect(resolveColor('', TEST_THEME)).toBeUndefined();
  });

  it('passes through raw hex unchanged', () => {
    expect(resolveColor('#FF6E00', TEST_THEME)).toBe('#FF6E00');
  });

  it('resolves token:<name> to hsl() string', () => {
    expect(resolveColor('token:primary', TEST_THEME)).toBe('hsl(24 100% 50%)');
  });

  it('returns undefined for unknown token', () => {
    expect(resolveColor('token:nonexistent' as string, TEST_THEME)).toBeUndefined();
  });

  it('passes through HSL string from theme if already wrapped', () => {
    const themeWithWrappedHsl = { ...TEST_THEME, primary: 'hsl(24 100% 50%)' } as StoreTheme;
    expect(resolveColor('token:primary', themeWithWrappedHsl)).toBe('hsl(24 100% 50%)');
  });
});

describe('pickReadableForeground', () => {
  it('returns black for bright bg', () => {
    expect(pickReadableForeground('#FFFFFF')).toBe('#000000');
    expect(pickReadableForeground('#FFFF00')).toBe('#000000'); // yellow
  });

  it('returns white for dark bg', () => {
    expect(pickReadableForeground('#000000')).toBe('#ffffff');
    expect(pickReadableForeground('#1a1a1a')).toBe('#ffffff');
  });

  it('returns black for the FWB brand orange (L≈0.324; black=7.5:1 passes AA, white=2.8:1 fails)', () => {
    // #FF6E00 has luminance ~0.324. WCAG flip point is 0.179 so this is
    // above the threshold → black wins. Verified mathematically:
    //   contrast(orange, black) = (0.324 + 0.05) / 0.05 = 7.48 ✓ AA
    //   contrast(orange, white) = 1.05 / 0.374        = 2.81 ✗ AA
    expect(pickReadableForeground('#FF6E00')).toBe('#000000');
  });

  it('handles hsl() input', () => {
    expect(pickReadableForeground('hsl(0 0% 100%)')).toBe('#000000');
    expect(pickReadableForeground('hsl(0 0% 0%)')).toBe('#ffffff');
  });

  it('returns undefined for unparseable input', () => {
    expect(pickReadableForeground(undefined)).toBeUndefined();
    expect(pickReadableForeground('not-a-color')).toBeUndefined();
  });
});

describe('contrastRatio', () => {
  it('returns 21 for black vs white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#FF6E00', '#FF6E00')).toBeCloseTo(1, 1);
  });

  it('passes WCAG AA for the FWB orange + white text', () => {
    const ratio = contrastRatio('#FF6E00', '#FFFFFF');
    // FWB orange + white is ~3.0:1 — passes AA large text (3.0) but fails AA normal text (4.5).
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('returns NaN-safe value when an input is unparseable', () => {
    expect(contrastRatio('not-a-color', '#FFFFFF')).toBe(1);
  });
});

describe('lightenColor / darkenColor', () => {
  it('lightenColor pushes toward white', () => {
    const lighter = lightenColor('#FF6E00', 0.4);
    expect(lighter).not.toBe('#FF6E00');
    // Result should be parseable + have higher luminance than the seed.
    const seedLum = relativeLuminance(parseColorToRgb('#FF6E00')!);
    const lightLum = relativeLuminance(parseColorToRgb(lighter)!);
    expect(lightLum).toBeGreaterThan(seedLum);
  });

  it('darkenColor pushes toward black', () => {
    const darker = darkenColor('#FF6E00', 0.4);
    const seedLum = relativeLuminance(parseColorToRgb('#FF6E00')!);
    const darkLum = relativeLuminance(parseColorToRgb(darker)!);
    expect(darkLum).toBeLessThan(seedLum);
  });
});

describe('generateSectionPalette', () => {
  it('with one seed: alternates seed bg / neutral bg across sections', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    expect(palette.hero.bgColor).toBe('#FF6E00');
    expect(palette.categories.bgColor).toMatch(/^#/); // some neutral
    expect(palette.newArrivals.bgColor).not.toBe(palette.categories.bgColor);
    expect(palette.bestSellers.bgColor).toBe(palette.categories.bgColor); // neutrals match
    expect(palette.testimonials.bgColor).toBe('#FF6E00'); // seed returns at end
  });

  it('every section gets cardFrameColor = primary seed', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    for (const section of [
      'hero',
      'categories',
      'newArrivals',
      'bestSellers',
      'testimonials',
    ] as const) {
      expect(palette[section].cardFrameColor).toBe('#FF6E00');
    }
  });

  it('every section gets cardFrameWidth = normal (2px) by default', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    for (const section of [
      'hero',
      'categories',
      'newArrivals',
      'bestSellers',
      'testimonials',
    ] as const) {
      expect(palette[section].cardFrameWidth).toBe('normal');
    }
  });

  it('every section heading color auto-fixes against its bg', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    expect(palette.hero.headingColor).toBe('#000000'); // black on orange (correct AA)
    expect(palette.categories.headingColor).toBe('#000000'); // black on light neutral
  });

  it('with primary + accent: accent populates alternating bg slots', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00', accent: '#0066CC' });
    expect(palette.hero.bgColor).toBe('#FF6E00');
    expect(palette.newArrivals.bgColor).toBe('#0066CC'); // accent gets a slot
  });

  it('passes token refs through unchanged for the caller to resolve at render', () => {
    const palette = generateSectionPalette({ primary: 'token:primary' });
    expect(palette.hero.bgColor).toBe('token:primary');
    expect(palette.hero.cardFrameColor).toBe('token:primary');
    // Heading color still picked from the resolved seed — caller passes theme separately when resolving.
    // The helper returns 'auto' as a sentinel meaning "auto-fix at render".
    expect(palette.hero.headingColor).toBe('auto');
  });
});

describe('generateSectionPalette patterns', () => {
  const seeds = { primary: '#FF6E00', accent: '#0066CC', neutral: '#FFFFFF' };

  it('alternating pattern (default): primary-neutral-accent-neutral-primary', () => {
    // No explicit pattern → defaults to 'alternating'.
    const p = generateSectionPalette({ ...seeds });
    expect(p.hero.bgColor).toBe('#FF6E00');
    expect(p.categories.bgColor).toBe('#FFFFFF');
    expect(p.newArrivals.bgColor).toBe('#0066CC');
    expect(p.bestSellers.bgColor).toBe('#FFFFFF');
    expect(p.testimonials.bgColor).toBe('#FF6E00');
  });

  it('monochrome pattern: every section gets primary bg', () => {
    const p = generateSectionPalette({ ...seeds, pattern: 'monochrome' as PalettePattern });
    for (const k of ['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const) {
      expect(p[k].bgColor).toBe('#FF6E00');
    }
  });

  it('triad pattern: primary-neutral-accent-primary-neutral', () => {
    const p = generateSectionPalette({ ...seeds, pattern: 'triad' as PalettePattern });
    expect(p.hero.bgColor).toBe('#FF6E00');
    expect(p.categories.bgColor).toBe('#FFFFFF');
    expect(p.newArrivals.bgColor).toBe('#0066CC');
    expect(p.bestSellers.bgColor).toBe('#FF6E00');
    expect(p.testimonials.bgColor).toBe('#FFFFFF');
  });

  it('single-bg pattern: every section gets neutral bg', () => {
    const p = generateSectionPalette({ ...seeds, pattern: 'single-bg' as PalettePattern });
    for (const k of ['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const) {
      expect(p[k].bgColor).toBe('#FFFFFF');
    }
  });

  it('overrides win over pattern-derived defaults', () => {
    const p = generateSectionPalette({
      ...seeds,
      pattern: 'monochrome' as PalettePattern,
      overrides: { categories: { bgColor: '#00FF00' } },
    });
    expect(p.hero.bgColor).toBe('#FF6E00');
    expect(p.categories.bgColor).toBe('#00FF00'); // override wins
    expect(p.newArrivals.bgColor).toBe('#FF6E00');
  });

  it('cardFrameWidth from seeds applies to all sections', () => {
    const p = generateSectionPalette({ ...seeds, cardFrameWidth: 'xthick' });
    for (const k of ['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const) {
      expect(p[k].cardFrameWidth).toBe('xthick');
    }
  });
});
