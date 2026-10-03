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
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  processing: ['shipped', 'delivered', 'cancelled', 'refunded'],
  shipped: ['delivered', 'refunded', 'processing'],
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
  const unpaid = order.paymentStatus !== 'paid';
  if (unpaid && (order.status === 'pending' || order.status === 'cancelled')) {
    return all.filter(s => s !== 'refunded');
  }
  return all;
}
