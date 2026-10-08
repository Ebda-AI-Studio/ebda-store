/**
 * Allowed order status transitions, as the merchant surfaces offer them.
 *
 * The API enforces its own typed copy (`VALID_ORDER_TRANSITIONS` in
 * apps/api/src/services/order-status-machine.ts); a parity test pins the two
 * together. The admin order list, the admin order page and the orders PWA all
 * read THIS map, so a transition the API opens is offered on every surface at
 * once (#1936: the PWA kept a stale copy with no `cancelled` key, so a paid,
 * cancelled order could not be marked refunded from orders.ebda.app).
 *
 * Admins can jump ahead (confirmed → delivered for same-day COD); backwards
 * moves are blocked. `refunded` is reachable from every non-terminal state,
 * including `cancelled` (a paid order cancelled by staff still owes a refund,
 * PR #770). `shipped → processing` models a cancelled carrier shipment.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  // InstaPay manual orders (SP6): never ship from here. Only the dedicated
  // confirm (-> confirmed, with the payment recorded) or a cancel/expiry leaves
  // this state, so processing/shipped/delivered are deliberately absent.
  awaiting_payment_confirmation: ['confirmed', 'cancelled'],
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  processing: ['shipped', 'delivered', 'cancelled', 'refunded'],
  // `shipped → cancelled` = return to origin (ruling MONEYB-5).
  shipped: ['delivered', 'refunded', 'processing', 'cancelled'],
  delivered: ['refunded'],
  cancelled: ['refunded'],
  refunded: [],
};

/**
 * The status options to offer for one order. `refunded` from pending or
 * cancelled only applies to an order that captured a payment; the API rejects
 * it otherwise (ORDER_NOT_PAID), so it is not offered.
 */
export function orderStatusOptions(order: {
  status: string;
  paymentStatus?: string | null;
}): string[] {
  const all = [...(ORDER_STATUS_TRANSITIONS[order.status] ?? [])];
  // An awaiting-confirmation order becomes `confirmed` only through the
  // "payment received" action (it must also record the payment), never from the
  // generic status picker.
  if (order.status === 'awaiting_payment_confirmation') return all.filter(s => s !== 'confirmed');
  const unpaid = order.paymentStatus !== 'paid';
  if (unpaid && (order.status === 'pending' || order.status === 'cancelled')) {
    return all.filter(s => s !== 'refunded');
  }
  return all;
}
