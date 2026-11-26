/**
 * Coupon vs automatic promotion: they never stack. The larger applies and the promotion wins ties.
 * Mirrors OrderService.create (`primaryDiscount = max(couponDiscount, promotionDiscount)`, promotion gate
 * `appliedPromotionId`). Display only: the server recomputes the real amount at order creation.
 */
export function primaryDiscount(couponDiscount: number, promotionDiscount: number) {
  const discount = Math.max(couponDiscount, promotionDiscount);
  const promotionWins = promotionDiscount > 0 && promotionDiscount >= couponDiscount;
  return { discount, promotionWins, promotionApplied: promotionWins ? promotionDiscount : 0 };
}
