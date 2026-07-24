// Plan baselines — which features are included by default per Force AI Store plan.
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
  // WhatsApp admin access is available to ALL stores by default (managed-agency:
  // Ahmad onboards every client and WhatsApp is a core offering — default full
  // access, restrict by exception). The feature still needs per-tenant WABA
  // config to actually send; the baseline only ungates the admin section so
  // every merchant can set it up. To restrict a specific client (limited deal),
  // super-admin sets a StoreFeature `whatsapp` override with enabled=false.
  'whatsapp',
  // Basic inventory (granular sub-feature). The legacy `inventory` parent
  // flag is intentionally NOT in any baseline — new code paths read
  // `inventory.basic` and friends.
  'inventory.basic',
  // Staff accounts: core operational need, universal by default (managed-agency
  // pattern, like `whatsapp`). Previously in NO baseline yet fully implemented +
  // ungated → available to every plan anyway but declared-disabled (dead flag).
  // Declaring it here makes the registry/baseline/enforcement agree; staff.routes
  // now calls requireFeature('staff_accounts'), so a super-admin can still
  // restrict a specific client via a StoreFeature override. To sell staff seats
  // as a paid tier later, move this into the appropriate ADDITIONS array.
  'staff_accounts',
  // AI-first policy (2026-07-21, Ahmad): every AI capability is available on
  // every paid plan. AI is the product's core differentiator and the only
  // uncontested one — tiering it made the "AI-first product" positioning untrue
  // and left the flagship AI Product Feed disabled on every single store
  // (a live storefront returned 404 for /feeds/products.json). Revenue comes
  // from the platform, not from gating the differentiator. Restrict a specific
  // client via a StoreFeature override, as with `whatsapp` and `staff_accounts`.
  'agent_feed',
  // Answer-Engine Insights (Task 1, 2026-07-22): same AI-first rationale as
  // agent_feed above — default-ON for every paid plan, off on free.
  'answer_engine_insights',
  'upsell_crosssell',
  'accounting.profit_anomaly',
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
  // 'upsell_crosssell' moved to STARTER_CORE (AI-first policy, 2026-07-21).
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
  // 'accounting.profit_anomaly' moved to STARTER_CORE (AI-first policy, 2026-07-21).
  'accounting.bank_reconcile',
  // Extras
  'affiliate',
  'sms',
  'floating_widget',
  // High-intent retargeting (2026-06-22)
  'payment_abandonment',
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
    // WhatsApp admin access is universal (managed-agency default — see STARTER_CORE).
    'whatsapp',
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
