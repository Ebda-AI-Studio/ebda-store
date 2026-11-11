/**
 * Targeting/discount math: the single source lives in `@ebda/shared` (`commerce/coupon-math.ts`, Ruling PRICE-1) and is
 * shared with the Durable Object twins; this module only re-exports it so existing imports keep working.
 */
export {
  matchesTargeting,
  computeDiscount,
  type CartItemForTargeting,
  type TargetingCtx,
  type Targeting,
  type TargetingResult,
} from '@ebda/shared';
