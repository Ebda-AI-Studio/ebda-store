import type { CSSProperties } from 'react';
import {
  INVERSE_SURFACE,
  colorToHslTriplet,
  getLook,
  pickReadableForeground,
  resolveColor,
} from '@ebda/shared';
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
    // Inherited text (an h1 with no colour class) reads the band, not the page (W2b).
    color: `hsl(${page})`,
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
    // A light look primary (Lookbook moon silver) is unreadable as TEXT on the band (1.2:1):
    // primary takes the band's ink pair, so `text-primary` prices and `bg-primary` fills both read.
    // The accent (chips) takes the same pair for the same reason (B1-102).
    '--primary': page,
    '--primary-foreground': ink,
    '--accent': page,
    '--accent-foreground': ink,
    '--ring': page,
    '--bg-page': ink,
  } as CSSProperties;
}

/**
 * Quality bar § 9 rule 1 (W2a fix round 1, I-3): a LOOK whose page is dark (Lookbook) shows
 * merchant product photos (white grounds) on the inverse band, on listing pages too, not only in
 * its home mix. Undefined (no change) for a store with no look, a light look, or when the
 * merchant set their own page colour (`hasMerchantBg`: merchant > look).
 */
export function darkLookListingBand(
  theme: StoreTheme | undefined,
  lookId: string | null | undefined,
  hasMerchantBg: boolean
): CSSProperties | undefined {
  if (hasMerchantBg || !theme || !getLook(lookId) || !theme.backgroundColor) return undefined;
  const page = theme.backgroundColor.trim();
  const css = /^\d/.test(page) ? `hsl(${page})` : page;
  if (pickReadableForeground(css) !== '#ffffff') return undefined;
  return inverseBandStyle(theme);
}
