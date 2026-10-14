/**
 * Category product-count unit label helper.
 *
 * Returns the merchant-configured unit word for the product count shown on
 * category cards (e.g. "4 pieces" / "4 قطعة"). Falls back to the canonical
 * defaults so stores that haven't configured a value continue to look exactly
 * as before.
 *
 * Default: EN "pieces" / AR "قطعة" — canonical across all templates (bold
 * previously used "items"/"منتج" but is unified here to keep the store-wide
 * setting coherent).
 */

import type { StoreTheme } from '@ebda/shared';

const DEFAULT_UNIT_EN = 'pieces';
const DEFAULT_UNIT_AR = 'قطعة';

/**
 * Return the configured (or default) category count unit word for the given
 * language direction.
 *
 * @param theme   The store's `StoreTheme` (from `useStore().store.theme`).
 *                Pass `null` or `undefined` to get the plain default.
 * @param isRtl   Whether the current locale is RTL (Arabic).
 */
export function getCategoryCountUnit(
  theme: Pick<StoreTheme, 'categoryCountUnit'> | null | undefined,
  isRtl: boolean
): string {
  const unit = theme?.categoryCountUnit;
  if (isRtl) {
    return unit?.ar?.trim() || DEFAULT_UNIT_AR;
  }
  return unit?.en?.trim() || DEFAULT_UNIT_EN;
}
