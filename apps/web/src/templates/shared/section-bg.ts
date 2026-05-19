import type { CSSProperties } from 'react';
import { resolveColor, pickReadableForeground, contrastRatio } from '@force/shared';
import type { StoreTheme } from '@force/shared';

const AA_NORMAL = 4.5;

/**
 * Per-section style — computes effective bg + auto-fixes section text color
 * when merchant's chosen heading text would fail WCAG AA contrast against the
 * effective bg.
 *
 * Effective bg priority:
 *   1. explicit `bgColor` override on the section (resolved against theme)
 *   2. theme `card` surface (token:card → theme.cardColor)
 *   3. theme `background` (theme.backgroundColor read directly)
 *   4. '#FFFFFF' final fallback
 *
 * `merchantHeadingColor` = the color the merchant WANTS the section heading
 * to be. Pass the value ALREADY RESOLVED from the section-typography priority
 * chain:
 *   resolveSectionZone(section.typography?.heading, ...)?.color  // per-section override
 *     ?? globalZones?.sectionTitle?.color                         // global zone (raw, needs resolveColor)
 *     ?? undefined                                                 // no merchant pick → no auto-fix needed
 *
 * Returns:
 *   - `backgroundColor`: only set when explicit bgColor was provided (don't
 *      paint theme-inherit colors as inline — that breaks dark-mode tokens)
 *   - `--section-fg`: set ONLY when merchant DID pick a color AND that color
 *      fails AA against the effective bg. When set, the cascade in globals.css
 *      forces `color: var(--section-fg) !important` on the section's text zones,
 *      protecting from invisible-text bugs.
 *
 * If merchant didn't pick a color (merchantHeadingColor is undefined), `--section-fg`
 * is NOT set — theme defaults render and the cascade doesn't fire.
 */
export function sectionBgStyle(
  bgColor: string | undefined,
  theme: StoreTheme,
  merchantHeadingColor?: string | undefined
): CSSProperties | undefined {
  const resolvedBg = resolveColor(bgColor, theme);

  // Determine the EFFECTIVE bg for contrast checks even when no explicit override.
  // Try card token first (often the section surface in light themes), then fall
  // back to the theme's base background, then hard-coded white.
  const resolvedCard = resolveColor('token:card', theme);
  // theme.backgroundColor is a bare HSL triplet ("H S% L%") — wrap it like resolveColor does.
  const rawThemeBg = (theme as unknown as Record<string, string | undefined>).backgroundColor;
  const resolvedThemeBg = rawThemeBg
    ? rawThemeBg.startsWith('hsl(') || rawThemeBg.startsWith('#')
      ? rawThemeBg
      : `hsl(${rawThemeBg})`
    : undefined;
  const effectiveBg = resolvedBg ?? resolvedCard ?? resolvedThemeBg ?? '#FFFFFF';

  // merchantHeadingColor arrives pre-resolved (resolveSectionZone already ran
  // resolveColor on it). It may still be a raw hex/hsl — contrastRatio handles both.
  const resolvedMerchantFg = merchantHeadingColor
    ? (resolveColor(merchantHeadingColor, theme) ?? merchantHeadingColor)
    : undefined;

  const style: CSSProperties = {};

  // Only paint backgroundColor when explicitly overridden; inherit otherwise
  // so CSS theme tokens keep working.
  if (resolvedBg) {
    style.backgroundColor = resolvedBg;
  }

  // Only set --section-fg when the merchant's chosen color fails AA against
  // the effective bg. The existing cascade in globals.css then forces that
  // auto-fixed color onto every [data-zone] within the section.
  if (resolvedMerchantFg) {
    const contrast = contrastRatio(effectiveBg, resolvedMerchantFg);
    if (contrast < AA_NORMAL) {
      const autoFg = pickReadableForeground(effectiveBg);
      if (autoFg) {
        (style as Record<string, string>)['--section-fg'] = autoFg;
      }
    }
  }

  // Return undefined when no style was set — preserves prior behavior for
  // sections with no overrides at all.
  return Object.keys(style).length ? style : undefined;
}
