// Plan baselines — which features are included by default per Force Store plan.
//
// Resolution rule used by `apps/api/src/lib/feature-gate.ts`:
//
//   isFeatureEnabled(storeId, key) =
//     StoreFeature row exists?  -> row.enabled       (override wins)
//     else                      -> PLAN_BASELINE[store.plan].includes(key)
//
// Plan changes DO NOT touch StoreFeature rows — super-admin overrides
// are preserved across upgrades and downgrades (Ahmad's 2026-05-27
// decision, documented in feedback-six-failures-from-2026-05-26 +
// docs/superpowers/plans/2026-05-27-feature-tiering-and-access-control.md).
//
// Sub-feature granularity (inventory.* + accounting.*) — see features.ts
// for the FEATURE_REGISTRY entries.

import type { FeatureKey } from './features';
import type { StorePlan } from './types';

// Re-export so callers can write `import { StorePlan } from '@force/shared/plan-baselines'`
// alongside PLAN_BASELINE in one line.
export type { StorePlan };

export const STORE_PLANS: readonly StorePlan[] = [
  'free',
  'starter',
  'professional',
  'enterprise',
] as const;

/**
 * Storefront + commerce core — every paying plan gets these. Listed once
 * here so the per-plan arrays below stay readable.
 */
const STARTER_CORE: FeatureKey[] = [
  'coupons',
  'returns',
  'reviews',
  'tax',
  'pwa',
  'seo',
  'search_autocomplete',
  'marketing_pixels',
  'shipping_carriers',
  'bulk_operations',
  'abandoned_cart',
  // Basic inventory (granular sub-feature). The legacy `inventory` parent
  // flag is intentionally NOT in any baseline — new code paths read
  // `inventory.basic` and friends.
  'inventory.basic',
];

const PROFESSIONAL_ADDITIONS: FeatureKey[] = [
  // Inventory step-up
  'inventory.stock_alerts',
  'inventory.backorder',
  // Accounting step-up
  'accounting.basic',
  'accounting.expenses',
  'accounting.invoicing',
  // Marketing + retention
  'loyalty',
  'push_notifications',
  'upsell_crosssell',
];

const ENTERPRISE_ADDITIONS: FeatureKey[] = [
  // Full inventory suite
  'inventory.multi_warehouse',
  'inventory.barcode',
  'inventory.purchase_orders',
  'inventory.bulk_adjustments',
  // Full accounting suite
  'accounting.tax_reports',
  'accounting.multi_currency',
  'accounting.profit_anomaly',
  'accounting.bank_reconcile',
  // Extras
  'affiliate',
  'sms',
  'floating_widget',
];

/**
 * Features that resolve to ENABLED for a store on this plan by default.
 * Super-admin can override per-store via the StoreFeature table; see
 * apps/api/src/lib/feature-gate.ts.
 *
 * The arrays are layered (Professional includes Starter; Enterprise
 * includes Professional) to enforce the strict-superset invariant
 * unit-tested in plan-baselines.test.ts.
 */
export const PLAN_BASELINE: Record<StorePlan, readonly FeatureKey[]> = {
  free: [
    // Stripped fallback — for the demo / lapsed-payment grace state.
    // The merchant can still see their data but customer-facing features
    // are minimal. Super-admin can grant extras via override.
    'coupons',
    'reviews',
    'inventory.basic',
  ],
  starter: STARTER_CORE,
  professional: [...STARTER_CORE, ...PROFESSIONAL_ADDITIONS],
  enterprise: [...STARTER_CORE, ...PROFESSIONAL_ADDITIONS, ...ENTERPRISE_ADDITIONS],
};

/** Returns the baseline feature set for a plan, in a defensive copy. */
export function getBaselineFeatures(plan: StorePlan): FeatureKey[] {
  return [...PLAN_BASELINE[plan]];
}

/**
 * Returns the lowest plan (in STORE_PLANS ascending order) whose baseline
 * includes `key`, or null if no plan baseline covers the feature.
 *
 * Used by the upgrade-marketing gate to show "Available on the X plan and above."
 */
export function lowestPlanForFeature(key: FeatureKey): StorePlan | null {
  for (const plan of STORE_PLANS) {
    if (PLAN_BASELINE[plan].includes(key)) {
      return plan;
    }
  }
  return null;
}

/** Convenience: is `key` in the baseline for `plan`? */
export function isInBaseline(plan: StorePlan, key: FeatureKey): boolean {
  return PLAN_BASELINE[plan].includes(key);
}

/**
 * Display metadata for the admin UI's plan picker. Keep labels stable —
 * they show up in proposals, contracts, and the merchant-facing
 * "Current plan: X" badge.
 */
export const PLAN_LABELS: Record<StorePlan, { en: string; ar: string }> = {
  free: { en: 'Free', ar: 'مجاني' },
  starter: { en: 'Starter', ar: 'المبدئية' },
  professional: { en: 'Professional', ar: 'الاحترافية' },
  enterprise: { en: 'Enterprise', ar: 'المؤسسية' },
};
