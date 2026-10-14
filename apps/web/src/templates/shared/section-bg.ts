import type { CSSProperties } from 'react';
import { resolveColor } from '@ebda/shared';
import type { StoreTheme } from '@ebda/shared';

/**
 * Per-section style — paints the merchant's explicit bg override only.
 * No runtime contrast auto-fix; ColorField in admin owns pick-time
 * feedback. Render merchant intent verbatim.
 */
export function sectionBgStyle(
  bgColor: string | undefined,
  theme: StoreTheme
): CSSProperties | undefined {
  const resolvedBg = resolveColor(bgColor, theme);
  if (!resolvedBg) return undefined;
  return { backgroundColor: resolvedBg };
}
