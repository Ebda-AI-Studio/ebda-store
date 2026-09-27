import type { StoreTheme, TemplateId } from '@force/shared';
import { resolveBackgroundPreset } from '@force/shared';

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
  if (boldInverted) return `hsl(${theme.foregroundColor})`;
  return `hsl(${resolveBackgroundPreset(theme).bgSectionAlt})`;
}
