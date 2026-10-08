/**
 * Which `orders.list.confirm.*` description the manual "Refunded" confirm
 * shows (issue 2140). The generic copy promises the refund fan-out — stock
 * back, coupon and loyalty reversed, the customer told. On a CANCELLED order
 * every one of those already ran at cancellation (the `return_stock` /
 * `coupon_reversed` markers and the refund-notification claim short-circuit
 * them), so that copy would promise effects that will not happen.
 */
export function manualRefundDescriptionKey(
  status: string | null | undefined
): 'manualRefundDescription' | 'manualRefundDescriptionCancelled' {
  return status === 'cancelled' ? 'manualRefundDescriptionCancelled' : 'manualRefundDescription';
}

/** How the merchant gave the money back (the API's `refundMethod` enum). */
export const MANUAL_REFUND_METHODS = [
  'cash',
  'instapay',
  'bank_transfer',
  'store_credit',
  'other',
] as const;
export type ManualRefundMethod = (typeof MANUAL_REFUND_METHODS)[number];

export interface ManualRefundInput {
  method: ManualRefundMethod;
  reference: string;
}

/**
 * The PUT /orders/:id/status body for a manual refund. `refundRecorded: true` is the merchant's
 * attestation that the money has already been returned — the server refuses `refunded` without
 * it (409 REFUND_NOT_RECORDED) when no provider refund is on record.
 */
export function manualRefundBody({ method, reference }: ManualRefundInput) {
  const ref = reference.trim();
  return {
    status: 'refunded' as const,
    refundRecorded: true as const,
    refundMethod: method,
    ...(ref ? { refundReference: ref } : {}),
  };
}
