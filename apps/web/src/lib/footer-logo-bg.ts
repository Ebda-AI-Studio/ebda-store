import type { StoreTheme, TemplateId } from '@ebda/shared';
import { colorToHslTriplet, resolveBackgroundPreset } from '@ebda/shared';

/**
 * Resolves the EFFECTIVE footer background color so `ShopChrome`'s
 * brand-logo auto-contrast filter (`footerLogoContrastFilter`) is computed
 * against whatever color the footer actually paints, not an assumption.
 *
 * Priority:
 *   1. merchant's explicit page-builder override (already-resolved hex/hsl)
 *   2. bold theme's `personaChromeV2` invert — `templates/bold/Footer.tsx`
 *      paints `bg-foreground` (not the section-alt default) when
 *      `personaChromeV2 === true` and no `bgColor` override is set
 *      (`invertFooter = theme?.personaChromeV2 === true && !bgColor`)
 *   3. theme default — the section-alt HSL triplet from
 *      `resolveBackgroundPreset`, which is what every theme's `Footer.tsx`
 *      paints via `bg-[hsl(var(--bg-section-alt))]` otherwise.
 *
 * KEEP THIS IN SYNC with every template's footer bg class — extracted to a
 * named, independently-tested function (rather than left as an inline JSX
 * expression) specifically so a future footer-bg refactor has one place to
 * update and a test that catches drift. Issue #139.
 */
export function resolveFooterAutoContrastBg(
  template: TemplateId,
  theme: StoreTheme,
  explicitBg: string | undefined
): string {
  if (explicitBg) return explicitBg;
  const boldInverted = template === 'bold' && theme?.personaChromeV2 === true;
  if (boldInverted) return asHslColor(theme.foregroundColor, theme);
  return asHslColor(resolveBackgroundPreset(theme).bgSectionAlt, theme);
}

const BARE_HSL_TRIPLET = /^\s*-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%\s*$/;

/**
 * Issue #2156 — a stored theme color is a bare triplet OR `#rrggbb` OR a
 * `token:*` ref (packages/shared color.ts), and the footer PAINTS the
 * normalized value (`themeToCssVars` runs every color var through
 * `colorToHslTriplet`). Wrapping the RAW value produced `hsl(#1a1a1a)`, which
 * `parseColorToRgb` rejects → the contrast filter fell back to `'none'` → a
 * dark logo on the near-black inverted bold footer. Normalize with the SAME
 * shared helper (never a fork of it); an already-bare triplet is passed
 * through untouched so every store that works today computes byte-identically.
 */
function asHslColor(value: string | undefined, theme: StoreTheme): string {
  if (value && BARE_HSL_TRIPLET.test(value)) return `hsl(${value.trim()})`;
  const triplet = colorToHslTriplet(value, theme);
  return triplet.startsWith('hsl(') ? triplet : `hsl(${triplet})`;
}
