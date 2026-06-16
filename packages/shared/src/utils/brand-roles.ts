import type { StoreTheme } from '../types/store-theme';
import { resolveColor, pickReadableForeground } from './color';

// Roles whose foreground must stay legible against their own surface color.
// Each entry: [colorVar, colorField, foregroundVar, foregroundField].
const PAIRS: ReadonlyArray<[string, keyof StoreTheme, string, keyof StoreTheme]> = [
  ['--primary', 'primaryColor', '--primary-foreground', 'primaryForeground'],
  ['--secondary', 'secondaryColor', '--secondary-foreground', 'secondaryForeground'],
  ['--accent', 'accentColor', '--accent-foreground', 'accentForeground'],
  ['--card', 'cardColor', '--card-foreground', 'cardForeground'],
];

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
 * Build the storefront CSS-var map for a theme's brand color pairs.
 *
 * Foreground resolution rules (per 2026-06-16 decision to honor merchant
 * intent for the Branding color editor):
 *   1. If the theme explicitly stores a foreground value for the pair,
 *      pass it through VERBATIM — the merchant chose it deliberately in the
 *      Branding color editor and we must not override it.
 *   2. Only auto-compute a WCAG-safe foreground when the key is absent/empty.
 *
 * This means a merchant CAN save a low-contrast foreground — the ColorField's
 * contrast preview will warn them, but deriveBrandRoles no longer overrides.
 * Auto-fill only applies to stores that never set foregrounds explicitly
 * (e.g. stores created before the Branding color editor shipped).
 */
export function deriveBrandRoles(theme: StoreTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [colorVar, colorField, fgVar, fgField] of PAIRS) {
    const color = theme[colorField] as string | undefined;
    if (color) out[colorVar] = color;

    const stored = theme[fgField] as string | undefined;

    if (stored) {
      // Merchant explicitly set this foreground — honor it verbatim.
      out[fgVar] = stored;
    } else {
      // No foreground set — auto-derive a WCAG-safe value from the surface.
      const token = (colorField as string).replace('Color', '');
      const surface = resolveColor(`token:${token}`, theme) ?? toCss(color);
      const auto = toTriple(pickReadableForeground(surface)) ?? '0 0% 0%';
      out[fgVar] = auto;
    }
  }
  return out;
}
