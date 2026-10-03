import { z } from 'zod';

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
const ceiling = z.number().int().min(0).max(2_147_483_647).nullable();
const bps = z.number().int().min(0).max(10_000);

export const planLimitsSchema = z
  .object({
    maxProducts: ceiling,
    maxStaff: ceiling,
    maxOrdersPerMonth: ceiling,
    maxStorageMb: ceiling,
    customDomain: z.boolean(),
    platformFeeBps: bps,
    codPlatformFeeBps: bps.default(0),
    abandonedCartAutomation: z.boolean(),
    whatsappAutomation: z.boolean(),
  })
  .strict();

export type PlanLimits = z.infer<typeof planLimitsSchema>;
export type PlanLimitKey = keyof PlanLimits;

/** Limits that are a count ceiling (null = unlimited). */
export const NUMERIC_LIMIT_KEYS = [
  'maxProducts',
  'maxStaff',
  'maxOrdersPerMonth',
  'maxStorageMb',
] as const satisfies readonly PlanLimitKey[];
export type NumericLimitKey = (typeof NUMERIC_LIMIT_KEYS)[number];

/** Limits that are an on/off capability. */
export const BOOLEAN_LIMIT_KEYS = [
  'customDomain',
  'abandonedCartAutomation',
  'whatsappAutomation',
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

// ── Seed plans ───────────────────────────────────────────────────────────────
// PLACEHOLDER numbers from docs/ebda/research/pricing-and-packaging.md (ranges,
// not market-validated) and NO prices — Ahmad sets both in the super-admin
// Plans page. The migration seeds these exact rows (a unit test pins parity).

export type PlanCode = 'free' | 'growth' | 'pro' | 'comped';

export interface PlanSeed {
  code: PlanCode;
  nameEn: string;
  nameAr: string;
  sort: number;
  isPublic: boolean;
  /** The legacy `StorePlan` enum tier whose PLAN_BASELINE feature set this plan inherits. */
  featureTier: 'free' | 'starter' | 'professional' | 'enterprise';
  limits: PlanLimits;
}

export const DEFAULT_PLAN_SEEDS: readonly PlanSeed[] = [
  {
    code: 'free',
    nameEn: 'Free',
    nameAr: 'مجاني',
    sort: 10,
    isPublic: true,
    featureTier: 'free',
    limits: {
      maxProducts: 50,
      maxStaff: 1,
      maxOrdersPerMonth: 100,
      maxStorageMb: 500,
      customDomain: false,
      platformFeeBps: 150,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: false,
      whatsappAutomation: false,
    },
  },
  {
    code: 'growth',
    nameEn: 'Growth',
    nameAr: 'النمو',
    sort: 20,
    isPublic: true,
    featureTier: 'starter',
    limits: {
      maxProducts: 1000,
      maxStaff: 3,
      maxOrdersPerMonth: 1500,
      maxStorageMb: 5000,
      customDomain: true,
      platformFeeBps: 100,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: true,
    },
  },
  {
    code: 'pro',
    nameEn: 'Pro',
    nameAr: 'احترافي',
    sort: 30,
    isPublic: true,
    featureTier: 'professional',
    limits: {
      maxProducts: 5000,
      maxStaff: 10,
      maxOrdersPerMonth: 7000,
      maxStorageMb: 20000,
      customDomain: true,
      platformFeeBps: 50,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: true,
    },
  },
  {
    code: 'comped',
    nameEn: 'Comped',
    nameAr: 'مجاني بمنحة',
    sort: 90,
    isPublic: false,
    featureTier: 'enterprise',
    limits: {
      maxProducts: null,
      maxStaff: null,
      maxOrdersPerMonth: null,
      maxStorageMb: null,
      customDomain: true,
      platformFeeBps: 0,
      codPlatformFeeBps: 0,
      abandonedCartAutomation: true,
      whatsappAutomation: true,
    },
  },
];

/**
 * FWB's `Store.plan` enum value → Ebda plan code. Used by the migration's
 * backfill and by the runtime fallback for a store that has no subscription
 * row yet. `enterprise` → `comped`: nobody ever paid for it (FWB's enterprise
 * was an admin-granted "everything on"), and `comped` is exactly that.
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
    customDomain:
      'Custom domains are not included in your plan. Upgrade to connect your own domain.',
    abandonedCartAutomation:
      'Abandoned-cart recovery is not included in your plan. Upgrade to turn it on.',
    whatsappAutomation: 'WhatsApp automation is not included in your plan. Upgrade to turn it on.',
  };
  const ar: Record<GatedLimitKey, string> = {
    maxProducts: `باقتك تسمح بحد أقصى ${n} منتج. قم بالترقية لإضافة المزيد.`,
    maxStaff: `باقتك تسمح بحد أقصى ${n} من أعضاء الفريق. قم بالترقية لإضافة المزيد.`,
    maxOrdersPerMonth: `باقتك تسمح بحد أقصى ${n} طلب شهرياً. قم بالترقية لمواصلة النمو.`,
    maxStorageMb: `باقتك تسمح بمساحة تخزين حتى ${n} ميجابايت. قم بالترقية لإضافة المزيد.`,
    customDomain: 'النطاق المخصص غير متاح في باقتك. قم بالترقية لربط نطاقك الخاص.',
    abandonedCartAutomation: 'استرداد السلات المتروكة غير متاح في باقتك. قم بالترقية لتفعيله.',
    whatsappAutomation: 'أتمتة واتساب غير متاحة في باقتك. قم بالترقية لتفعيلها.',
  };
  return (lang === 'ar' ? ar : en)[key];
}
