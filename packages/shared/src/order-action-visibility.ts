/**
 * Which money actions an order-detail screen may offer.
 *
 * The admin order page and the orders PWA each carried these five booleans as
 * verbatim copies (#1908), so a gating fix or regression on one surface never
 * reached the other — and only the admin copy had render coverage. One pure
 * helper, tested once, consumed by both ActionFooters.
 */
export interface OrderActionPayment {
  provider: string;
  status: string;
  transactionId?: string | null;
  paymentUrl?: string | null;
  paymentLink?: string | null;
  /** Piastres. Needed (with refundedAmount) for refundViaProviderRemaining. */
  amount?: number | null;
  refundedAmount?: number | null;
  createdAt?: string | Date | null;
}

export interface OrderActionInput {
  status: string;
  paymentStatus: string;
  payments?: readonly OrderActionPayment[] | null;
}

export interface OrderActionVisibility {
  /** Order not yet paid: payment-link / refresh-payment affordances apply. */
  showMarkPaid: boolean;
  /** A provider (non-COD) payment row exists — paid status must come from it. */
  hasProviderPayment: boolean;
  /** The MANUAL mark-paid toggle: unpaid AND no provider row (COD/no row). */
  showManualMarkPaid: boolean;
  /** InstaPay: the order waits for the merchant's "payment received" confirmation. */
  showConfirmInstapay: boolean;
  /** Refund via the provider: paid, a refundable online payment, not refunded. */
  showRefundViaProvider: boolean;
  /** Refresh refund status: a provider-issued refund exists to ask about. */
  showRefreshRefundStatus: boolean;
}

/**
 * What `POST /orders/:id/refund-via-provider` would send, in piastres: the NEWEST
 * `completed` / `partially_refunded` payment's `amount - refundedAmount` — the
 * row and figure that route and PaymentService.refund use when no amount is
 * given (#2069). The order total overstates it after a partial refund.
 * Null when the payload does not carry the figures (an older API), so the
 * caller says "the remaining balance" instead of quoting a number it cannot
 * stand behind.
 */
export function refundViaProviderRemaining(order: OrderActionInput): number | null {
  const candidates = (order.payments ?? []).filter(
    p => p.status === 'completed' || p.status === 'partially_refunded'
  );
  if (candidates.length === 0) return null;
  const ts = (p: OrderActionPayment) => (p.createdAt ? new Date(p.createdAt).getTime() : 0);
  const newest = candidates.reduce((a, b) => (ts(b) > ts(a) ? b : a));
  if (typeof newest.amount !== 'number' || typeof newest.refundedAmount !== 'number') return null;
  return Math.max(0, newest.amount - newest.refundedAmount);
}

export function orderActionVisibility(order: OrderActionInput): OrderActionVisibility {
  const payments = order.payments ?? [];
  // An InstaPay order awaiting confirmation is paid ONLY through the dedicated
  // confirm: no payment link, no provider refresh, no manual mark-paid.
  const awaitingInstapay =
    order.status === 'awaiting_payment_confirmation' &&
    payments.some(p => p.provider === 'instapay' && p.status === 'pending');
  // A refunded order is settled the other way: the API refuses to mark it paid (ORDER_NOT_PAYABLE) and its
  // paymentStatus is `refunded`, not `paid`, so the button must not come back after a refund. (A cancelled online
  // order keeps it: Refresh payment recovers one paid late on a still-live invoice.)
  const refunded = order.paymentStatus === 'refunded' || order.status === 'refunded';
  const showMarkPaid = order.paymentStatus !== 'paid' && !refunded && !awaitingInstapay;
  // Paid status on an order with a provider-payment row MUST come from the
  // provider (webhook / verify), never a manual flip — financial integrity.
  // COD and InstaPay have no provider behind them: their paid status and any
  // refund are the merchant's own actions, never a provider call.
  const isManual = (p: OrderActionPayment) => p.provider === 'cod' || p.provider === 'instapay';
  const hasProviderPayment = payments.some(
    p => !isManual(p) && !!(p.paymentUrl || p.paymentLink || p.transactionId)
  );
  // A partially refunded payment still has a refundable balance — the API's
  // refund-via-provider accepts it (#1360), so the button must not vanish
  // after the first partial return.
  const refundableOnlinePayment = payments.some(
    p =>
      (p.status === 'completed' || p.status === 'partially_refunded') &&
      !!p.transactionId &&
      !isManual(p)
  );
  const refundedPayment = payments.some(
    p =>
      (p.status === 'refunded' || p.status === 'partially_refunded') &&
      !!p.transactionId &&
      p.provider !== 'cod'
  );
  return {
    showMarkPaid,
    hasProviderPayment,
    showManualMarkPaid: showMarkPaid && !hasProviderPayment,
    showConfirmInstapay: awaitingInstapay,
    showRefundViaProvider:
      order.paymentStatus === 'paid' && refundableOnlinePayment && order.status !== 'refunded',
    showRefreshRefundStatus: refundedPayment,
  };
}
