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
    if (raw) {
      return raw.startsWith('hsl(') || raw.startsWith('#') ? raw : `hsl(${raw})`;
    }
    // Theme is missing the matching `<key>Color` field (e.g. legacy stores
    // saved before card/muted/border/foreground tokens were added to the
    // theme). Fall back to the global CSS variable — globals.css defines
    // --card, --muted, --border, --foreground, --primary, --secondary,
    // --accent for every store, so the merchant's token choice still
    // resolves to a real color instead of silently dropping.
    //
    // Verified FWB 2026-05-20 — wadyaljuz picked `token:card` for the
    // footer color zone but had no `cardColor` on the theme row; old code
    // returned undefined here, callers fell back to default → merchant
    // intent was silently lost across 14 cardFrameColor sites + the
    // ShopChrome announcement/header/footer bgColor sites.
    return `hsl(var(--${key}))`;
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

// Footer logo auto-contrast helper

/**
 * Returns the CSS filter string that makes a brand-logo fallback contrast-safe
 * against the footer background.
 *
 * Priority:
 *   explicitInvert === true  → force white logo  (brightness(0) invert(1))
 *   explicitInvert === false → keep original color (none)
 *   undefined (AUTO)         → dark bg → white logo; light bg → keep as-is
 *
 * AUTO deliberately NEVER crushes a logo to black. A `brightness(0)` filter
 * destroys all colour and turned every full-colour brand logo into a black
 * silhouette on the default (white) footer. On a light background a colour
 * logo is already readable, so we leave it untouched; we only force WHITE on a
 * genuinely dark footer (where a colour/dark logo would vanish). Merchants who
 * want a forced-mono logo can still opt in via the explicit invert toggle or by
 * uploading a dedicated `footerLogo`.
 *
 * Only call this for the BRAND-LOGO FALLBACK path — a custom uploaded
 * `footerLogo` is assumed correct and must never be filtered.
 *
 * The `footerBg` parameter should be the RESOLVED footer background color
 * (hex or hsl string) — pass the merchant's override when set, otherwise
 * the theme's `--bg-section-alt` HSL triplet. When the bg is unresolvable
 * (e.g. a CSS var reference) the function returns 'none' so the logo stays
 * as-is rather than silently turning black.
 */
export function footerLogoContrastFilter(
  footerBg: string | undefined,
  explicitInvert?: boolean
): string {
  // Explicit merchant choice always wins over auto-contrast.
  if (explicitInvert === true) return 'brightness(0) invert(1)';
  if (explicitInvert === false) return 'none';
  // AUTO path: derive optimal logo color from bg luminance.
  const readable = pickReadableForeground(footerBg); // '#ffffff' | '#000000' | undefined
  if (readable === '#ffffff') return 'brightness(0) invert(1)'; // dark bg → force white logo
  // light bg ('#000000' readable) OR unparseable → leave the logo as-is.
  // Never apply brightness(0): it would crush a colour logo to a black blob.
  return 'none';
}

// Task 15d: lightenColor / darkenColor / rgbToHex / generateSectionPalette
import type { CardFrameSize, CardFrameWidth } from '../types/store-layout';

/** Convert an Rgb object to an uppercase hex string (#RRGGBB). */
function rgbToHex(rgb: Rgb): string {
  const toHex = (c: number) => c.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Resolve a ColorValue (hex or token ref) to a concrete hex, then mix toward
 * white (mix > 0) or black (mix < 0). Used by `generateSectionPalette` to
 * compute shaded variants when the input is a token ref.
 *
 * When `theme` is undefined OR the token doesn't resolve, falls back to the
 * raw input (preserves the original behavior of returning the token ref
 * unchanged, so the caller can resolve at render).
 */
function resolveAndMix(value: ColorValue, theme: StoreTheme | undefined, mix: number): ColorValue {
  if (mix === 0) return value;
  let resolved: ColorValue = value;
  if (value.startsWith('token:') && theme) {
    const r = resolveColor(value, theme);
    if (r) resolved = r;
  }
  // If the resolved value is still a token ref (no theme or bad token), return as-is.
  if (resolved.startsWith('token:')) return value;
  // Resolved is hsl() or hex — try to lighten/darken via the parser.
  const rgb = parseColorToRgb(resolved);
  if (!rgb) return value;
  const t = Math.max(0, Math.min(1, Math.abs(mix)));
  const blend =
    mix > 0
      ? (c: number) => Math.round(c + (255 - c) * t) // lighten
      : (c: number) => Math.round(c * (1 - t)); // darken
  return rgbToHex({ r: blend(rgb.r), g: blend(rgb.g), b: blend(rgb.b) });
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

// ─── Core brand token derivation (Task 3: Smart Palette fills all tokens) ───

export interface CoreBrandTokens {
  /** HSL triplets (e.g. '26 100% 50%') matching StoreTheme field names. */
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
  cardColor: string;
  mutedColor: string;
  borderColor: string;
  primaryForeground: string;
  secondaryForeground: string;
  accentForeground: string;
  cardForeground: string;
  /** Near-white page background derived from the palette hue. */
  bgPage: string;
  /** Subtly deeper tint used by alternating sections. */
  bgSectionAlt: string;
}

/** Convert a hex color to the bare 'H S% L%' triplet used by StoreTheme. */
function hexToTriple(hex: string): string {
  const rgb = parseColorToRgb(hex);
  if (!rgb) return '0 0% 50%'; // safe fallback
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return `0 0% ${Math.round(l * 100)}%`;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** Auto foreground for a hex bg — returns bare HSL triplet string. */
function autoFgTriplet(bgHex: string): string {
  const pick = pickReadableForeground(bgHex);
  if (pick === '#ffffff') return '0 0% 100%';
  return '0 0% 0%';
}

/**
 * Derive all core brand token HSL triplets from primary + secondary seeds.
 *
 * `primary`   — the brand's dominant color (required, raw hex).
 * `secondary` — the complementary/secondary brand color (raw hex). When
 *               provided, accent is blended from both; otherwise it falls
 *               back to the legacy `accent`/`neutral` parameters so
 *               SmartPaletteModal (which passes `{primary, accent, neutral}`)
 *               continues to compile and work unchanged.
 * `accent`    — legacy parameter (SmartPaletteModal back-compat). Ignored
 *               when `secondary` is set.
 * `neutral`   — legacy parameter (SmartPaletteModal back-compat). Ignored
 *               when `secondary` is set.
 *
 * Returns a full StoreTheme-compatible object including `bgPage` and
 * `bgSectionAlt` — two near-white page background HSL triplets distinct
 * enough to read as alternating sections (bgPage L≈98%, bgSectionAlt L≈94%).
 *
 * Callers should merge the result into the existing theme (shallow-merge PUT)
 * so only the changed keys are sent to the server.
 */
export function deriveCoreBrandTokens(seeds: {
  primary: string;
  secondary?: string;
  accent?: string;
  neutral?: string;
}): CoreBrandTokens {
  const { primary, secondary, accent, neutral } = seeds;

  const isNewMode = !!(secondary && secondary !== '');

  // ── Shared helper: extract H+S from a hex color ─────────────────────────
  function hslPartsFromHex(hex: string): { h: number; s: number; l: number } | null {
    const rgb = parseColorToRgb(hex);
    if (!rgb) return null;
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  if (isNewMode) {
    // ── New mode: seed from primary + secondary ──────────────────────────
    const secondaryHex = secondary!;

    // Accent: blend the hue of primary and secondary shifted by ~30°.
    // This produces a pleasing triadic-adjacent tone without being garish.
    const pParts = hslPartsFromHex(primary);
    const sParts = hslPartsFromHex(secondaryHex);
    let accentHex: string;
    if (pParts && sParts) {
      // Mid-hue between primary and secondary, shifted 30° toward the shorter arc.
      // Saturation = average of both, lightness = 55% for a vivid but not harsh accent.
      const midH = (pParts.h + sParts.h) / 2;
      const accentH = (midH + 30) % 360;
      const accentS = Math.min(90, (pParts.s + sParts.s) / 2 + 10);
      const accentL = 52;
      // Build a hex from the HSL values to reuse hexToTriple.
      const accentRgb = hslToRgb(accentH, accentS, accentL);
      const toHex = (c: number) => c.toString(16).padStart(2, '0');
      accentHex = `#${toHex(accentRgb.r)}${toHex(accentRgb.g)}${toHex(accentRgb.b)}`;
    } else {
      accentHex = lightenColor(primary, 0.5);
    }

    // Page backgrounds: derive hue/sat from primary at very high lightness.
    // Both are LIGHT, distinct enough to read as alternating sections.
    const bgTriplet = (l: number): string => {
      if (pParts) {
        const cappedS = Math.min(20, pParts.s * 0.15);
        return `${Math.round(pParts.h)} ${Math.round(cappedS)}% ${l}%`;
      }
      return `0 0% ${l}%`;
    };
    const bgPage = bgTriplet(98); // near-white tint
    const bgSectionAlt = bgTriplet(94); // subtly deeper tint

    // Card: very light secondary tint.
    const cardHex = lightenColor(secondaryHex, 0.88);

    // Muted: very light primary tint.
    const mutedHex = lightenColor(primary, 0.88);

    // Border: light tint of secondary.
    const borderHex = lightenColor(secondaryHex, 0.78);

    // Background / foreground: white page, dark text.
    const backgroundHex = '#FFFFFF';
    const foregroundTriplet = '224 71% 4%';

    return {
      primaryColor: hexToTriple(primary),
      secondaryColor: hexToTriple(secondaryHex),
      accentColor: hexToTriple(accentHex),
      backgroundColor: hexToTriple(backgroundHex),
      foregroundColor: foregroundTriplet,
      cardColor: hexToTriple(cardHex),
      mutedColor: hexToTriple(mutedHex),
      borderColor: hexToTriple(borderHex),
      primaryForeground: autoFgTriplet(primary),
      secondaryForeground: autoFgTriplet(secondaryHex),
      accentForeground: autoFgTriplet(accentHex),
      cardForeground: foregroundTriplet,
      bgPage,
      bgSectionAlt,
    };
  }

  // ── Legacy mode: seed from primary + accent + neutral (SmartPaletteModal) ──
  const neutralHex = neutral && neutral !== '' ? neutral : '#FFFFFF';
  const accentHex = accent && accent !== '' ? accent : lightenColor(primary, 0.5);

  const secondaryHex = lightenColor(primary, 0.75);
  const backgroundHex = neutralHex === '#FFFFFF' ? '#FFFFFF' : lightenColor(neutralHex, 0.5);
  const foregroundHex = autoFgTriplet(backgroundHex) === '0 0% 100%' ? '#FFFFFF' : '#0A0A0A';
  const cardHex = lightenColor(neutralHex, 0.3);
  const mutedHex = lightenColor(primary, 0.88);
  const borderHex = lightenColor(neutralHex === '#FFFFFF' ? primary : neutralHex, 0.78);

  // Derive bgPage/bgSectionAlt from primary hue even in legacy mode.
  const pParts = hslPartsFromHex(primary);
  const bgTriplet = (l: number): string => {
    if (pParts) {
      const cappedS = Math.min(20, pParts.s * 0.15);
      return `${Math.round(pParts.h)} ${Math.round(cappedS)}% ${l}%`;
    }
    return `0 0% ${l}%`;
  };

  return {
    primaryColor: hexToTriple(primary),
    secondaryColor: hexToTriple(secondaryHex),
    accentColor: hexToTriple(accentHex),
    backgroundColor: hexToTriple(backgroundHex),
    foregroundColor: foregroundHex === '#FFFFFF' ? '0 0% 100%' : '224 71% 4%',
    cardColor: hexToTriple(cardHex),
    mutedColor: hexToTriple(mutedHex),
    borderColor: hexToTriple(borderHex),
    primaryForeground: autoFgTriplet(primary),
    secondaryForeground: autoFgTriplet(secondaryHex),
    accentForeground: autoFgTriplet(accentHex),
    cardForeground: foregroundHex === '#FFFFFF' ? '0 0% 100%' : '224 71% 4%',
    bgPage: bgTriplet(98),
    bgSectionAlt: bgTriplet(94),
  };
}

export type PalettePattern = 'alternating' | 'monochrome' | 'triad' | 'single-bg';

export interface PaletteSeeds {
  primary: ColorValue;
  accent?: ColorValue;
  neutral?: ColorValue;
  pattern?: PalettePattern;
  overrides?: Partial<Record<SectionKey, Partial<SectionPaletteEntry>>>;
  cardFrameWidth?: CardFrameWidth;
  cardFrameSize?: CardFrameSize;
}

export interface SectionPaletteEntry {
  bgColor: ColorValue;
  cardFrameColor: ColorValue;
  /** Default border width applied to card frames in this section. */
  cardFrameWidth: CardFrameWidth;
  /** Default frame box padding (breathing room between content and border) in this section. */
  cardFrameSize: CardFrameSize;
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
  seeds: PaletteSeeds,
  theme?: StoreTheme
): Record<SectionKey, SectionPaletteEntry> {
  const {
    primary,
    accent,
    neutral,
    pattern = 'alternating',
    overrides,
    cardFrameWidth = 'normal',
    cardFrameSize = 'normal',
  } = seeds;
  const neutralBg = neutral ?? '#FFFFFF';

  // Accent fallback: if pattern needs an accent slot but none is provided,
  // use a lightened version of primary — resolveAndMix handles token refs by
  // resolving them against the theme before blending.
  const accentBg = accent ?? resolveAndMix(primary, theme, 0.6);

  // Background distribution by pattern.
  // | pattern      | hero    | categories | newArrivals | bestSellers | testimonials |
  // |--------------|---------|------------|-------------|-------------|--------------|
  // | alternating  | primary | neutral    | accent      | neutral     | primary      |
  // | monochrome   | primary | lighter    | primary     | lighter     | darker       |
  // | triad        | primary | neutral    | accent      | primary     | neutral      |
  // | single-bg    | neutral | neutral    | neutral     | neutral     | neutral      |
  let slots: Record<SectionKey, ColorValue>;
  switch (pattern) {
    case 'monochrome':
      // monochrome uses one hue family with shaded variants — coherent palette
      // where each section is visually distinct via lightness, not different hues.
      // resolveAndMix resolves token refs before blending; when no theme is
      // available, token slots fall back to primary as-is (sections look
      // identical but no broken CSS).
      slots = {
        hero: primary, // stays token-referential or exact hex
        categories: resolveAndMix(primary, theme, 0.4), // lighter shade
        newArrivals: primary,
        bestSellers: resolveAndMix(primary, theme, 0.4), // same lighter shade
        testimonials: resolveAndMix(primary, theme, -0.15), // slightly darker
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
        cardFrameSize,
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
