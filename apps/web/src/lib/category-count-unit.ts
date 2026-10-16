/**
 * Category product-count line helper.
 *
 * The count shown on category cards ("4 pieces" / "٤ قطع"). A store that never
 * set a unit word gets the one plural helper (Y-01, `lib/plural.ts`), which
 * declines the noun for every Arabic category ("قطعة واحدة / قطعتان / ٣ قطع /
 * ١١ قطعة"). The default noun is "pieces" / "قطعة" across all templates (bold
 * previously used "items"/"منتج" but is unified here to keep the store-wide
 * setting coherent).
 */

import type { StoreTheme } from '@ebda/shared';
import { countText, PIECES } from './plural';

/**
 * The category card's count line. A merchant-configured unit
 * (`theme.categoryCountUnit`) is the merchant's own single word: it cannot be
 * declined, so it is printed after the number as typed (the one sanctioned
 * number + word join, allowlisted in tests/unit/plural-counted-nouns.test.ts).
 *
 * @param theme  The store's `StoreTheme` (or null for the plain default).
 * @param isRtl  Whether the current locale is RTL (Arabic).
 * @param count  The product count (picks the plural form).
 * @param shown  The count as displayed (the render's digits); defaults to `count`.
 */
export function categoryCountText(
  theme: Pick<StoreTheme, 'categoryCountUnit'> | null | undefined,
  isRtl: boolean,
  count: number,
  shown: string = String(count)
): string {
  const unit = theme?.categoryCountUnit;
  const custom = (isRtl ? unit?.ar : unit?.en)?.trim();
  if (custom) return `${shown} ${custom}`;
  return countText(isRtl ? 'ar' : 'en', count, PIECES, shown);
}
