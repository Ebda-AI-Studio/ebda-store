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
  /** Refund via the provider: paid, a refundable online payment, not refunded. */
  showRefundViaProvider: boolean;
  /** Refresh refund status: a provider-issued refund exists to ask about. */
  showRefreshRefundStatus: boolean;
}

export function orderActionVisibility(order: OrderActionInput): OrderActionVisibility {
  const payments = order.payments ?? [];
  const showMarkPaid = order.paymentStatus !== 'paid';
  // Paid status on an order with a provider-payment row MUST come from the
  // provider (webhook / verify), never a manual flip — financial integrity.
  const hasProviderPayment = payments.some(
    p => p.provider !== 'cod' && !!(p.paymentUrl || p.paymentLink || p.transactionId)
  );
  // A partially refunded payment still has a refundable balance — the API's
  // refund-via-provider accepts it (#1360), so the button must not vanish
  // after the first partial return.
  const refundableOnlinePayment = payments.some(
    p =>
      (p.status === 'completed' || p.status === 'partially_refunded') &&
      !!p.transactionId &&
      p.provider !== 'cod'
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
    showRefundViaProvider:
      order.paymentStatus === 'paid' && refundableOnlinePayment && order.status !== 'refunded',
    showRefreshRefundStatus: refundedPayment,
  };
}
