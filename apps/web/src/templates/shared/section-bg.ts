import type { CSSProperties } from 'react';
import { resolveColor } from '@force/shared';
import type { StoreTheme } from '@force/shared';

/**
 * Per-section style — paints the merchant's explicit bg override.
 *
 * 2026-05-20 night: REMOVED the `--section-fg` WCAG-AA auto-fix cascade.
 * It was the "smart system" overriding explicit merchant picks: merchant
 * sets bg=dark-maroon + text=white → contrast computed against an
 * unparseable `hsl(var(--X))` string returned 1.0 (worst case) → auto-fix
 * forced text to black on dark-maroon → invisible. Same self-suppressing-
 * convenience-gate trap as the layout.tsx token-flip removed earlier
 * tonight.
 *
 * Trust merchant intent. ColorField in admin already shows a live
 * contrast preview against the picked bg, so the merchant gets the
 * feedback at pick time. No runtime second-guessing.
 *
 * The `merchantHeadingColor` parameter is kept in the signature so call
 * sites don't need touching, but it's now unused. Future cleanup can
 * drop it.
 */
export function sectionBgStyle(
  bgColor: string | undefined,
  theme: StoreTheme
): CSSProperties | undefined {
  const resolvedBg = resolveColor(bgColor, theme);
  if (!resolvedBg) return undefined;
  return { backgroundColor: resolvedBg };
}
