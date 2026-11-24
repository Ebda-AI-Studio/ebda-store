/**
 * Piastres handed back on an order across every recorded channel, for the admin payment card ("Refunded X").
 *
 * `payments.refundedAmount` carries provider / InstaPay / recorded-cash refunds. A partial refund the MERCHANT books on a
 * Durable Object store (refundBook with an amount) is only an order event (`partial_refund_recorded`, metadata.amount):
 * it is not mirrored on the payment row, so the card showed no refund line for it. The same classification as the DO's
 * one refundable balance (packages/repo/src/do/refundable.ts): an event flagged `external`, or whose refundKey is a
 * provider refund id on a payment's `metadata.refundEventIds`, is already inside `payments.refundedAmount`.
 *
 * A refund made through the RETURNS path (a completed return) is a third channel: a gateway return moves
 * `payments.refundedAmount` (already counted), but a cash / bank / manual payout or store credit does not, and its
 * `partial_return_restored` event is flagged `external`, so without this the card ignored it. Counted here exactly as the DO's
 * one refundable balance does (packages/repo/src/do/refundable.ts): completed returns whose method is not a gateway method.
 */
interface RefundEventLike {
  metadata?: unknown;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The refund methods that go through the payment provider: those amounts are already in `payments.refundedAmount`. */
const GATEWAY_RETURN_METHODS = ['original', 'gateway', 'original_payment'];

export function refundedTotal(
  payments: ReadonlyArray<{ refundedAmount?: number | null; metadata?: unknown }>,
  events: ReadonlyArray<RefundEventLike>,
  completedReturns: ReadonlyArray<{
    refundMethod?: string | null;
    refundAmount?: number | null;
    type?: string | null;
  }> = []
): number {
  const mirrored = new Set<string>();
  for (const p of payments) {
    const ids = (p.metadata as { refundEventIds?: unknown } | null)?.refundEventIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') mirrored.add(id);
  }
  let booked = 0;
  for (const e of events) {
    const m = (e.metadata ?? null) as {
      amount?: unknown;
      external?: unknown;
      refundKey?: unknown;
    } | null;
    if (!m || m.external === true) continue;
    if (typeof m.refundKey === 'string' && mirrored.has(m.refundKey)) continue;
    booked += Math.max(0, num(m.amount));
  }
  const viaReturns = completedReturns.reduce(
    (s, r) =>
      r.type === 'exchange' || GATEWAY_RETURN_METHODS.includes(r.refundMethod ?? '')
        ? s
        : s + Math.max(0, num(r.refundAmount)),
    0
  );
  return payments.reduce((s, p) => s + Math.max(0, num(p.refundedAmount)), 0) + booked + viaReturns;
}
