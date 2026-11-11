import { publicPlanLabelForFeature, type FeatureKey } from '@ebda/shared';

/**
 * How a navigation item for a (possibly plan-gated) feature renders:
 *   open    - show it normally (no feature, feature on, super admin, or entitlements still loading: never flash a lock)
 *   locked  - show it with a lock badge: the feature is OFF and a sold plan (Basic / Growth / Business) includes it,
 *             so the merchant should see what exists and the page answers with the upgrade card
 *   hidden  - the feature is OFF and no sold plan includes it (e.g. the customer wallet at launch): an upsell for
 *             something nobody can buy is noise, so the item does not appear
 */
export type NavFeatureState = 'open' | 'locked' | 'hidden';

export function navFeatureState(
  feature: string | null | undefined,
  ctx: { isEnabled: (key: string) => boolean; isLoading: boolean; isSuperAdmin: boolean }
): NavFeatureState {
  if (!feature || ctx.isSuperAdmin || ctx.isLoading) return 'open';
  if (ctx.isEnabled(feature)) return 'open';
  return publicPlanLabelForFeature(feature as FeatureKey) ? 'locked' : 'hidden';
}
