import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { EmailService, type OrderRefundEmailData } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { OneSignalService } from '../../../services/onesignal.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Fans out side effects when an order is refunded — fires from
 * `OrderService.applyRefundEffects` so EVERY refund path (gateway-driven
 * webhook, admin "Refund via MyFatoorah", manual status-button) lands
 * the same customer-facing notifications without bespoke wiring at each
 * callsite.
 *
 * Mirrors `order-created.ts` shape:
 *   - email the customer the refund confirmation
 *   - dispatch the merchant's configured notification channels
 *     (WhatsApp / SMS) with the order_refunded template
 *   - push the admin OneSignal app so the merchant sees the refund
 *     land in real-time
 *
 * Each side-effect is wrapped in `step.run` so an SMTP outage doesn't
 * cancel the OneSignal push or the WhatsApp send.
 */
export const orderRefunded: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-refunded-fanout',
    name: 'Order refunded — email + push + dispatcher fan-out',
    // Same per-store concurrency cap as order-created so a single tenant
    // batch-refund storm can't monopolize Inngest workers.
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data;

    if (!orderId || !storeId) {
      logger.warn({ event: event.name }, 'order/refunded fired without ids — skipping');
      return;
    }

    const order = await step.run('load-order', async () => {
      const row = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          customer: true,
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!row) throw new Error(`Order ${orderId} not found`);
      return row;
    });

    // Refund amount: prefer the latest payment's refundedAmount (set by
    // payment.factory.refund), fall back to order total for status-button
    // refunds where the payment row may not exist (COD / manual paid).
    const latestPayment = order.payments[0];
    const refundAmount = latestPayment?.refundedAmount || order.total;

    // Customer contact info: prefer User row, fall back to the shipping
    // address snapshot for guest orders.
    const shippingAddress = order.shippingAddress as Record<string, unknown>;
    const guestFirstName =
      typeof shippingAddress?.firstName === 'string' ? shippingAddress.firstName : '';
    const guestLastName =
      typeof shippingAddress?.lastName === 'string' ? shippingAddress.lastName : '';
    const guestEmail = typeof shippingAddress?.email === 'string' ? shippingAddress.email : '';
    const guestPhone = typeof shippingAddress?.phone === 'string' ? shippingAddress.phone : '';

    const customerName =
      `${order.customer?.firstName || guestFirstName} ${order.customer?.lastName || guestLastName}`.trim() ||
      order.customer?.email ||
      guestEmail ||
      'Customer';
    const customerEmail = order.customer?.email || guestEmail;
    const orderLocale = (order.locale ?? undefined) as 'en' | 'ar' | undefined;

    const emailData: OrderRefundEmailData = {
      orderNumber: order.orderNumber,
      customerName,
      customerEmail,
      orderTotal: order.total,
      refundAmount,
      reason:
        typeof (latestPayment?.metadata as Record<string, unknown> | null)?.refundReason ===
        'string'
          ? ((latestPayment?.metadata as Record<string, unknown>).refundReason as string)
          : undefined,
    };

    const store = await step.run('load-store', () =>
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }).catch(() => null)
    );

    await Promise.allSettled([
      step.run('send-customer-refund-email', () =>
        EmailService.sendOrderRefunded(storeId, emailData, orderLocale)
      ),
      step.run('dispatch-notification-channels', () =>
        notificationDispatcher.dispatch(storeId, 'refund_processed', {
          customerName,
          customerPhone: guestPhone || undefined,
          orderNumber: order.orderNumber,
          amount: refundAmount / 1000,
          storeId,
          storeName: store?.name ?? storeId,
        })
      ),
      step.run('onesignal-admin-refund-push', () =>
        OneSignalService.notifyAdminsOfRefund({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId,
          storeName: store?.name ?? storeId,
          customerName,
          total: refundAmount,
          currency: order.currency,
          paymentMethod: latestPayment?.provider ?? 'refund',
        })
      ),
    ]).then(results => {
      results.forEach(r => {
        if (r.status === 'rejected') {
          logger.error({ err: r.reason, orderId }, 'order/refunded step failed');
        }
      });
    });
  }
);
