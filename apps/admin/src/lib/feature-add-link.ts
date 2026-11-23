/**
 * Where "add just this feature" goes on a lower-plan upgrade screen. Add-ons ARE sold (Ruling AI-ADDON-1, Ahmad
 * 2026-11-23): the purchase flow is the self-service add-ons page `/stores/:id/billing/addons?sku=...` of PR #775 / #827,
 * which is not on main yet, so until it lands this points at the Billing plans section (a lower plan can still upgrade
 * there; nothing is lost). When #775 merges, its owner swaps the body of this ONE function (and hides the CTA for a
 * feature that has no add-on SKU); no caller changes. Recorded in docs/rulings/BIZ-ALL-1.md (BIZ-ALL-6).
 */
export function featureAddHref(storeId: string, featureKey: string): string {
  return `/stores/${encodeURIComponent(storeId)}/billing?feature=${encodeURIComponent(featureKey)}#plans`;
}
