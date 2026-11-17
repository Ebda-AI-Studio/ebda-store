import { z } from 'zod/v3';

/**
 * Plan limits — the shape of `plans.limits` (JSON) and the single list of keys
 * the enforcement engine (`assertWithinLimit`, apps/api) understands.
 *
 * Numeric limits: a non-negative integer is a hard ceiling; `null` is UNLIMITED
 * (never "unset" — an absent key fails validation so a typo cannot silently
 * lift a ceiling). Boolean limits are capabilities (`customDomain`, automation).
 * `platformFeeBps` / `codPlatformFeeBps` are basis points (100 = 1%) charged by
 * the platform per online / COD order; they are NOT gates — SP6 reads them.
 */
export const ANALYTICS_TIERS = ['basic', 'standard', 'advanced'] as const;
export type AnalyticsTier = (typeof ANALYTICS_TIERS)[number];
export const SUPPORT_TIERS = ['email', 'chat', 'priority'] as const;
export type SupportTier = (typeof SUPPORT_TIERS)[number];

const ceiling = z.number().int().min(0).max(2_147_483_647).nullable();
const bps = z.number().int().min(0).max(10_000);

export const planLimitsSchema = z
  .object({
    maxProducts: ceiling,
    maxStaff: ceiling,
    maxOrdersPerMonth: ceiling,
    maxStorageMb: ceiling,
    /** Stores one owner may hold (counted across the owner's non-deleted stores). */
    maxStores: ceiling,
    customDomain: z.boolean(),
    platformFeeBps: bps,
    codPlatformFeeBps: bps.default(0),
    abandonedCartAutomation: z.boolean(),
    whatsappAutomation: z.boolean(),
    /** Hide the "Powered by Ebda" storefront footer attribution. */
    brandingRemoval: z.boolean(),
    /**
     * Programmatic API access (Business). Since 2026-10-14 this is NO LONGER the MCP gate: the
     * merchant-admin MCP is decided by `planIncludesMerchantMcp` (Growth + Business). `apiAccess`
     * stays reserved for future outbound API/webhook access.
     */
    apiAccess: z.boolean(),
    /**
     * B2B wholesale pricing (feature key `b2b.wholesale`): quantity tiers, group prices, MOQ,
     * wholesale-only products and the wholesale application flow. Business + comped (Ruling B2B-1).
     * `.default(false)`: a stored `plans.limits` blob written before this key existed still parses
     * (to OFF) - the corrupt-blob fallback in `parseLimits` must never flip a gate open.
     */
    wholesalePricing: z.boolean().default(false),
    /**
     * Catalogue import (photos / PDFs -> draft products) page allowance per region month. `null` =
     * unlimited, `0` = not included. `.default(0)`: a blob written before this key existed parses to
     * OFF, never to unlimited (Ruling CATIMP-2). Not a gated write: the page ledger
     * (apps/api/src/lib/catalogue/page-ledger.ts) reads it directly.
     */
    catalogImportPagesPerMonth: ceiling.default(0),
    analyticsTier: z.enum(ANALYTICS_TIERS),
    supportTier: z.enum(SUPPORT_TIERS),
  })
  .strict();

export type PlanLimits = z.infer<typeof planLimitsSchema>;

/**
 * Plan codes that include the merchant-admin MCP (key minting, read tools and write
 * tools). Ahmad 2026-10-14: Growth + Business. Decoupled from `apiAccess` on purpose:
 * widening `apiAccess` would need a data change to the live `plans` rows (and breaks the
 * migration-equals-seeds contract test), and would hand Growth the future API/webhook
 * entitlement that was never decided.
 */
export const MERCHANT_MCP_PLAN_CODES: readonly string[] = ['growth', 'business'];

/** True when a plan includes the merchant MCP: a listed code, or any plan that grants `apiAccess`. */
export function planIncludesMerchantMcp(code: string, limits: { apiAccess: boolean }): boolean {
  return limits.apiAccess || MERCHANT_MCP_PLAN_CODES.includes(code);
}
export type PlanLimitKey = keyof PlanLimits;

/** Limits that are a count ceiling (null = unlimited). */
export const NUMERIC_LIMIT_KEYS = [
  'maxProducts',
  'maxStaff',
  'maxOrdersPerMonth',
  'maxStorageMb',
  'maxStores',
] as const satisfies readonly PlanLimitKey[];
export type NumericLimitKey = (typeof NUMERIC_LIMIT_KEYS)[number];

/** Limits that are an on/off capability. */
export const BOOLEAN_LIMIT_KEYS = [
  'customDomain',
  'abandonedCartAutomation',
  'whatsappAutomation',
  'brandingRemoval',
  'apiAccess',
  'wholesalePricing',
] as const satisfies readonly PlanLimitKey[];
export type BooleanLimitKey = (typeof BOOLEAN_LIMIT_KEYS)[number];

/** Pricing/fee fields: exposed for billing (SP5 task 3) and fees (SP6), never gated. */
export const FEE_LIMIT_KEYS = ['platformFeeBps', 'codPlatformFeeBps'] as const;

/** Everything `assertWithinLimit` can be asked about. */
export const GATED_LIMIT_KEYS = [...NUMERIC_LIMIT_KEYS, ...BOOLEAN_LIMIT_KEYS] as const;
export type GatedLimitKey = (typeof GATED_LIMIT_KEYS)[number];

export function isNumericLimitKey(key: string): key is NumericLimitKey {
  return (NUMERIC_LIMIT_KEYS as readonly string[]).includes(key);
}

/** Subscription lifecycle (task 3 drives the transitions; task 1 only reads them). */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'comped',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Admin body for `PUT /admin/plans/:code` — prices stay null until Ahmad sets them. */
export const updatePlanSchema = z
  .object({
    nameEn: z.string().trim().min(1).max(80),
    nameAr: z.string().trim().min(1).max(80),
    sort: z.number().int().min(0).max(10_000),
    isPublic: z.boolean(),
    /** Piastres (EGP minor units); null = not set yet. */
    priceMonthlyMinor: z.number().int().min(0).max(1_000_000_000).nullable(),
    priceYearlyMinor: z.number().int().min(0).max(1_000_000_000).nullable(),
    limits: planLimitsSchema,
  })
  .strict();
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

/** Admin body for `PUT /admin/stores/:id/subscription`. */
export const assignSubscriptionSchema = z
  .object({
    planCode: z.string().trim().min(1).max(40),
    status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  })
  .strict();
export type AssignSubscriptionInput = z.infer<typeof assignSubscriptionSchema>;

// ── Plan catalog ─────────────────────────────────────────────────────────────
// The FULL catalog as it stands after migration 20261005090000_locked_pricing:
// Ahmad's locked public plans (2026-10-05, docs/plans/done/2026-10-05-pricing-decisions.md)
// plus the hidden compatibility rows (free / pro / comped / founding_free).
// Hidden rows exist only so existing `store_subscriptions.plan_code` references
// keep resolving; they are never offered. Their NEW limit fields (maxStores,
// brandingRemoval, apiAccess, analyticsTier, supportTier) are set so a store
// already on one sees NO behaviour change (Ruling EBDA-PRICING-3). A unit test
// pins parity between this list and the locked_pricing migration.

export type PlanCode =
  | 'free'
  | 'basic'
  | 'growth'
  | 'business'
  | 'pro'
  | 'comped'
  | 'founding_free';

export interface PlanSeed {
  code: PlanCode;
  nameEn: string;
  nameAr: string;
  sort: number;
  isPublic: boolean;
  /** The legacy `StorePlan` enum tier whose PLAN_BASELINE feature set this plan inherits. */
  featureTier: 'free' | 'starter' | 'professional' | 'enterprise';
  /** Piastres (EGP minor units); null on hidden rows (never sold). Yearly = 9 months prepaid (25% off). */
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  limits: PlanLimits;
}

export const DEFAULT_PLAN_SEEDS: readonly PlanSeed[] = [
  {
    code: 'free',
    nameEn: 'Free',
    nameAr: 'مجاني',
    sort: 80,
    isPublic: false,
    featureTier: 'free',
    priceMonthlyMinor: null,
    priceYearlyMinor: null,
    limits: {
      maxProducts: 50,
      maxStaff: 1,
      maxOrdersPerMonth: 100,
      maxStorageMb: 500,
      // 1: `free` is also the canceled-subscription fallback, so a lapsed owner cannot keep adding stores.
      maxStores: 1,
      customDomain: false,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: false,
      whatsappAutomation: false,
      brandingRemoval: false,
      apiAccess: false,
      wholesalePricing: false,
      catalogImportPagesPerMonth: 0,
      analyticsTier: 'advanced',
      supportTier: 'email',
    },
  },
  {
    code: 'basic',
    nameEn: 'Basic',
    nameAr: 'الأساسية',
    sort: 10,
    isPublic: true,
    featureTier: 'starter',
    priceMonthlyMinor: 149000,
    priceYearlyMinor: 1341000,
    limits: {
      maxProducts: null,
      maxStaff: 2,
      maxOrdersPerMonth: 300,
      maxStorageMb: null,
      maxStores: 1,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: false,
      whatsappAutomation: false,
      brandingRemoval: false,
      apiAccess: false,
      wholesalePricing: false,
      catalogImportPagesPerMonth: 100,
      analyticsTier: 'basic',
      supportTier: 'email',
    },
  },
  {
    code: 'growth',
    nameEn: 'Growth',
    nameAr: 'النمو',
    sort: 20,
    isPublic: true,
    featureTier: 'professional',
    priceMonthlyMinor: 349000,
    priceYearlyMinor: 3141000,
    limits: {
      maxProducts: null,
      maxStaff: 5,
      maxOrdersPerMonth: 3000,
      maxStorageMb: null,
      maxStores: 1,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: false,
      brandingRemoval: true,
      apiAccess: false,
      wholesalePricing: false,
      catalogImportPagesPerMonth: 400,
      analyticsTier: 'standard',
      supportTier: 'chat',
    },
  },
  {
    code: 'business',
    nameEn: 'Business',
    nameAr: 'الأعمال',
    sort: 30,
    isPublic: true,
    featureTier: 'enterprise',
    priceMonthlyMinor: 999000,
    priceYearlyMinor: 8991000,
    limits: {
      maxProducts: null,
      maxStaff: 15,
      maxOrdersPerMonth: null,
      maxStorageMb: null,
      maxStores: 3,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      // Ruling WA-PKG-1 (Ahmad 2026-10-24): the Business plan includes the Ebda Chat package.
      whatsappAutomation: true,
      brandingRemoval: true,
      apiAccess: true,
      wholesalePricing: true,
      catalogImportPagesPerMonth: 1500,
      analyticsTier: 'advanced',
      supportTier: 'priority',
    },
  },
  {
    code: 'pro',
    nameEn: 'Pro',
    nameAr: 'احترافي',
    sort: 85,
    isPublic: false,
    featureTier: 'professional',
    priceMonthlyMinor: null,
    priceYearlyMinor: null,
    limits: {
      maxProducts: 5000,
      maxStaff: 10,
      maxOrdersPerMonth: 7000,
      maxStorageMb: 20000,
      maxStores: null,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: true,
      brandingRemoval: false,
      apiAccess: false,
      wholesalePricing: false,
      catalogImportPagesPerMonth: 400,
      analyticsTier: 'advanced',
      supportTier: 'chat',
    },
  },
  {
    code: 'comped',
    nameEn: 'Comped',
    nameAr: 'مجاني بمنحة',
    sort: 90,
    isPublic: false,
    featureTier: 'enterprise',
    priceMonthlyMinor: null,
    priceYearlyMinor: null,
    limits: {
      maxProducts: null,
      maxStaff: null,
      maxOrdersPerMonth: null,
      maxStorageMb: null,
      maxStores: null,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: true,
      brandingRemoval: false,
      apiAccess: false,
      wholesalePricing: true,
      catalogImportPagesPerMonth: null,
      analyticsTier: 'advanced',
      supportTier: 'priority',
    },
  },
  {
    // Amelia Aurum's founding deal: unlimited, 0 fee, admin-granted only. Row exists;
    // nothing is assigned to it by this change.
    code: 'founding_free',
    nameEn: 'Founding (free)',
    nameAr: 'مؤسس (مجاني)',
    sort: 95,
    isPublic: false,
    featureTier: 'enterprise',
    priceMonthlyMinor: null,
    priceYearlyMinor: null,
    limits: {
      maxProducts: null,
      maxStaff: null,
      maxOrdersPerMonth: null,
      maxStorageMb: null,
      maxStores: null,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: false,
      brandingRemoval: true,
      apiAccess: true,
      wholesalePricing: false,
      catalogImportPagesPerMonth: null,
      analyticsTier: 'advanced',
      supportTier: 'priority',
    },
  },
];

/** Ahmad's locked public catalog, 2026-10-05: Basic / Growth / Business. */
export const LOCKED_PUBLIC_PLANS = DEFAULT_PLAN_SEEDS.filter(p => p.isPublic);

/**
 * Ebda Store's `Store.plan` enum value → Ebda plan code, AS THE ORIGINAL SP5 BACKFILL
 * MIGRATION (20261003130000) APPLIED IT. Frozen: a unit test pins it to that
 * migration's CASE (`enterprise` → `comped`: nobody paid for it, it was an
 * admin-granted "everything on"). Runtime code uses `STORE_PLAN_TO_PLAN_CODE`.
 */
export const LEGACY_STORE_PLAN_TO_PLAN_CODE: Record<
  'free' | 'starter' | 'professional' | 'enterprise',
  PlanCode
> = {
  free: 'free',
  starter: 'growth',
  professional: 'pro',
  enterprise: 'comped',
};

/**
 * `Store.plan` enum → plan code for RUNTIME writes and the no-subscription-row
 * fallback, after the 2026-10-05 price lock: the three public plans line up
 * with the three paying feature tiers (starter/professional/enterprise =
 * Basic/Growth/Business, same as each plan's `featureTier`). `free` stays on
 * the hidden legacy row; `comped`/`founding_free` are only ever assigned by
 * name (admin subscription endpoint), never derived from the enum.
 */
export const STORE_PLAN_TO_PLAN_CODE: Record<
  'free' | 'starter' | 'professional' | 'enterprise',
  PlanCode
> = {
  free: 'free',
  starter: 'basic',
  professional: 'growth',
  enterprise: 'business',
};

/** The plan a store with a canceled subscription falls back to. */
export const FALLBACK_PLAN_CODE: PlanCode = 'free';

// ── PLAN_LIMIT_REACHED copy ─────────────────────────────────────────────────
// The API answers 402 with `error.code = 'PLAN_LIMIT_REACHED'` and, in
// `error.details`, `messageKey` (an admin i18n key, `planLimit.<limitKey>`),
// plus this English/Arabic text for clients that do not translate by key.

export const PLAN_LIMIT_ERROR_CODE = 'PLAN_LIMIT_REACHED';

export function planLimitMessageKey(key: GatedLimitKey): string {
  return `planLimit.${key}`;
}

export function planLimitMessage(
  key: GatedLimitKey,
  limit: number | boolean | null,
  lang: 'en' | 'ar'
): string {
  const n = typeof limit === 'number' ? String(limit) : '';
  const en: Record<GatedLimitKey, string> = {
    maxProducts: `Your plan allows up to ${n} products. Upgrade to add more.`,
    maxStaff: `Your plan allows up to ${n} staff members. Upgrade to add more.`,
    maxOrdersPerMonth: `Your plan allows up to ${n} orders per month. Upgrade to keep growing.`,
    maxStorageMb: `Your plan allows up to ${n} MB of storage. Upgrade to add more.`,
    maxStores: `Your plan allows up to ${n} store${n === '1' ? '' : 's'}. Upgrade to add more.`,
    brandingRemoval:
      'Removing the "Powered by Ebda Store" footer is not included in your plan. Upgrade to turn it off.',
    apiAccess:
      'Merchant MCP (running your store from an AI assistant) is not included in your plan. Upgrade to Growth or Business to use it.',
    customDomain:
      'Custom domains are not included in your plan. Upgrade to connect your own domain.',
    abandonedCartAutomation:
      'Abandoned-cart recovery is not included in your plan. Upgrade to turn it on.',
    whatsappAutomation: 'WhatsApp automation is not included in your plan. Upgrade to turn it on.',
    wholesalePricing:
      'Wholesale pricing (quantity tiers, group prices, wholesale accounts) is not included in your plan. Upgrade to Business to use it.',
  };
  const ar: Record<GatedLimitKey, string> = {
    maxProducts: `باقتك تسمح بحد أقصى ${n} منتج. قم بالترقية لإضافة المزيد.`,
    maxStaff: `باقتك تسمح بحد أقصى ${n} من أعضاء الفريق. قم بالترقية لإضافة المزيد.`,
    maxOrdersPerMonth: `باقتك تسمح بحد أقصى ${n} طلب شهرياً. قم بالترقية لمواصلة النمو.`,
    maxStorageMb: `باقتك تسمح بمساحة تخزين حتى ${n} ميجابايت. قم بالترقية لإضافة المزيد.`,
    maxStores: `باقتك تسمح بحد أقصى ${n} متجر. قم بالترقية لإضافة المزيد.`,
    brandingRemoval: 'إزالة شعار «مدعوم من ابدأ ستور» غير متاحة في باقتك. قم بالترقية لإخفائه.',
    apiAccess:
      'تشغيل المتجر من مساعد ذكاء اصطناعي (MCP) غير متاح في باقتك. قم بالترقية إلى باقة النمو أو الأعمال لاستخدامه.',
    customDomain: 'النطاق المخصص غير متاح في باقتك. قم بالترقية لربط نطاقك الخاص.',
    abandonedCartAutomation: 'استرداد السلات المتروكة غير متاح في باقتك. قم بالترقية لتفعيله.',
    whatsappAutomation: 'أتمتة واتساب غير متاحة في باقتك. قم بالترقية لتفعيلها.',
    wholesalePricing:
      'أسعار الجملة (شرائح الكمية وأسعار المجموعات وحسابات الجملة) غير متاحة في باقتك. قم بالترقية إلى باقة الأعمال لاستخدامها.',
  };
  return (lang === 'ar' ? ar : en)[key];
}

const ANALYTICS_RANK: Record<string, number> = { basic: 0, standard: 1, advanced: 2 };

/**
 * The cheapest PUBLIC plan that satisfies a refused limit (upsell target for a
 * 402): a numeric limit needs `need` units (null = unlimited passes), a boolean
 * needs `true`, `analyticsTier` needs at least the named tier. Null when no
 * public plan satisfies it (the UI then links to the plan page without a name).
 */
export function upgradePlanFor(
  limitKey: string,
  need: unknown
): { code: string; nameEn: string; nameAr: string } | null {
  const plans = [...LOCKED_PUBLIC_PLANS].sort(
    (a, b) => (a.priceMonthlyMinor ?? Infinity) - (b.priceMonthlyMinor ?? Infinity)
  );
  if (limitKey === 'merchantMcp') {
    const hit = plans.find(p => planIncludesMerchantMcp(p.code, p.limits));
    return hit ? { code: hit.code, nameEn: hit.nameEn, nameAr: hit.nameAr } : null;
  }
  for (const p of plans) {
    const v = (p.limits as Record<string, unknown>)[limitKey];
    let ok = false;
    if (limitKey === 'analyticsTier') {
      ok = (ANALYTICS_RANK[String(v)] ?? -1) >= (ANALYTICS_RANK[String(need)] ?? 99);
    } else if (typeof v === 'boolean') {
      ok = v === true;
    } else if (v === null) {
      ok = true;
    } else if (typeof v === 'number') {
      ok = typeof need === 'number' ? v >= need : false;
    }
    if (ok) return { code: p.code, nameEn: p.nameEn, nameAr: p.nameAr };
  }
  return null;
}
