// Plan baselines — which features are included by default per Ebda plan.
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
import { LOCKED_PUBLIC_PLANS, STORE_PLAN_TO_PLAN_CODE } from './schemas/plan-limits';

// Re-export so callers can write `import { StorePlan } from '@ebda/shared/plan-baselines'`
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
  // `whatsapp` (the Ebda Chat product, wa.ebda.app) is deliberately in NO
  // baseline. Flagged OFF 2026-10-14 (Ruling WHATSAPP-OFF-1; the legacy in-Store
  // bridge was deleted by WA-LEGACY-1): no merchant sees it until it launches.
  // A super-admin StoreFeature `whatsapp` override (enabled=true) turns it on
  // for one store. wa.me links never depend on this flag.
  // Basic inventory (granular sub-feature). The legacy `inventory` parent
  // flag is intentionally NOT in any baseline — new code paths read
  // `inventory.basic` and friends.
  'inventory.basic',
  // Staff accounts: core operational need, universal by default (managed-agency
  // pattern). Previously in NO baseline yet fully implemented +
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
  // client via a StoreFeature override, as with `staff_accounts`.
  'agent_feed',
  'agent_checkout',
  // Answer-Engine Insights (Task 1, 2026-07-22): same AI-first rationale as
  // agent_feed above — default-ON for every paid plan, off on free.
  'answer_engine_insights',
  'upsell_crosssell',
  'accounting.profit_anomaly',
  // 3D product models + AR (2026-10-07): every plan, Basic included — Ahmad's
  // decision, Ruling R-EBDA-3D-2. Restrict one store via a StoreFeature override.
  'product_3d',
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
  // Email campaigns (2026-10-21, Ahmad): Growth (professional) + Business (enterprise),
  // not Basic (starter). Consent is the newsletter opt-in; per-plan daily send caps live in
  // `campaignDailyCap` (apps/api campaign.service). A StoreFeature override still wins.
  'email_campaigns',
  // Customer wallet (2026-10-29, Ruling W-8, Ahmad via the close-all program): Growth + Business, not Basic. Both keys,
  // so a Growth store gets store credit AND spending it at checkout (checkout stays inert while accounting is on,
  // the feature's own rule). Supersedes D1's "no baseline"; a StoreFeature override still wins both ways, and
  // the explicit OFF row W-1 left on demo-boutique keeps it OFF until removed.
  'customer_wallet',
  'customer_wallet_checkout',
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
  // Business = EVERY feature (Ahmad 2026-11-15, Ruling BIZ-ALL-1): no feature is sold separately any more, so the keys that
  // used to be per-store override / plan-flag only are entitled here too. Hidden ones stay hidden (unfinished) but entitled.
  // `remove_branding`, `b2b.wholesale`, `merchant_mcp`, `merchant_mcp_write` are ALSO decided by the plan limits in
  // `FeatureService.rowsToMap` (the flag wins both ways); listing them keeps registry, baseline and enforcement in agreement.
  'inventory', // legacy parent flag: nothing reads it (routes use `inventory.*`), declared so the registry has no un-entitled key
  'bundles',
  'customer_intelligence',
  'eta_ereceipt',
  'remove_branding',
  'b2b.wholesale',
  'merchant_mcp',
  'merchant_mcp_write',
];

/**
 * The ONLY registry keys that are in NO baseline, each for a reason that is not "sold separately" (Ruling BIZ-ALL-1).
 * `plan-baselines.test.ts` enumerates the registry and fails if a key is in neither the Business baseline nor this map.
 */
// pq-allow(unused-export): the single source of the registry-completeness invariant, read by plan-baselines.test.ts and the Business resolution test
export const BUSINESS_BASELINE_EXCLUSIONS = {
  // INVERSE flag: ON switches the MCP write-credential requirement OFF (an unauthenticated write hole). Putting it in a
  // baseline would reopen the hole on every Business store, so it stays a super-admin per-store escape hatch (Ruling M2).
  agent_checkout_open_writes:
    'escape hatch: enabled = protection off; per-store super-admin override only',
  // The key gates the separate Ebda Chat product (Ruling WHATSAPP-OFF-1 / WA-LEGACY-1): nothing in Store reads it any more,
  // and Business already includes Ebda Chat through the plan limit `whatsappAutomation` + the server-owned link (WA-PKG-1).
  whatsapp:
    'Ebda Chat is billed and linked through the plan limit + store_whatsapp_links, not this key',
} as const satisfies Partial<Record<FeatureKey, string>>;

// 'agent_checkout_open_writes' and 'whatsapp' are the only keys in no baseline: see BUSINESS_BASELINE_EXCLUSIONS above.

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
    // 3D product models are on every plan (Ruling R-EBDA-3D-2), the fallback
    // `free` tier included, so a lapsed store's PDP does not lose its models.
    'product_3d',
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

/**
 * The PUBLIC plan (Basic / Growth / Business) a legacy `Store.plan` tier is sold as, or null
 * for `free` (not sold, D3). Every merchant-facing upgrade prompt names plans through this, so
 * "Starter / Professional / Enterprise" never reach a merchant (audit DOC-6 / M-080).
 */
export function publicPlanForStorePlan(
  plan: StorePlan
): { code: string; en: string; ar: string } | null {
  const code = STORE_PLAN_TO_PLAN_CODE[plan];
  const hit = LOCKED_PUBLIC_PLANS.find(p => p.code === code);
  return hit ? { code: hit.code, en: hit.nameEn, ar: hit.nameAr } : null;
}

/**
 * The PUBLIC plan that unlocks a feature, derived from the lowest tier whose baseline includes
 * it. `email_campaigns` is sold from Growth although its tier baseline is lower, so it keeps an
 * explicit override. Null when no sold plan unlocks it.
 */
const PUBLIC_PLAN_OVERRIDE_FOR_FEATURE: Partial<Record<FeatureKey, StorePlan>> = {
  email_campaigns: 'professional',
  // Sold from Growth by the plan limits (brandingRemoval / mcpAccess), though the Business baseline lists them too.
  remove_branding: 'professional',
  merchant_mcp: 'professional',
  merchant_mcp_write: 'professional',
};

export function publicPlanLabelForFeature(
  key: FeatureKey
): { code: string; en: string; ar: string } | null {
  const tier = PUBLIC_PLAN_OVERRIDE_FOR_FEATURE[key] ?? lowestPlanForFeature(key);
  return tier ? publicPlanForStorePlan(tier) : null;
}

/**
 * The sold plan to offer when `key` is switched off for a store on `planCode`, or null when the
 * plan itself is not what withholds it (the feature is in the plan's baseline, so a merchant or
 * super-admin toggle turned it off, or the plan is hidden/unknown). This is what lets a
 * 403 FEATURE_DISABLED carry an upgrade target without ever misreporting a toggle as a paywall.
 */
export function upgradeTargetForDisabledFeature(
  planCode: string,
  key: FeatureKey
): { code: string; nameEn: string; nameAr: string } | null {
  const tier = (['starter', 'professional', 'enterprise'] as const).find(
    t => STORE_PLAN_TO_PLAN_CODE[t] === planCode
  );
  if (!tier || isInBaseline(tier, key)) return null;
  // No plan unlocks an excluded key (an escape hatch / the Ebda Chat key): never promise one in an upgrade prompt.
  if (key in BUSINESS_BASELINE_EXCLUSIONS) return null;
  const target = publicPlanLabelForFeature(key);
  if (!target) return null;
  const targetTier = PUBLIC_PLAN_OVERRIDE_FOR_FEATURE[key] ?? lowestPlanForFeature(key);
  if (!targetTier || STORE_PLANS.indexOf(targetTier) <= STORE_PLANS.indexOf(tier)) return null;
  return { code: target.code, nameEn: target.en, nameAr: target.ar };
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
