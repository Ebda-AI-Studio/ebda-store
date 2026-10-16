import type { StoreTheme } from '../types/store-theme';
import { resolveColor, pickReadableForeground, contrastRatio } from './color';

// Roles whose foreground must stay legible against their own surface color.
// Each entry: [colorVar, colorField, foregroundVar, foregroundField].
const PAIRS: ReadonlyArray<[string, keyof StoreTheme, string, keyof StoreTheme]> = [
  ['--primary', 'primaryColor', '--primary-foreground', 'primaryForeground'],
  ['--secondary', 'secondaryColor', '--secondary-foreground', 'secondaryForeground'],
  ['--accent', 'accentColor', '--accent-foreground', 'accentForeground'],
  ['--card', 'cardColor', '--card-foreground', 'cardForeground'],
];

// 2:1 floor matches the storefront SectionHeading guard (2026-06-05): kills
// invisible text (white-on-white = 1:1) while keeping a deliberate brand pick.
const MIN_CONTRAST = 2;
/**
 * The primary fill carries every buy, checkout and selected-pill label (K-02),
 * so its ink must read at AA (4.5:1), not just "not invisible". A stored theme
 * cannot say whether its white was the merchant's pick or the template default
 * copied in at creation (white on the default orange is 2.79:1), so any stored
 * primary ink under AA yields to the luminance pick: black or white, whichever
 * reads — one of the two always clears 4.58:1. Ruling FU46-W1c-9.
 */
const MIN_CONTRAST_BY_FG: Partial<Record<string, number>> = { '--primary-foreground': 4.5 };

/** Convert pickReadableForeground's hex output to the bare `H S% L%` triple our CSS vars use. */
function toTriple(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v === '#ffffff' || v.toLowerCase() === '#fff') return '0 0% 100%';
  if (v === '#000000' || v.toLowerCase() === '#000') return '0 0% 0%';
  return v; // already a triple or a wrapped color the emitter handles
}

/** Wrap a bare `H S% L%` triple as hsl() so contrast/parse helpers accept it. */
function toCss(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.startsWith('hsl(') || v.startsWith('#') ? v : `hsl(${v})`;
}

/**
 * Build the storefront CSS-var map for a theme with GUARANTEED-readable
 * foregrounds. A stored foreground that reads fine against its surface is kept
 * verbatim (so configured stores — demo-shop — are unchanged). A missing or
 * unreadable foreground is replaced with pickReadableForeground(surface).
 */
export function deriveBrandRoles(theme: StoreTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [colorVar, colorField, fgVar, fgField] of PAIRS) {
    const color = theme[colorField] as string | undefined;
    if (color) out[colorVar] = color;

    const token = (colorField as string).replace('Color', '');
    const surface = resolveColor(`token:${token}`, theme) ?? toCss(color);
    const stored = theme[fgField] as string | undefined;
    const auto = toTriple(pickReadableForeground(surface)) ?? '0 0% 0%';

    if (!stored) {
      out[fgVar] = auto;
    } else {
      const storedCss = toCss(stored);
      out[fgVar] =
        surface &&
        storedCss &&
        contrastRatio(surface, storedCss) >= (MIN_CONTRAST_BY_FG[fgVar] ?? MIN_CONTRAST)
          ? stored
          : auto;
    }
  }
  return out;
}
