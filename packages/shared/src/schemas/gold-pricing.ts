/**
 * Zod at every edge of gold-rate pricing (Rulings B5-13, B5-16, B5-19, B5-20). Strict objects: an
 * unknown key is refused, never stripped. Bounds mirror the formula's (`commerce/gold-price.ts`) and
 * the migration's CHECK constraints, so a value the API accepts is a value the database accepts.
 */
import { z } from 'zod';
import {
  GOLD_MAKING_VALUE_MAX,
  GOLD_MARGIN_BPS_MAX,
  GOLD_MARGIN_BPS_MIN,
  GOLD_RATE_MAX,
  GOLD_RATE_MIN,
  GOLD_WEIGHT_MG_MAX,
  GOLD_WEIGHT_MG_MIN,
} from '../commerce/gold-price';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const karat = z.union([z.literal(24), z.literal(21), z.literal(18)]);
const roundingStep = z.union([z.literal(1), z.literal(100), z.literal(500), z.literal(1000)]);
const makingType = z.enum(['fixed', 'per_gram']);
const mode = z.enum(['fixed', 'gold_rate']);

export const MAX_AGE_MINUTES_MIN = 60;
/** 26 hours: the default AND the ceiling (Ruling B5-16). */
export const MAX_AGE_MINUTES_MAX = 1560;

/** The pricing spec of one gold piece. */
export const goldPriceSpecSchema = z
  .object({
    karat,
    weightMg: int(GOLD_WEIGHT_MG_MIN, GOLD_WEIGHT_MG_MAX),
    makingChargeType: makingType,
    makingChargeValue: int(0, GOLD_MAKING_VALUE_MAX),
    marginBps: int(GOLD_MARGIN_BPS_MIN, GOLD_MARGIN_BPS_MAX),
  })
  .strict();

const compareAndDiscount = {
  compareAtPrice: z.number().int().nullable().optional(),
  discountType: z.string().nullable().optional(),
  discountValue: z.number().nullable().optional(),
};
const hasDiscount = (v: {
  compareAtPrice?: number | null;
  discountType?: string | null;
  discountValue?: number | null;
}) =>
  (v.compareAtPrice ?? null) !== null ||
  ((v.discountType ?? null) !== null && v.discountType !== 'none') ||
  (v.discountValue ?? null) !== null;

/**
 * A product's pricing slice. Gold mode needs a complete spec (Ruling B5-13) and forbids
 * compare-at / discount fields (Ruling B5-19: sales run through coupons and promotions).
 */
/**
 * A weight a merchant EDITS: whole 10 mg steps (two decimals of a gram, what the editor types and shows). The
 * engine and the stored snapshot accept any milligram; the edge refuses 995 so no weight shows as a rounded one.
 */
const editableWeightMg = int(GOLD_WEIGHT_MG_MIN, GOLD_WEIGHT_MG_MAX).refine(n => n % 10 === 0, {
  message: 'weight must be in steps of 0.01 g',
});

export const productGoldPricingInputSchema = z
  .object({
    pricingMode: mode,
    karat: karat.nullable().optional(),
    weightMg: editableWeightMg.nullable().optional(),
    makingChargeType: makingType.nullable().optional(),
    makingChargeValue: int(0, GOLD_MAKING_VALUE_MAX).nullable().optional(),
    marginBps: int(GOLD_MARGIN_BPS_MIN, GOLD_MARGIN_BPS_MAX).optional(),
    ...compareAndDiscount,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.pricingMode !== 'gold_rate') return;
    for (const k of ['karat', 'weightMg', 'makingChargeType', 'makingChargeValue'] as const)
      if (v[k] === undefined || v[k] === null)
        ctx.addIssue({
          code: 'custom',
          path: [k],
          message: `${k} is required for gold-rate pricing`,
        });
    if (hasDiscount(v))
      ctx.addIssue({
        code: 'custom',
        path: ['compareAtPrice'],
        message:
          'A gold-priced product cannot carry a compare-at price or a discount (use a coupon)',
      });
  });

/** A variant's slice: `pricingMode` and every spec field may be null = inherit the product (Ruling B5-13). */
export const variantGoldPricingInputSchema = z
  .object({
    pricingMode: mode.nullable(),
    karat: karat.nullable().optional(),
    weightMg: editableWeightMg.nullable().optional(),
    makingChargeType: makingType.nullable().optional(),
    makingChargeValue: int(0, GOLD_MAKING_VALUE_MAX).nullable().optional(),
    marginBps: int(GOLD_MARGIN_BPS_MIN, GOLD_MARGIN_BPS_MAX).nullable().optional(),
    ...compareAndDiscount,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.pricingMode === 'gold_rate' && hasDiscount(v))
      ctx.addIssue({
        code: 'custom',
        path: ['compareAtPrice'],
        message:
          'A gold-priced variant cannot carry a compare-at price or a discount (use a coupon)',
      });
  });

/** 1..3 rates, one per karat. A change over the store's gate needs `confirm: true` (Ruling B5-20). */
export const goldRateInputSchema = z
  .object({
    rates: z
      .array(z.object({ karat, ratePerGram: int(GOLD_RATE_MIN, GOLD_RATE_MAX) }).strict())
      .min(1)
      .max(3)
      .refine(a => new Set(a.map(r => r.karat)).size === a.length, {
        message: 'One rate per karat',
      }),
    confirm: z.boolean().optional(),
  })
  .strict();

export const goldRateSettingsSchema = z
  .object({
    enabled: z.boolean(),
    feedEnabled: z.boolean(),
    feedPremiumBps: int(-1000, 1000),
    maxAgeMinutes: int(MAX_AGE_MINUTES_MIN, MAX_AGE_MINUTES_MAX),
    jumpConfirmBps: int(100, 5000).default(500),
    roundingStep,
    showBreakdown: z.boolean().default(false),
  })
  .strict();

/** What an order line stores about how its price was made (`order_items.gold_snapshot`). */
export const goldLineSnapshotSchema = z
  .object({
    v: z.literal(1),
    karat,
    weightMg: int(GOLD_WEIGHT_MG_MIN, GOLD_WEIGHT_MG_MAX),
    ratePerGram: int(GOLD_RATE_MIN, GOLD_RATE_MAX),
    rateId: z.string().min(1).max(80),
    rateAppliedAt: z.string().datetime(),
    makingChargeType: makingType,
    makingChargeValue: int(0, GOLD_MAKING_VALUE_MAX),
    marginBps: int(GOLD_MARGIN_BPS_MIN, GOLD_MARGIN_BPS_MAX),
    roundingStep,
    unitPrice: int(1, 2_147_483_647),
  })
  .strict();

/**
 * What the storefront payload carries for a gold piece. NO `marginBps`, `rateId` or `source`: the
 * margin is the merchant's business, the rate row and where it came from are not the shopper's.
 */
export const publicGoldPricingSchema = z
  .object({
    karat,
    weightMg: int(GOLD_WEIGHT_MG_MIN, GOLD_WEIGHT_MG_MAX),
    ratePerGram: int(GOLD_RATE_MIN, GOLD_RATE_MAX),
    rateAppliedAt: z.string().datetime(),
    maxAgeMinutes: int(MAX_AGE_MINUTES_MIN, MAX_AGE_MINUTES_MAX),
    breakdown: z
      .object({ metalValue: int(0, 2_147_483_647), makingValue: int(0, 2_147_483_647) })
      .strict()
      .optional(),
  })
  .strict();

export type GoldPriceSpecInput = z.infer<typeof goldPriceSpecSchema>;
export type ProductGoldPricingInput = z.infer<typeof productGoldPricingInputSchema>;
export type VariantGoldPricingInput = z.infer<typeof variantGoldPricingInputSchema>;
export type GoldRateInput = z.infer<typeof goldRateInputSchema>;
export type GoldRateSettings = z.infer<typeof goldRateSettingsSchema>;
export type GoldLineSnapshot = z.infer<typeof goldLineSnapshotSchema>;
export type PublicGoldPricing = z.infer<typeof publicGoldPricingSchema>;
