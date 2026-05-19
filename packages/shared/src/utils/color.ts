// packages/shared/src/utils/color.ts

export interface Rgb {
  r: number; // 0-255
  g: number;
  b: number;
}

/**
 * Parse a color string to RGB. Handles:
 *   - '#RRGGBB' / '#RGB' / '#RRGGBBAA'
 *   - 'hsl(H S% L%)' / 'hsl(H, S%, L%)'
 *   - bare HSL triplet 'H S% L%' (Tailwind/shadcn convention used by StoreTheme)
 * Returns null for unparseable input.
 */
export function parseColorToRgb(input: string | undefined): Rgb | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Hex
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  // hsl(...) wrapper
  const hslMatch =
    trimmed.match(
      /^hsl\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)%\s*[, ]\s*(-?\d+(?:\.\d+)?)%\s*\)$/i
    ) ||
    trimmed.match(/^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*\)$/i);

  if (hslMatch) {
    return hslToRgb(parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]));
  }

  // Bare triplet "H S% L%" (Tailwind shadcn convention)
  const tripletMatch = trimmed.match(
    /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/
  );
  if (tripletMatch) {
    return hslToRgb(
      parseFloat(tripletMatch[1]),
      parseFloat(tripletMatch[2]),
      parseFloat(tripletMatch[3])
    );
  }

  return null;
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sNorm = Math.max(0, Math.min(100, s)) / 100;
  const lNorm = Math.max(0, Math.min(100, l)) / 100;
  const hNorm = (((h % 360) + 360) % 360) / 360;

  if (sNorm === 0) {
    const v = Math.round(lNorm * 255);
    return { r: v, g: v, b: v };
  }

  const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
  const p = 2 * lNorm - q;

  const hueToRgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  return {
    r: Math.round(hueToRgb(hNorm + 1 / 3) * 255),
    g: Math.round(hueToRgb(hNorm) * 255),
    b: Math.round(hueToRgb(hNorm - 1 / 3) * 255),
  };
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 * Formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(rgb: Rgb): number {
  const norm = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * norm(rgb.r) + 0.7152 * norm(rgb.g) + 0.0722 * norm(rgb.b);
}

// Task 4: resolveColor + COLOR_TOKENS + type exports

import type { StoreTheme } from '../types/store-theme';

export type ColorValue = string;

export const COLOR_TOKENS = [
  'primary',
  'secondary',
  'accent',
  'card',
  'muted',
  'foreground',
  'border',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

const TOKEN_PREFIX = 'token:';

/**
 * Maps the short token name (used in colorValue strings and COLOR_TOKENS)
 * to the corresponding StoreTheme field name. StoreTheme uses the `*Color`
 * suffix convention while CSS variables use the bare token name.
 */
const TOKEN_TO_THEME_KEY: Record<ColorToken, keyof StoreTheme> = {
  primary: 'primaryColor',
  secondary: 'secondaryColor',
  accent: 'accentColor',
  card: 'cardColor',
  muted: 'mutedColor',
  foreground: 'foregroundColor',
  border: 'borderColor',
};

/**
 * Resolve a `ColorValue` string to an actual CSS color.
 *   - 'token:<name>' → looks up StoreTheme[<name>Color] and wraps as hsl() if not already wrapped
 *   - raw '#RRGGBB' / '#RGB' / 'hsl(...)' → passes through unchanged
 *   - empty / undefined → undefined (caller falls back to theme default)
 */
export function resolveColor(value: ColorValue | undefined, theme: StoreTheme): string | undefined {
  if (!value) return undefined;

  if (value.startsWith(TOKEN_PREFIX)) {
    const key = value.slice(TOKEN_PREFIX.length) as ColorToken;
    if (!(COLOR_TOKENS as readonly string[]).includes(key)) return undefined;
    // Use TOKEN_TO_THEME_KEY to map token → StoreTheme field (e.g. 'primary' → 'primaryColor').
    // Fall back to direct key lookup to stay compatible with test fixtures that use
    // bare Tailwind-style theme objects (e.g. { primary: '24 100% 50%' }).
    const themeKey = TOKEN_TO_THEME_KEY[key];
    const raw =
      (theme[themeKey] as string | undefined) ??
      (theme as unknown as Record<string, string | undefined>)[key];
    if (!raw) return undefined;
    return raw.startsWith('hsl(') || raw.startsWith('#') ? raw : `hsl(${raw})`;
  }

  return value;
}

// Task 5: pickReadableForeground

/**
 * Returns the optimal text color ('#ffffff' or '#000000') for a given background
 * using the WCAG relative-luminance flip threshold (0.179).
 *
 * Returns undefined when the input can't be parsed — caller falls back to the
 * theme's foreground value.
 */
export function pickReadableForeground(bg: string | undefined): '#ffffff' | '#000000' | undefined {
  const rgb = parseColorToRgb(bg);
  if (!rgb) return undefined;
  const lum = relativeLuminance(rgb);
  // 0.179 is the WCAG-correct flip point — the luminance value where contrast
  // against black and white is mathematically balanced (solving 20L²+2L-1=0).
  // For #FF6E00 (FWB brand orange, L≈0.324) this returns BLACK because black
  // gives 7.48:1 contrast (passes AA easily) while white gives 2.81:1 (fails AA).
  //
  // An earlier draft used 0.35 to make the helper return white-on-orange
  // (matching the "Material on-color" pattern). That was wrong: it would ship
  // white text that fails AA on the brand orange, which is the exact "unreadable
  // text" bug this helper exists to prevent. If a merchant wants white on their
  // brand color anyway, they pick it explicitly and the ColorContrastPreview
  // warning surfaces the failing ratio so they can decide deliberately.
  return lum > 0.179 ? '#000000' : '#ffffff';
}

// Task 6: contrastRatio

/**
 * WCAG contrast ratio between two colors. Returns 1.0 to 21.0.
 *   - AA normal text: ≥ 4.5
 *   - AA large text:  ≥ 3.0
 *   - AAA normal:     ≥ 7.0
 *
 * Returns 1.0 (worst case) when either input is unparseable so the caller
 * always gets a safe number to compare against thresholds.
 */
export function contrastRatio(bg: string, fg: string): number {
  const bgRgb = parseColorToRgb(bg);
  const fgRgb = parseColorToRgb(fg);
  if (!bgRgb || !fgRgb) return 1;
  const bgLum = relativeLuminance(bgRgb);
  const fgLum = relativeLuminance(fgRgb);
  const brighter = Math.max(bgLum, fgLum);
  const darker = Math.min(bgLum, fgLum);
  return (brighter + 0.05) / (darker + 0.05);
}

// Task 15d: lightenColor / darkenColor / rgbToHex / generateSectionPalette
import type { CardFrameWidth } from '../types/store-layout';

/** Convert an Rgb object to an uppercase hex string (#RRGGBB). */
function rgbToHex(rgb: Rgb): string {
  const toHex = (c: number) => c.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Mix a color toward white by `amount` (0..1). For `'#FF6E00'` + 0.4 returns a
 * lighter orange suitable for tinted section backgrounds. Token refs pass
 * through unchanged so the caller can resolve at render time.
 */
export function lightenColor(input: string, amount: number): string {
  if (input.startsWith('token:')) return input;
  const rgb = parseColorToRgb(input);
  if (!rgb) return input;
  const t = Math.max(0, Math.min(1, amount));
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return rgbToHex({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) });
}

/**
 * Mix a color toward black by `amount` (0..1). For `'#FF6E00'` + 0.4 returns a
 * darker shade suitable for hover states / framed sections.
 */
export function darkenColor(input: string, amount: number): string {
  if (input.startsWith('token:')) return input;
  const rgb = parseColorToRgb(input);
  if (!rgb) return input;
  const t = Math.max(0, Math.min(1, amount));
  const mix = (c: number) => Math.round(c * (1 - t));
  return rgbToHex({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) });
}

export type PalettePattern = 'alternating' | 'monochrome' | 'triad' | 'single-bg';

export interface PaletteSeeds {
  primary: ColorValue;
  accent?: ColorValue;
  neutral?: ColorValue;
  pattern?: PalettePattern;
  overrides?: Partial<Record<SectionKey, Partial<SectionPaletteEntry>>>;
  cardFrameWidth?: CardFrameWidth;
}

export interface SectionPaletteEntry {
  bgColor: ColorValue;
  cardFrameColor: ColorValue;
  /** Default border width applied to card frames in this section. */
  cardFrameWidth: CardFrameWidth;
  /**
   * Heading text color. Returns `'auto'` when the bg is a token ref — caller
   * must resolve the token at render time and call `pickReadableForeground`
   * then. Returns a concrete hex when the bg is a concrete hex.
   */
  headingColor: string;
}

export type SectionKey = 'hero' | 'categories' | 'newArrivals' | 'bestSellers' | 'testimonials';

const SECTION_ORDER: SectionKey[] = [
  'hero',
  'categories',
  'newArrivals',
  'bestSellers',
  'testimonials',
];

/**
 * Distribute 1–3 seed colors across the 5 storefront section settings as a
 * coherent palette. Supports four distribution patterns:
 *   - 'alternating' (default): primary / neutral / accent / neutral / primary
 *   - 'monochrome': primary everywhere
 *   - 'triad': primary / neutral / accent / primary / neutral
 *   - 'single-bg': neutral everywhere
 *
 * Card frame is the primary seed everywhere for brand consistency.
 * Heading color auto-fixes per section bg via WCAG luminance.
 * Token-ref seeds pass through unchanged so the caller can resolve at render.
 *
 * Optional `overrides` map wins over pattern-derived defaults on a per-section
 * per-field basis. Optional `cardFrameWidth` sets the border width for every
 * section (default 'normal').
 */
export function generateSectionPalette(
  seeds: PaletteSeeds
): Record<SectionKey, SectionPaletteEntry> {
  const {
    primary,
    accent,
    neutral,
    pattern = 'alternating',
    overrides,
    cardFrameWidth = 'normal',
  } = seeds;
  const neutralBg = neutral ?? '#FFFFFF';

  // Accent fallback: if pattern needs an accent slot but none is provided,
  // use a lightened version of primary (or white if primary is a token ref).
  const accentBg =
    accent ??
    lightenColor(
      typeof primary === 'string' && primary.startsWith('token:') ? '#FFFFFF' : primary,
      0.6
    );

  // Background distribution by pattern.
  // | pattern      | hero    | categories | newArrivals | bestSellers | testimonials |
  // |--------------|---------|------------|-------------|-------------|--------------|
  // | alternating  | primary | neutral    | accent      | neutral     | primary      |
  // | monochrome   | primary | primary    | primary     | primary     | primary      |
  // | triad        | primary | neutral    | accent      | primary     | neutral      |
  // | single-bg    | neutral | neutral    | neutral     | neutral     | neutral      |
  let slots: Record<SectionKey, ColorValue>;
  switch (pattern) {
    case 'monochrome':
      slots = {
        hero: primary,
        categories: primary,
        newArrivals: primary,
        bestSellers: primary,
        testimonials: primary,
      };
      break;
    case 'triad':
      slots = {
        hero: primary,
        categories: neutralBg,
        newArrivals: accentBg,
        bestSellers: primary,
        testimonials: neutralBg,
      };
      break;
    case 'single-bg':
      slots = {
        hero: neutralBg,
        categories: neutralBg,
        newArrivals: neutralBg,
        bestSellers: neutralBg,
        testimonials: neutralBg,
      };
      break;
    case 'alternating':
    default:
      slots = {
        hero: primary,
        categories: neutralBg,
        newArrivals: accentBg,
        bestSellers: neutralBg,
        testimonials: primary,
      };
  }

  const headingFor = (bg: ColorValue): string => {
    if (bg.startsWith('token:')) return 'auto';
    return pickReadableForeground(bg) ?? '#000000';
  };

  const base = SECTION_ORDER.reduce(
    (acc, key) => {
      acc[key] = {
        bgColor: slots[key],
        cardFrameColor: primary,
        cardFrameWidth,
        headingColor: headingFor(slots[key]),
      };
      return acc;
    },
    {} as Record<SectionKey, SectionPaletteEntry>
  );

  // Apply per-section overrides on top of pattern-derived defaults.
  if (overrides) {
    for (const key of SECTION_ORDER) {
      const ovr = overrides[key];
      if (!ovr) continue;
      const merged: SectionPaletteEntry = { ...base[key], ...ovr };
      // Re-compute headingColor when bgColor override changes the bg, unless
      // headingColor is also explicitly overridden.
      if (ovr.bgColor !== undefined && ovr.headingColor === undefined) {
        merged.headingColor = headingFor(ovr.bgColor);
      }
      base[key] = merged;
    }
  }

  return base;
}
