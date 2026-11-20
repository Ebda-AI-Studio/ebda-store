import { ORDER_STATUS_TRANSITIONS } from '../../../shared/src/order-status-transitions';
import { issueSaleDocument } from './fiscal';
import { addOrderEvent, addPaymentEvent } from './payments';
import { MoneyError, type SyncSql } from './sync-sql';

/**
 * The order status transitions that move no stock, coupon, wallet or loyalty balance (INFRA-CF-1 PR D2b-4, Ruling CF-FINAL-1):
 * `pending`/`confirmed`/`processing`/`shipped`/`delivered`. The twin of the status write in `OrderService.updateStatus`:
 * state machine, the fanout arming (`status_fanout_*`, so the stuck-fanout sweep can find an undelivered transition),
 * `delivered_at` stamped once, the cash-on-delivery settlement on delivery (MONEYB-7) and the audit event. `cancelled` and
 * `refunded` keep their own operations (`cancelOrder`, `refundOrder`): they reverse money.
 */
export const PLAIN_STATUSES: readonly string[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
];

export interface OrderStatusResult {
  orderId: string;
  from: string;
  status: string;
  /** the transition's arming time (the ordering key of the `order/status-changed` event) */
  requestedAt: number;
  /** the COD payment this delivery settled, if any: the Worker fires the post-payment fan-out for it */
  codSettled: string | null;
  orderNumber: string;
  customerId: string | null;
}

export function changeOrderStatus(
  db: SyncSql,
  a: { storeId: string; orderId: string; status: string; now?: number }
): OrderStatusResult {
  if (!PLAIN_STATUSES.includes(a.status))
    throw new MoneyError('BAD_ARGS', `status ${a.status}`, 400);
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = db.all(
      'SELECT id, status, payment_status, order_number, customer_id FROM orders WHERE id = ? AND store_id = ?',
      [a.orderId, a.storeId]
    )[0];
    if (!o) throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);
    const from = o.status as string;
    if (from !== a.status && !ORDER_STATUS_TRANSITIONS[from]?.includes(a.status))
      throw new MoneyError(
        'INVALID_STATUS_TRANSITION',
        `Cannot transition from ${from} to ${a.status}`,
        400
      );
    if (from === 'awaiting_payment_confirmation' && a.status === 'confirmed')
      throw new MoneyError(
        'INSTAPAY_CONFIRM_REQUIRED',
        'Confirm the InstaPay payment to confirm this order',
        409
      );
    // Paid on delivery (MONEYB-7): a COD parcel handed over IS the cash collected.
    const cod =
      a.status === 'delivered' && o.payment_status === 'unpaid'
        ? db.all(
            "SELECT id FROM payments WHERE order_id = ? AND provider = 'cod' AND status = 'cod_pending' ORDER BY created_at, id LIMIT 1",
            [a.orderId]
          )[0]
        : undefined;
    db.run(
      `UPDATE orders SET status = ?1, updated_at = ?2, status_fanout_requested_at = ?2, status_fanout_claimed_at = NULL,
         status_fanout_requested_status = ?1, status_fanout_completed_at = NULL,
         delivered_at = CASE WHEN ?1 = 'delivered' AND ?3 <> 'delivered' THEN ?2 ELSE delivered_at END,
         payment_status = CASE WHEN ?4 = 1 THEN 'paid' ELSE payment_status END
       WHERE id = ?5 AND store_id = ?6`,
      [a.status, now, from, cod ? 1 : 0, a.orderId, a.storeId]
    );
    if (cod) {
      db.run(
        "UPDATE payments SET status = 'completed', paid_at = ?1, updated_at = ?1 WHERE id = ?2",
        [now, cod.id]
      );
      addPaymentEvent(db, {
        storeId: a.storeId,
        paymentId: cod.id as string,
        orderId: a.orderId,
        eventType: 'status_change',
        from: 'cod_pending',
        to: 'completed',
        provider: 'cod',
        details: { reason: 'cod_collected_on_delivery', orderNumber: o.order_number },
        now,
      });
      // COD-RECEIPT-NUMBER-AT-PAYMENT-1: delivered = cash collected, so the receipt's gapless serial is allocated now
      issueSaleDocument(db, { storeId: a.storeId, orderId: a.orderId, now });
    }
    addOrderEvent(db, a.storeId, a.orderId, from, a.status, {}, now);
    return {
      orderId: a.orderId,
      from,
      status: a.status,
      requestedAt: now,
      codSettled: (cod?.id as string | undefined) ?? null,
      orderNumber: o.order_number as string,
      customerId: (o.customer_id as string | null) ?? null,
    };
  });
}
