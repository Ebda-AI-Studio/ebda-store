import type { DbClient } from '@force/database';

/**
 * orderEvent.toStatus written by `cancelBackorder` in the SAME transaction
 * that cancels the line. It is the backorder twin of a COMPLETED Return row:
 * the durable, committed-before-the-event record of what one single-line
 * cancellation took back. `metadata` = `{ refundKey, backorderLineId, reason,
 * items: [{ orderItemId, quantity }] }`.
 */
export const BACKORDER_CANCEL_MARKER = 'backorder_line_cancelled';

/** The `order/refunded` partial refundKey for one cancelled backorder line. */
export function backorderRefundKey(backorderLineId: string): string {
  return `backorder:${backorderLineId}`;
}

/**
 * Quantities per order item already taken back from an order by EARLIER
 * item-level reversals — completed returns AND single-line backorder
 * cancellations — excluding the reversal named by `excludeKey` (the one being
 * allocated now).
 *
 * `allocatePartialReturn` allocates the order's discount and tax
 * cumulatively, so every caller has to agree on what came before: the GL
 * posting (`postPartialReturnJournal`), the provider refund
 * (`ReturnService.allocateThisReturn`) and store credit
 * (`ReturnService.computeStoreCreditAmount`). One reader keeps the three
 * equal; a backorder cancellation missing from any one of them lets a later
 * return re-claim units that were already reversed, and the ledger and the
 * card disagree by the discount/tax share.
 *
 * Backorder lines cancelled by the refund FANOUT (a return or refund
 * releasing demand) carry no marker and are not counted here: their
 * quantity is already the Return row's, or the sale was reversed whole.
 *
 * `reasons` maps each reversal key (Return id / backorder refundKey) to its
 * merchant-entered reason, for the journal memo.
 */
export async function loadPriorReversedQty(
  client: DbClient,
  args: { storeId: string; orderId: string; excludeKey?: string }
): Promise<{ prevQty: Map<string, number>; reasons: Map<string, string | null> }> {
  const { storeId, orderId, excludeKey } = args;
  const [completedReturns, backorder] = await Promise.all([
    client.return.findMany({
      where: { storeId, orderId, status: 'completed', type: { in: ['return', 'refund'] } },
      select: {
        id: true,
        reason: true,
        items: { select: { orderItemId: true, quantity: true } },
      },
    }),
    loadBackorderCancelledQty(client, { storeId, orderId, excludeKey }),
  ]);

  const prevQty = backorder.qty;
  const reasons = backorder.reasons;
  for (const ret of completedReturns) {
    reasons.set(ret.id, ret.reason ?? null);
    if (ret.id === excludeKey) continue;
    for (const it of ret.items) {
      prevQty.set(it.orderItemId, (prevQty.get(it.orderItemId) ?? 0) + it.quantity);
    }
  }
  return { prevQty, reasons };
}

/**
 * Units per order item taken back by single-line backorder cancellations
 * (their `backorder_line_cancelled` markers), excluding `excludeKey`. Those
 * units never shipped, so they are also not returnable —
 * `ReturnService.create` counts them against a line's returnable quantity.
 */
export async function loadBackorderCancelledQty(
  client: DbClient,
  args: { storeId: string; orderId: string; excludeKey?: string }
): Promise<{ qty: Map<string, number>; reasons: Map<string, string | null> }> {
  const { storeId, orderId, excludeKey } = args;
  const markers = await client.orderEvent.findMany({
    where: { storeId, orderId, toStatus: BACKORDER_CANCEL_MARKER },
    select: { metadata: true },
  });
  const qty = new Map<string, number>();
  const reasons = new Map<string, string | null>();
  for (const m of markers) {
    const meta = m.metadata as {
      refundKey?: unknown;
      reason?: unknown;
      items?: Array<{ orderItemId?: unknown; quantity?: unknown }>;
    } | null;
    if (typeof meta?.refundKey !== 'string') continue;
    reasons.set(meta.refundKey, typeof meta.reason === 'string' ? meta.reason : null);
    if (meta.refundKey === excludeKey || !Array.isArray(meta.items)) continue;
    for (const it of meta.items) {
      if (typeof it?.orderItemId !== 'string' || typeof it?.quantity !== 'number') continue;
      qty.set(it.orderItemId, (qty.get(it.orderItemId) ?? 0) + it.quantity);
    }
  }
  return { qty, reasons };
}
