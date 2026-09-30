import { z } from 'zod';

/**
 * Analytics + insights contracts shared by the API
 * (`apps/api/src/routes/analytics.routes.ts`, `insights.routes.ts`) and the
 * admin pages that read them (`apps/admin/src/app/stores/[id]/analytics`,
 * `.../insights/products`). One definition so the two sides cannot drift the
 * way the product-velocity page did (it was built against six fields the
 * route never returned — audit 2026-09-30, finding 2).
 */

/** The 9 presets the admin DateRangePicker offers, in picker order. */
export const ANALYTICS_PERIOD_PRESETS = [
  'today',
  'yesterday',
  'last_7',
  'last_30',
  'last_90',
  'this_month',
  'last_month',
  'this_year',
  'custom',
] as const;

/** Pre-2026-05 values still accepted from saved URL params / state. */
export const LEGACY_ANALYTICS_PERIODS = ['week', 'month', 'year'] as const;

export const ANALYTICS_PERIODS = [
  ...ANALYTICS_PERIOD_PRESETS,
  ...LEGACY_ANALYTICS_PERIODS,
] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const analyticsPeriodSchema = z.enum(ANALYTICS_PERIODS);

/** Bucket size of the sales chart. */
export const SALES_GRANULARITIES = ['day', 'week', 'month'] as const;
export type SalesGranularity = (typeof SALES_GRANULARITIES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Up to this many days → one bar per day (≤ 46 bars). */
export const SALES_DAILY_MAX_DAYS = 45;
/** Up to this many days → one bar per week (≤ 28 bars); beyond → per month. */
export const SALES_WEEKLY_MAX_DAYS = 190;

/**
 * Picks the sales-chart bucket from the length of the range, not from the
 * preset name, so a custom range gets the same treatment as a preset of the
 * same length: `this_year` in September is ~9 monthly bars, not ~270 daily.
 */
export function pickSalesGranularity(startDate: Date, endDate: Date): SalesGranularity {
  const days = (endDate.getTime() - startDate.getTime()) / DAY_MS;
  if (days <= SALES_DAILY_MAX_DAYS) return 'day';
  if (days <= SALES_WEEKLY_MAX_DAYS) return 'week';
  return 'month';
}

/** Trailing window, in days, the product-velocity ranking is computed over. */
export const PRODUCT_VELOCITY_WINDOW_DAYS = 30;

/**
 * One row of `GET /stores/:storeId/insights/products`. Ranked by units sold in
 * the trailing 30 days (paid orders).
 *
 * Nullable fields are UNKNOWN, never zero: `stockOnHand` is null when the
 * product does not track inventory (or was deleted), `costPriceFils` when no
 * cost price is set, `avgSellingPriceFils` when no units sold in the window.
 */
export const productVelocityRowSchema = z.object({
  rank: z.number().int().positive(),
  productId: z.string(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  nameAr: z.string().nullable(),
  unitsSold7d: z.number().int().nonnegative(),
  unitsSold30d: z.number().int().nonnegative(),
  velocityPerDay: z.number().nonnegative(),
  avgSellingPriceFils: z.number().int().nonnegative().nullable(),
  stockOnHand: z.number().int().nullable(),
  costPriceFils: z.number().int().nonnegative().nullable(),
});
export type ProductVelocityRow = z.infer<typeof productVelocityRowSchema>;

export const productVelocityResponseSchema = z.object({
  windowDays: z.literal(PRODUCT_VELOCITY_WINDOW_DAYS),
  products: z.array(productVelocityRowSchema),
});
export type ProductVelocityResponse = z.infer<typeof productVelocityResponseSchema>;
