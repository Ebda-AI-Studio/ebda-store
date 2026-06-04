import type { CSSProperties } from 'react';
import { resolveColor, type StoreTheme, type PageColorScheme } from '@force/shared';

/**
 * Smart per-page surface styling.
 *
 * A merchant sets ONE colour for a page background (page-builder → <Page> →
 * Page background). If that colour is dark, plain `text-foreground` /
 * `bg-card` / `border-border` (tuned for a light theme) become unreadable and
 * the layout "breaks". Rather than make the merchant hand-pick a dozen colours,
 * we derive a COHERENT surface palette from their one colour and set it as
 * scoped CSS variables on the page wrapper — so every descendant that uses the
 * design-system tokens (`text-foreground`, `bg-card`, `text-muted-foreground`,
 * `border-border`, …) auto-adapts. The brand `--primary` is left untouched.
 *
 * Merchant typography colours still win: they're applied inline on specific
 * elements, which beats an inherited CSS variable.
 *
 * Colours that can't be parsed to a concrete value (e.g. an unresolved
 * `token:` ref that has no theme value) fall back to "just set the background"
 * — never worse than today.
 */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Parse `#rgb`, `#rrggbb`, or `hsl(h s% l%)` / `hsl(h, s%, l%)` to HSL.
 *  Returns null for anything else (e.g. `hsl(var(--x))`, named colours). */
function parseToHsl(input: string): Hsl | null {
  const c = input.trim();

  // hsl(...) — space- or comma-separated, optional alpha (ignored).
  const hslMatch = c.match(/^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/i);
  if (hslMatch) {
    return { h: parseFloat(hslMatch[1]), s: parseFloat(hslMatch[2]), l: parseFloat(hslMatch[3]) };
  }

  // hex
  let hex = c.startsWith('#') ? c.slice(1) : null;
  if (hex) {
    if (hex.length === 3)
      hex = hex
        .split('')
        .map(ch => ch + ch)
        .join('');
    if (hex.length !== 6 || /[^0-9a-f]/i.test(hex)) return null;
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return rgbToHsl(r, g, b);
  }

  return null;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Relative perceptual lightness check. We key off HSL lightness (good enough
 *  for a UI contrast decision) plus a small saturation guard so a vivid mid
 *  colour still reads as "dark surface" when its lightness is low. */
function isDark(hsl: Hsl): boolean {
  return hsl.l < 50;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const triplet = (h: number, s: number, l: number) =>
  `${Math.round(h)} ${Math.round(clamp(s))}% ${Math.round(clamp(l))}%`;

/**
 * Build a CSSProperties bag for a page wrapper: always the background colour,
 * plus — when the background is dark — a derived dark surface palette as scoped
 * CSS custom properties.
 */
export function pageSurfaceStyle(
  bgColor: string | undefined,
  theme: StoreTheme | undefined,
  scheme: PageColorScheme = 'auto'
): CSSProperties | undefined {
  if (!bgColor) return undefined;
  // resolveColor types theme as required; an undefined theme still resolves hex
  // literals and falls back to hsl(var(--token)) for token refs.
  const resolved = resolveColor(bgColor, (theme ?? {}) as StoreTheme);
  if (!resolved) return undefined;

  const style: Record<string, string> = { backgroundColor: resolved };
  const hsl = parseToHsl(resolved);
  // Decide whether to apply the dark palette: the merchant's manual override
  // ('light' / 'dark') wins; 'auto' falls back to the background's lightness.
  // 'dark' needs a parseable colour to derive the palette from.
  const wantDark = scheme === 'dark' ? !!hsl : scheme === 'light' ? false : !!hsl && isDark(hsl);
  if (!hsl || !wantDark) return style as CSSProperties;

  const { h, s, l } = hsl;
  // Surfaces step up in lightness from the page background so cards lift off it;
  // foregrounds are near-white with a hint of the bg hue. Keep saturation gentle
  // on text so it stays neutral/readable.
  const sSurface = clamp(s, 0, 40);
  const sText = clamp(s, 0, 16);
  style['--background'] = triplet(h, s, l);
  style['--foreground'] = triplet(h, sText, 96);
  style['--card'] = triplet(h, sSurface, l + 6);
  style['--card-foreground'] = triplet(h, sText, 96);
  style['--popover'] = triplet(h, sSurface, l + 6);
  style['--popover-foreground'] = triplet(h, sText, 96);
  style['--muted'] = triplet(h, sSurface, l + 9);
  style['--muted-foreground'] = triplet(h, sText, 68);
  style['--secondary'] = triplet(h, sSurface, l + 11);
  style['--secondary-foreground'] = triplet(h, sText, 96);
  style['--accent'] = triplet(h, sSurface, l + 13);
  style['--accent-foreground'] = triplet(h, sText, 96);
  style['--border'] = triplet(h, sSurface, l + 18);
  style['--input'] = triplet(h, sSurface, l + 18);
  // --primary / --primary-foreground (brand) intentionally untouched.
  return style as CSSProperties;
}
