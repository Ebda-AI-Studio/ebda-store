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
  footerLogoContrastFilter,
  deriveCoreBrandTokens,
  hslToRgb,
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

  it('returns black for the legacy orange (L≈0.324; black=7.5:1 passes AA, white=2.8:1 fails)', () => {
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

  it('passes WCAG AA for the legacy orange + white text', () => {
    const ratio = contrastRatio('#FF6E00', '#FFFFFF');
    // legacy orange + white is ~3.0:1 — passes AA large text (3.0) but fails AA normal text (4.5).
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

describe('footerLogoContrastFilter', () => {
  it('explicit true → white-logo filter regardless of bg', () => {
    // Dark bg with explicit true.
    expect(footerLogoContrastFilter('#000000', true)).toBe('brightness(0) invert(1)');
    // Light bg with explicit true — still forces white.
    expect(footerLogoContrastFilter('#FFFFFF', true)).toBe('brightness(0) invert(1)');
    // Undefined bg with explicit true.
    expect(footerLogoContrastFilter(undefined, true)).toBe('brightness(0) invert(1)');
  });

  it('explicit false → no filter (keep original logo color)', () => {
    expect(footerLogoContrastFilter('#000000', false)).toBe('none');
    expect(footerLogoContrastFilter('#FFFFFF', false)).toBe('none');
    expect(footerLogoContrastFilter(undefined, false)).toBe('none');
  });

  it('auto (undefined explicitInvert): dark bg → white logo filter', () => {
    // Black footer — logo must be white.
    expect(footerLogoContrastFilter('#000000')).toBe('brightness(0) invert(1)');
    // Very dark grey.
    expect(footerLogoContrastFilter('#1a1a1a')).toBe('brightness(0) invert(1)');
  });

  it('auto: light bg → leave logo as-is (never crush a colour logo to black)', () => {
    // White footer — AUTO deliberately returns 'none' so a full-colour brand
    // logo isn't crushed to a black silhouette (the "footer logo is black" fix).
    // Merchants who want a forced-mono logo opt in via explicitInvert.
    expect(footerLogoContrastFilter('#FFFFFF')).toBe('none');
    // Typical light section-alt bg (bare HSL triplet format used by bgSectionAlt).
    expect(footerLogoContrastFilter('0 0% 98%')).toBe('none');
  });

  it('auto: unparseable bg → no filter (leave logo as-is)', () => {
    expect(footerLogoContrastFilter(undefined)).toBe('none');
    expect(footerLogoContrastFilter('var(--bg-section-alt)')).toBe('none');
    expect(footerLogoContrastFilter('')).toBe('none');
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

  it('monochrome pattern with theme: shaded variants (primary + lighter + darker)', () => {
    // Seeds use concrete hex so theme is only needed for token resolution (n/a here).
    // resolveAndMix on a hex goes directly to the blend math — theme presence
    // doesn't change the result, but we pass it to exercise the theme code path.
    const p = generateSectionPalette(
      { ...seeds, pattern: 'monochrome' as PalettePattern },
      TEST_THEME
    );
    expect(p.hero.bgColor).toBe('#FF6E00'); // primary as-is
    expect(p.newArrivals.bgColor).toBe('#FF6E00'); // primary as-is
    expect(p.categories.bgColor).toBe('#FFA866'); // lighten 0.4: r=255 g=168 b=102
    expect(p.bestSellers.bgColor).toBe(p.categories.bgColor); // same lighter shade
    expect(p.testimonials.bgColor).toBe('#D95E00'); // darken 0.15: r=217 g=94 b=0
  });

  it('monochrome pattern without theme: token primary stays unchanged across all slots', () => {
    // No theme to resolve tokens, so shaded slots fall back to primary as-is.
    // Acceptable — sections look identical, but no broken CSS.
    const p = generateSectionPalette({
      primary: 'token:primary',
      pattern: 'monochrome' as PalettePattern,
    });
    for (const k of ['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const) {
      expect(p[k].bgColor).toBe('token:primary');
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

  it('cardFrameSize defaults to normal across all sections', () => {
    const p = generateSectionPalette({ primary: '#FF6E00' });
    for (const k of ['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const) {
      expect(p[k].cardFrameSize).toBe('normal');
    }
  });

  it('cardFrameSize from seeds propagates to all sections', () => {
    const p = generateSectionPalette({ primary: '#FF6E00', cardFrameSize: 'spacious' });
    for (const k of ['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const) {
      expect(p[k].cardFrameSize).toBe('spacious');
    }
  });
});

describe('deriveCoreBrandTokens — brand-tinted neutral recipe', () => {
  // Parse a bare 'H S% L%' triplet into numbers.
  const parse = (t: string): { h: number; s: number; l: number } => {
    const m = t.match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/);
    if (!m) throw new Error(`not a triplet: ${t}`);
    return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
  };
  // Build a hex from a triplet (the admin ColorField bridges triplet↔hex).
  const toHex = (t: string): string => {
    const { h, s, l } = parse(t);
    const { r, g, b } = hslToRgb(h, s, l);
    const hx = (c: number) => Math.round(c).toString(16).padStart(2, '0');
    return `#${hx(r)}${hx(g)}${hx(b)}`;
  };

  // An arbitrary brand — NOT any production store — to prove the recipe
  // generalises to any hue rather than hard-coding one merchant's palette.
  const PRIMARY = '265 60% 35%'; // a deep violet
  const SECONDARY = '190 45% 55%'; // a teal second colour
  const Hp = 265;

  const tokens = deriveCoreBrandTokens({ primary: toHex(PRIMARY), secondary: toHex(SECONDARY) });

  it('tints every neutral with the PRIMARY hue (±2°), not generic grey', () => {
    for (const key of [
      'foregroundColor',
      'cardForeground',
      'mutedForeground',
      'borderColor',
      'mutedColor',
    ] as const) {
      expect(Math.abs(parse(tokens[key]).h - Hp)).toBeLessThanOrEqual(2);
    }
  });

  it('lays neutrals on a monotonic dark→light lightness ladder', () => {
    const fgL = parse(tokens.foregroundColor).l; // body text — darkest
    const mutedFgL = parse(tokens.mutedForeground).l; // supporting text
    const borderL = parse(tokens.borderColor).l; // hairlines
    const mutedL = parse(tokens.mutedColor).l; // placeholders — lightest neutral
    expect(fgL).toBeLessThan(mutedFgL);
    expect(mutedFgL).toBeLessThan(borderL);
    expect(borderL).toBeLessThan(mutedL);
    expect(mutedL).toBeLessThan(100);
  });

  it('keeps card + page background white so product images read cleanly', () => {
    expect(tokens.cardColor).toBe('0 0% 100%');
    expect(tokens.backgroundColor).toBe('0 0% 100%');
  });

  it('body text stays high-contrast on white (AA for normal text)', () => {
    expect(contrastRatio(`hsl(${tokens.foregroundColor})`, '#ffffff')).toBeGreaterThan(4.5);
  });

  it('accent is a LIGHT wash of a CHOSEN hue (secondary here), never invented', () => {
    const accent = parse(tokens.accentColor);
    // Reuses the merchant's secondary hue (teal ~190), not a hue-math invention.
    expect(Math.abs(accent.h - 190)).toBeLessThanOrEqual(3);
    expect(accent.l).toBeGreaterThanOrEqual(88); // a light wash, not a bold fill
  });

  it('regression: brown primary + light-blue secondary never derives a green accent', () => {
    // The exact failure Ahmad hit: brown #906c51 + light-blue #b4ceee whose
    // hue-average landed on green (~150°). The accent must follow the secondary
    // hue (blue), never the green band.
    const t = deriveCoreBrandTokens({ primary: '#906c51', secondary: '#b4ceee' });
    const accentH = parse(t.accentColor).h;
    expect(accentH).toBeGreaterThan(180); // blue-ish, the chosen secondary hue
    expect(accentH < 90 || accentH > 160).toBe(true); // never green
  });

  it('a near-neutral secondary falls back to the primary hue for the accent', () => {
    // demo-shop-shaped case (secondary is a near-grey surface): accent must
    // still harmonise by borrowing the PRIMARY hue rather than going chromatic.
    const t = deriveCoreBrandTokens({ primary: toHex(PRIMARY), secondary: '0 8% 95%' });
    expect(Math.abs(parse(t.accentColor).h - Hp)).toBeLessThanOrEqual(2);
  });
});
