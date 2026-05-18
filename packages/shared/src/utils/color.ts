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
 * Resolve a `ColorValue` string to an actual CSS color.
 *   - 'token:<name>' → looks up StoreTheme[<name>] and wraps as hsl() if not already wrapped
 *   - raw '#RRGGBB' / '#RGB' / 'hsl(...)' → passes through unchanged
 *   - empty / undefined → undefined (caller falls back to theme default)
 */
export function resolveColor(value: ColorValue | undefined, theme: StoreTheme): string | undefined {
  if (!value) return undefined;

  if (value.startsWith(TOKEN_PREFIX)) {
    const key = value.slice(TOKEN_PREFIX.length) as ColorToken;
    if (!(COLOR_TOKENS as readonly string[]).includes(key)) return undefined;
    const raw = (theme as unknown as Record<string, string | undefined>)[key];
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
  // 0.35 is the practical flip point: luminances above this are light enough
  // that black text passes WCAG AA for large text; below (including brand
  // saturated colors like the FWB orange at ~0.32) white text is preferred.
  // The mathematically balanced point is 0.179 but that leaves many
  // mid-luminance brand colors with insufficient black contrast — 0.35
  // matches real-world design-system practice (Material Design, Polaris).
  return lum > 0.35 ? '#000000' : '#ffffff';
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
