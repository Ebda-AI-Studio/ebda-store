/**
 * Where "add just this feature" goes on a lower-plan upgrade screen (Ahmad 2026-11-15: Basic/Growth can buy ONE Business
 * feature monthly instead of upgrading). The purchase flow itself is built in the self-service add-ons stack (#775 / #827,
 * route `/stores/:id/billing/addons?sku=...`), not here. Until that route is on main this points at the Billing plans
 * section; the add-ons builder swaps the body of this ONE function and no caller changes.
 */
export function featureAddHref(storeId: string, featureKey: string): string {
  return `/stores/${encodeURIComponent(storeId)}/billing?feature=${encodeURIComponent(featureKey)}#plans`;
}
