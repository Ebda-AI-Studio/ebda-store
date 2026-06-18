/**
 * Pure decision helper for the order cancel/refund side-effects gate.
 *
 * `OrderService.updateStatus` must only run the refund reversal
 * (`applyRefundEffects` → inventory restore + coupon decrement + affiliate
 * reversal + the `order/refunded` fanout that pushes the merchant the
 * "Refund issued" notification + emails the customer the refund) when the
 * order ACTUALLY captured money. Cancelling an UNPAID order — e.g. an online
 * order whose payment link was never completed, or the daily auto-cancel of a
 * stale unpaid order — must NOT fire a refund: there was never any money to
 * give back, and firing it sent merchants a spurious "Refund issued" push.
 *
 * Extracted into its own dependency-free module so the gating logic is unit
 * testable without importing the full OrderService graph (Prisma, Inngest,
 * a dozen services). Keep it pure: inputs → boolean, no side effects.
 */

/** Minimal shape of the order needed to decide if it captured a payment. */
export interface CapturedPaymentInput {
  /** Durable order-level payment status. */
  paymentStatus?: string | null;
  /** Payment rows attached to the order (status checked for 'completed'). */
  payments?: Array<{ status?: string | null }> | null;
}

/**
 * True when the order has a CAPTURED payment — durable `paymentStatus === 'paid'`
 * OR any Payment row reached 'completed'. The two are kept in lock-step, but we
 * check both so a partially-reconciled order is never mis-classified as unpaid.
 */
export function hasCapturedPayment(order: CapturedPaymentInput): boolean {
  return (
    order.paymentStatus === 'paid' || (order.payments?.some(p => p.status === 'completed') ?? false)
  );
}

/**
 * Whether `updateStatus` should run the refund reversal + "Refund issued"
 * effects for a given target status. Only cancel/refund transitions trigger
 * refund effects, and only when the order actually captured money.
 */
export function shouldApplyRefundEffects(status: string, order: CapturedPaymentInput): boolean {
  return (status === 'cancelled' || status === 'refunded') && hasCapturedPayment(order);
}
