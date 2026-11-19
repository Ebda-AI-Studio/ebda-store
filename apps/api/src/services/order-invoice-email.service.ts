import { assertStoreOperational, isPaidForReceipt } from '../lib/store-operational';
/**
 * Queue the invoice e-mail of an order, shared by `POST /stores/:storeId/orders/:orderId/invoice/email` (routes/order.routes.ts) and the
 * assistant tool `order_invoice_email`. The send itself runs on the Inngest queue (lib/inngest/functions/invoice-email.ts).
 */
import { inngest } from '../lib/inngest/client';
import { OrderService } from './order.service';

/** The subject `EmailService.sendInvoice` gives the message (the card shows it). */
export const invoiceEmailSubject = (orderNumber: string): string => `Invoice ${orderNumber}`;

/** Who the invoice would go to: the customer's e-mail, else the one on the shipping address; null when the order has none. */
export async function invoiceRecipient(
  storeId: string,
  orderId: string
): Promise<{ to: string | null; orderNumber: string }> {
  const order = await OrderService.getById(storeId, orderId);
  // Ruling SUSPEND-OUT-1: an invoice mailed to the CUSTOMER of an unpaid order is refused (423) for a store that is not
  // `active`. Ruling SUSPEND-OUT-1b: the invoice of a PAID order is a receipt and is still sent. Here, not in the route:
  // the admin route and the assistant tool both resolve the recipient through this function before queueing.
  if (!isPaidForReceipt(order.paymentStatus)) await assertStoreOperational(storeId);
  const to =
    order.customer?.email ??
    (order.shippingAddress as Record<string, string> | null)?.email ??
    null;
  return { to, orderNumber: order.orderNumber };
}

export async function queueInvoiceEmail(storeId: string, orderId: string, to: string) {
  await inngest.send({ name: 'order/invoice.email-requested', data: { orderId, storeId, to } });
}
