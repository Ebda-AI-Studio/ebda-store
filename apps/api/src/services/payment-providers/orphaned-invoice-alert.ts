import { sendAlert } from '../alerts.service';
import logger from '../../lib/logger';

/**
 * A gateway invoice the provider ACCEPTED whose Payment row never became
 * durable (issue 2360).
 *
 * `PaymentService.createPayment` calls the gateway from INSIDE a tenant
 * transaction, and the Payment row it writes is only durable once that
 * transaction COMMITs. If the COMMIT fails or times out after the provider
 * said yes, the order is rolled back (stock, coupon, cart restored) but the
 * invoice is still live at the gateway. MyFatoorah can notify the customer
 * directly, so they can still pay it — and the settle webhook then matches no
 * Payment row, resolves no store, and is rejected: money captured, nothing
 * recorded.
 *
 * No provider adapter exposes a void/cancel call today, so this does not
 * cancel the invoice itself. It makes the orphan visible: an error log line
 * written first (the record even if Telegram is down or throttled) and a P1
 * naming the provider and the gateway's own transaction id, so an operator
 * can void it in the provider dashboard before it is paid. Ruling PAY-ORPH-1.
 *
 * Called from the catch blocks OUTSIDE the failed wrap (payment.routes.ts
 * POST /payments/create and the MCP `place_order` tool), so it runs inline —
 * there is no request tenant transaction left to defer behind. Never throws.
 */
export interface OrphanedProviderInvoice {
  storeId: string;
  orderId: string;
  orderNumber: string;
  provider: string;
  transactionId: string;
  amount: number;
  currency: string;
  source: 'checkout' | 'agent';
}

export async function alertOrphanedProviderInvoice(o: OrphanedProviderInvoice): Promise<void> {
  const title = `Gateway invoice with no payment record — ${o.orderNumber}`;
  logger.error({ ...o }, `[payment] ${title}`);
  try {
    const outcome = await sendAlert({
      level: 'p1',
      scope: 'store',
      store: { id: o.storeId, name: o.orderNumber },
      source: `payment.create.orphaned_invoice.${o.source}`,
      title,
      body:
        `${o.provider} accepted invoice ${o.transactionId} for order ${o.orderNumber}, ` +
        'but the transaction that records it failed to commit, so the order was rolled back. ' +
        'Void this invoice in the provider dashboard: if the customer pays it, the webhook ' +
        'matches no payment and the money is captured with nothing recorded.',
      context: { ...o },
    });
    if (outcome !== 'sent') {
      logger.warn(
        { orderId: o.orderId, transactionId: o.transactionId, outcome },
        '[payment] orphaned-invoice alert not delivered — the error log line above is the record'
      );
    }
  } catch (err) {
    logger.error({ err, orderId: o.orderId }, '[payment] orphaned-invoice alert threw');
  }
}
