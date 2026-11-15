/**
 * Measuring colour honestly (Ruling EPUX-2, plan finding F4/F18).
 *
 * `resolveColor` can hand back a CSS-variable reference (`hsl(var(--primary))`) when a legacy theme row lacks the
 * `<token>Color` field. That string has no RGB, so `contrastRatio` answered `1` and `pickReadableForeground`
 * answered nothing: the editor then reported a "1.0 : 1 fail" for a colour nobody measured. These helpers resolve a
 * token through the theme, then through the template defaults, and answer `null` when there is still no real colour:
 * a caller shows "can't check yet" and never a made-up number. `contrastRatio` itself is unchanged (storefront code
 * relies on its safe worst-case number).
 */
import { DEFAULT_THEME } from '../types/store-theme';
import type { StoreTheme } from '../types/store-theme';
import { contrastRatio, parseColorToRgb, resolveColor } from './color';

/** A parseable colour for `value` (hex, hsl, bare triplet or `token:*`), or null when none can be found. */
export function resolveColorForMeasure(
  value: string | undefined,
  theme: StoreTheme | undefined
): string | null {
  if (!value) return null;
  const own = resolveColor(value, theme ?? DEFAULT_THEME);
  if (own && parseColorToRgb(own)) return own;
  // A token the theme does not carry (legacy rows): the template's own default for it.
  const base = resolveColor(value, DEFAULT_THEME);
  return base && parseColorToRgb(base) ? base : null;
}

/** WCAG contrast of two colours, or null when either is not a real colour (never a fake 1.0). */
export function contrastRatioOrNull(a: string | undefined, b: string | undefined): number | null {
  if (!parseColorToRgb(a) || !parseColorToRgb(b)) return null;
  return contrastRatio(a as string, b as string);
}

export type ReadVerdict = 'easy' | 'large' | 'hard';

/** AA normal text 4.5, AA large text 3. */
export function readVerdict(ratio: number): ReadVerdict {
  return ratio >= 4.5 ? 'easy' : ratio >= 3 ? 'large' : 'hard';
}
