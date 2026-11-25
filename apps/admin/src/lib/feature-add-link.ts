import { isAddonFeature } from '@ebda/shared';

/**
 * Where "add just this feature" goes on a lower-plan upgrade screen: the self-service add-ons page, with the SKU of the
 * feature (Ruling AI-ADDON-1: add-ons ARE sold by card). A feature that has no buyable add-on returns null and the caller
 * hides the button (there is nothing to buy; the merchant can still upgrade). The buyable set is `ADDON_FEATURE_KEYS`,
 * checked against the API catalog by `tests/unit/addon-feature-keys-match-catalog.test.ts`.
 */
export function featureAddHref(storeId: string, featureKey: string): string | null {
  if (!isAddonFeature(featureKey)) return null;
  return `/stores/${encodeURIComponent(storeId)}/billing/addons?sku=${encodeURIComponent(`feature:${featureKey}`)}`;
}
