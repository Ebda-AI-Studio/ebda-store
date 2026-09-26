/**
 * Display-only mirror of the API's `computeRedemption`
 * (apps/api/src/services/loyalty.service.ts), which is what OrderService.create
 * actually applies. Kept step-for-step identical so the checkout summary shows
 * the total the order will be charged at; `tests/unit/loyalty-estimate-parity.test.ts`
 * runs both over the same inputs and fails on any divergence.
 *
 * The earlier inline estimate assumed `maxRedeemPercentage: 100` because the
 * public loyalty info did not expose it, so under the default 50% cap a
 * customer redeeming a large balance saw a total lower than they paid (#181).
 */
export interface LoyaltyEstimateSettings {
  pointsValue: number;
  minRedeemPoints: number;
  maxRedeemPercentage: number;
}

export interface LoyaltyEstimate {
  /** Points to request from the server (0 = request no redemption). */
  pointsToSend: number;
  /** Discount the server will apply for that request, in fils. */
  loyaltyDiscount: number;
}

export function estimateLoyaltyRedemption(
  settings: LoyaltyEstimateSettings,
  requestedPoints: number,
  redeemableSubtotalFils: number,
  availablePoints: number
): LoyaltyEstimate {
  const none: LoyaltyEstimate = { pointsToSend: 0, loyaltyDiscount: 0 };

  if (!Number.isFinite(requestedPoints) || requestedPoints <= 0) return none;
  if (redeemableSubtotalFils <= 0) return none;

  const pointsValue = Math.max(1, Math.floor(settings.pointsValue || 1));
  let points = Math.min(Math.floor(requestedPoints), Math.max(0, Math.floor(availablePoints)));
  if (points < settings.minRedeemPoints) return none;

  const pct = Math.min(100, Math.max(0, settings.maxRedeemPercentage ?? 100));
  const pctCapFils = Math.floor((redeemableSubtotalFils * pct) / 100);
  const maxDiscountFils = Math.min(redeemableSubtotalFils, pctCapFils);

  let discountFils = points * pointsValue;
  if (discountFils > maxDiscountFils) {
    points = Math.floor(maxDiscountFils / pointsValue);
    discountFils = points * pointsValue;
  }
  if (points < settings.minRedeemPoints || points <= 0 || discountFils <= 0) return none;

  return { pointsToSend: points, loyaltyDiscount: discountFils };
}
