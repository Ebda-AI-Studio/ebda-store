import type { CSSProperties } from 'react';
import { INVERSE_SURFACE, colorToHslTriplet, resolveColor } from '@ebda/shared';
import type { StoreTheme } from '@ebda/shared';

/**
 * Per-section style — paints the merchant's explicit bg override only.
 * No runtime contrast auto-fix; ColorField in admin owns pick-time
 * feedback. Render merchant intent verbatim.
 *
 * One exception, set only by a look's mix: `token:inverse` (W2a, LB-01) paints the band in the
 * page ink and swaps the ink variables inside it (text = the page colour, fields = the page
 * colour, hairlines = the muted ink), so every shared component in the band (cards, prices,
 * headings, the wishlist disc) reads on it without knowing it is there.
 */
export function sectionBgStyle(
  bgColor: string | undefined,
  theme: StoreTheme
): CSSProperties | undefined {
  if (bgColor === INVERSE_SURFACE) return inverseBandStyle(theme);
  const resolvedBg = resolveColor(bgColor, theme);
  if (!resolvedBg) return undefined;
  return { backgroundColor: resolvedBg };
}

function inverseBandStyle(theme: StoreTheme): CSSProperties | undefined {
  // Theme colours are bare HSL triplets already (composeStoreTheme); flatten anything else.
  const triplet = (v: string | undefined) =>
    v && /^\d/.test(v.trim()) ? v.trim() : colorToHslTriplet(v, theme);
  const ink = triplet(theme.foregroundColor);
  const page = triplet(theme.backgroundColor);
  if (!ink || !page) return undefined;
  const hairline = triplet(theme.mutedForeground) || page;
  return {
    backgroundColor: `hsl(${ink})`,
    '--background': ink,
    '--foreground': page,
    '--card': ink,
    '--card-foreground': page,
    '--popover': ink,
    '--popover-foreground': page,
    '--muted': ink,
    '--muted-foreground': page,
    '--secondary': ink,
    '--secondary-foreground': page,
    '--border': hairline,
    '--input': page,
    '--bg-page': ink,
  } as CSSProperties;
}
