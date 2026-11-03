/**
 * QA-PRICE-ZERO-1: nothing the shopper can order may cost 0, and no coupon may be a silent no-op.
 *
 * - An ACTIVE product (or active variant) with a fixed price must have price > 0. A draft or archived row may be 0
 *   (a placeholder). A gold-rate row is exempt: its price is written only by the repricer (Ruling B5-13) and a gold
 *   row with no rate stays draft, so the repricer's own writes must never trip this guard.
 * - A percentage or fixed coupon must have value > 0. A 100% coupon is a legitimate giveaway tool and stays allowed (a
 *   percentage above 100 is meaningless and refused; a fixed coupon is capped at the order subtotal at checkout).
 *   `free_shipping` has no value.
 *
 * Pure functions, one place: product create/update/bulk/import, variant create/update and coupon create/update all call
 * these, so the rule cannot drift between paths.
 */
import { AppError } from '../middleware/error-handler';

export const PRICE_REQUIRED_MESSAGE = {
  messageEn:
    'An active product must have a price above zero. Set a price, or keep the product as a draft.',
  messageAr: 'المنتج الفعّال لازم يكون له سعر أكبر من صفر. حدّد السعر أو سيب المنتج مسودة.',
} as const;

export const COUPON_VALUE_MESSAGE = {
  messageEn: 'A discount coupon needs a value above zero (a percentage coupon is 1% to 100%).',
  messageAr: 'كوبون الخصم لازم قيمته أكبر من صفر (والنسبة المئوية من 1% لـ 100%).',
} as const;

export function priceRequiredError(): AppError {
  return new AppError(
    400,
    'PRICE_REQUIRED_FOR_ACTIVE',
    PRICE_REQUIRED_MESSAGE.messageEn,
    PRICE_REQUIRED_MESSAGE
  );
}

export function couponValueError(): AppError {
  return new AppError(
    400,
    'COUPON_VALUE_REQUIRED',
    COUPON_VALUE_MESSAGE.messageEn,
    COUPON_VALUE_MESSAGE
  );
}

/** True when this product row would be orderable for free. Variant products are judged on their variants. */
export function isFreeActiveProduct(p: {
  status?: string | null;
  price?: number | null;
  pricingMode?: string | null;
  hasVariants?: boolean | null;
}): boolean {
  if (p.status !== 'active') return false;
  if (p.pricingMode === 'gold_rate') return false;
  if (p.hasVariants) return false;
  return !(typeof p.price === 'number' && p.price > 0);
}

export function assertActiveProductPrice(p: Parameters<typeof isFreeActiveProduct>[0]): void {
  if (isFreeActiveProduct(p)) throw priceRequiredError();
}

/** A variant's effective price is its own override, else the product's. */
export function assertActiveVariantPrice(v: {
  isActive?: boolean | null;
  price?: number | null;
  productPrice?: number | null;
  productPricingMode?: string | null;
  variantPricingMode?: string | null;
}): void {
  if (v.isActive === false) return;
  if (v.productPricingMode === 'gold_rate' || v.variantPricingMode === 'gold_rate') return;
  const effective = v.price ?? v.productPrice ?? 0;
  if (!(effective > 0)) throw priceRequiredError();
}

export function isValidCouponValue(type: string | null | undefined, value: number): boolean {
  if (type === 'free_shipping') return true;
  if (!Number.isFinite(value) || value <= 0) return false;
  return type === 'percentage' ? value <= 100 : true;
}

export function assertCouponValue(type: string | null | undefined, value: number): void {
  if (!isValidCouponValue(type, value)) throw couponValueError();
}
