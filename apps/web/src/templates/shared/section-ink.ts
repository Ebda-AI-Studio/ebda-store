import type { CSSProperties } from 'react';
import { contrastRatio, parseColorToRgb, rgbToHslTriplet, statusInkVars } from '@ebda/shared';
import type { StoreTheme } from '@ebda/shared';
import { parseBgStops } from './footer-ink';

/**
 * Section tone contract (storefront audit 2026-11-03 #1, Ruling PREMIUM-1).
 *
 * A merchant may paint any section with any colour. Every component inside it reads the THEME
 * tokens (text-foreground, text-muted-foreground, bg-card, border-input ...), which are only
 * guaranteed readable on the page ground. So when a painted band does not carry the page ink at
 * AA, the band re-scopes those tokens to an ink derived from the band's OWN paint: body text
 * 4.5:1, muted text 4.5:1, prices/primary 4.5:1, on every stop of a gradient. Same pattern as
 * `resolveFooterInk` (footer) and `inverseBandStyle` (look inverse band), generalised to every
 * section type and every look/template, because all of them paint through `sectionBgStyle`.
 *
 * A band that already carries the page ink is left untouched (merchant intent, zero change).
 */

type Rgb = { r: number; g: number; b: number };

export const SECTION_AA_TEXT = 4.5;
export const SECTION_AA_LARGE = 3;

const hex = (c: Rgb) =>
  '#' +
  [c.r, c.g, c.b]
    .map(v =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('');

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r * t + b.r * (1 - t),
  g: a.g * t + b.g * (1 - t),
  b: a.b * t + b.b * (1 - t),
});

const trip = (c: Rgb) => rgbToHslTriplet(c);

function worstOn(stops: Rgb[], ink: Rgb): number {
  return Math.min(...stops.map(s => contrastRatio(hex(s), hex(ink))));
}

/**
 * Token overrides for a band painted `resolvedBg`, or undefined when the theme's own ink
 * already reads on it (>= 4.5:1 for body AND muted text on every stop).
 */
export function sectionInkVars(
  resolvedBg: string | undefined,
  theme: StoreTheme
): CSSProperties | undefined {
  const stops = parseBgStops(resolvedBg);
  if (stops.length === 0) return undefined;
  const fg = parseColorToRgb(theme.foregroundColor);
  const muted = parseColorToRgb(theme.mutedForeground);
  const primary = parseColorToRgb(theme.primaryColor);
  const fgOk = !!fg && worstOn(stops, fg) >= SECTION_AA_TEXT;
  const mutedOk = !muted || worstOn(stops, muted) >= SECTION_AA_TEXT;
  if (fgOk && mutedOk) {
    // Body + muted read. Prices/links in the brand colour may still not (navy brand on a
    // mid-tone band): swap only the primary pair, nothing else moves.
    if (primary && worstOn(stops, primary) < SECTION_AA_TEXT) return primaryPairVars(stops, theme);
    return undefined;
  }

  // The anchor = the stop the ink sits worst on; cards and fields blend into it.
  const candidates: Rgb[] = [
    parseColorToRgb(theme.backgroundColor),
    fg,
    { r: 255, g: 255, b: 255 },
    { r: 0, g: 0, b: 0 },
  ].filter((c): c is Rgb => !!c);
  let ink = candidates.find(c => worstOn(stops, c) >= SECTION_AA_TEXT);
  if (!ink) {
    // Mid-tone band nothing passes on: take whichever pure end is best (black or white).
    ink =
      worstOn(stops, candidates[candidates.length - 2]) >=
      worstOn(stops, candidates[candidates.length - 1])
        ? candidates[candidates.length - 2]
        : candidates[candidates.length - 1];
  }
  const anchor = stops.reduce((a, s) =>
    contrastRatio(hex(s), hex(ink!)) < contrastRatio(hex(a), hex(ink!)) ? s : a
  );
  let mutedInk = ink;
  for (const alpha of [0.78, 0.86, 0.94, 1]) {
    const m = mix(ink, anchor, alpha);
    if (worstOn(stops, m) >= SECTION_AA_TEXT) {
      mutedInk = m;
      break;
    }
  }
  const ground = trip(anchor);
  const inkT = trip(ink);
  const hairline = trip(mix(ink, anchor, 0.28));
  return {
    color: `hsl(${inkT})`,
    '--foreground': inkT,
    '--card': ground,
    '--card-foreground': inkT,
    '--popover': ground,
    '--popover-foreground': inkT,
    '--muted': ground,
    '--muted-foreground': trip(mutedInk),
    '--secondary': ground,
    '--secondary-foreground': inkT,
    '--border': hairline,
    '--input': hairline,
    '--primary': inkT,
    '--primary-foreground': ground,
    '--accent': inkT,
    '--accent-foreground': ground,
    '--ring': inkT,
    ...statusInkVars(
      {
        success: theme.successColor,
        warning: theme.warningColor,
        destructive: theme.destructiveColor,
      },
      stops.map(s => trip(s)),
      theme.legacyBannerContrast === true
    ),
  } as CSSProperties;
}

function primaryPairVars(stops: Rgb[], theme: StoreTheme): CSSProperties | undefined {
  const fg = parseColorToRgb(theme.foregroundColor);
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  const pick = [fg, white, black].find(c => c && worstOn(stops, c) >= SECTION_AA_TEXT);
  if (!pick) return undefined;
  const anchor = stops.reduce((a, s) =>
    contrastRatio(hex(s), hex(pick)) < contrastRatio(hex(a), hex(pick)) ? s : a
  );
  return {
    '--primary': trip(pick),
    '--primary-foreground': trip(anchor),
    '--accent': trip(pick),
    '--accent-foreground': trip(anchor),
  } as CSSProperties;
}
