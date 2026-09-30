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
