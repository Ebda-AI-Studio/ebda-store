/**
 * Which feature a store-admin route needs, in ONE place (audit G-2/G-3, 2026-11-03).
 *
 * `stores/[id]/layout.tsx` already reads the store's entitlements once (AdminFeatureProvider). It uses this map to
 * render the locked-plan card INSTEAD of a gated page, so the page never mounts, never fetches and never fails with a
 * raw "Request failed with status 403" / "Feature not available". Keys mirror the API's `requireFeature(...)` per
 * route family; the longest matching prefix wins. Super admins are never gated (they configure features).
 */

export interface RouteFeatureGate {
  /** Path after `/stores/<id>`. Matches the prefix itself or anything below it. */
  prefix: string;
  feature: string;
}

export const ROUTE_FEATURE_GATES: readonly RouteFeatureGate[] = [
  { prefix: '/stock/purchase-orders', feature: 'inventory.purchase_orders' },
  { prefix: '/stock/backorders', feature: 'inventory.backorder' },
  { prefix: '/stock/warehouses', feature: 'inventory.multi_warehouse' },
  { prefix: '/stock/adjustments', feature: 'inventory.bulk_adjustments' },
  { prefix: '/stock/suppliers', feature: 'accounting.basic' },
  { prefix: '/finance/bank-reconciliation', feature: 'accounting.bank_reconcile' },
  { prefix: '/finance/expenses', feature: 'accounting.expenses' },
  { prefix: '/finance', feature: 'accounting.basic' },
  { prefix: '/campaigns', feature: 'email_campaigns' },
  { prefix: '/abandoned-carts', feature: 'abandoned_cart' },
  { prefix: '/affiliates', feature: 'affiliate' },
  { prefix: '/loyalty', feature: 'loyalty' },
  { prefix: '/bundles', feature: 'bundles' },
  { prefix: '/staff', feature: 'staff_accounts' },
  { prefix: '/answer-engine', feature: 'answer_engine_insights' },
  { prefix: '/coupons', feature: 'coupons' },
];

/** The feature a `/stores/<storeId>/...` pathname needs, or null when the route is not plan-gated. */
export function featureForStorePath(pathname: string, storeId: string): string | null {
  const base = `/stores/${storeId}`;
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  const rest = pathname.slice(base.length);
  let best: RouteFeatureGate | null = null;
  for (const g of ROUTE_FEATURE_GATES) {
    if (rest === g.prefix || rest.startsWith(`${g.prefix}/`)) {
      if (!best || g.prefix.length > best.prefix.length) best = g;
    }
  }
  return best ? best.feature : null;
}

interface GateErrorShape {
  status?: number;
  code?: string;
}

/**
 * True for a response that means "your plan does not include this": 402, or 403 with the explicit FEATURE_DISABLED code
 * (the API's `requireFeature` always sends it). A bare 403, `SERVER_ERROR` or a permission/MFA code is NOT a plan refusal:
 * a permission denial must never read as an upsell.
 */
export function isPlanGateError(error: GateErrorShape | null | undefined): boolean {
  if (!error) return false;
  if (error.status === 402) return true;
  if (error.status !== 403) return false;
  return error.code === 'FEATURE_DISABLED';
}

/** What a merchant reads when the API refused for plan reasons and sent no localized text. Never the raw API string. */
export const PLAN_GATE_FALLBACK = {
  ar: 'الميزة دي مش متاحة في باقتك الحالية. اترقّى عشان تفتحها.',
  en: 'This feature is not included in your current plan. Upgrade to unlock it.',
} as const;

/** A 403 that is NOT a plan refusal and carried no text: a permission denial, in words, never an upsell and never raw. */
export const PERMISSION_DENIED_FALLBACK = {
  ar: 'مش مسموحلك تعمل الإجراء ده.',
  en: "You don't have permission to do this.",
} as const;

/** API strings that must never reach a merchant verbatim. */
export const RAW_PLAN_GATE_MESSAGES: readonly string[] = ['Feature not available'];
export const RAW_STATUS_MESSAGE = /^Request failed with status \d{3}$/;
