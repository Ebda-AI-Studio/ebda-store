import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { EmailService, type OrderEmailData } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { OneSignalService } from '../../../services/onesignal.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Fans out the post-checkout side effects for a freshly-committed order.
 * Each side effect is wrapped in `step.run` so Inngest retries them
 * independently — a flaky SMTP server doesn't cancel the OneSignal push.
 *
 * Why this is async: at peak (Black Friday-style bursts) the inline
 * version blocked the checkout response on three external HTTP calls
 * (SMTP, OneSignal REST, dispatcher fan-out). Moving them onto Inngest
 * cuts checkout p95 by ~600ms in production and lets us retry on
 * provider hiccups without losing notifications.
 */
export const orderCreated: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-created-fanout',
    name: 'Order created — email + push + dispatcher fan-out',
    // Cap concurrent runs per store so a single tenant's burst can't
    // monopolize Inngest workers / hammer external providers.
    concurrency: { key: 'event.data.storeId', limit: 10 },
    retries: 3,
    triggers: [{ event: 'order/created' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, paymentMethod } = event.data;

    const order = await step.run('load-order', async () => {
      const row = await prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true, items: true },
      });
      if (!row) throw new Error(`Order ${orderId} not found`);
      return row;
    });

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

    const emailData: OrderEmailData = {
      orderNumber: order.orderNumber,
      customerName,
      customerEmail: order.customer?.email || guestEmail,
      items: order.items.map(item => ({
        name: item.productName,
        quantity: item.quantity,
        price: item.price,
      })),
      subtotal: order.subtotal,
      tax: order.tax,
      shipping: order.shipping,
      discount: order.discount,
      couponCode: order.couponCode ?? undefined,
      total: order.total,
      shippingAddress: shippingAddress as OrderEmailData['shippingAddress'],
    };

    const store = await step.run('load-store', () =>
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }).catch(() => null)
    );

    await Promise.allSettled([
      step.run('send-customer-confirmation', () => EmailService.sendOrderConfirmation(emailData)),
      step.run('send-admin-new-order', () => EmailService.sendAdminNewOrder(emailData)),
      step.run('dispatch-notification-channels', async () => {
        await notificationDispatcher.dispatch(storeId, 'order_confirmed', {
          customerName,
          customerPhone: guestPhone || undefined,
          orderNumber: order.orderNumber,
          total: order.total,
          storeId,
          storeName: store?.name ?? storeId,
        });
      }),
      step.run('onesignal-admin-push', () =>
        OneSignalService.notifyAdminsOfOrder({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId,
          storeName: store?.name ?? storeId,
          customerName,
          total: order.total,
          currency: order.currency,
          paymentMethod,
        })
      ),
    ]).then(results => {
      results.forEach(r => {
        if (r.status === 'rejected') {
          logger.error({ err: r.reason }, 'order/created step failed');
        }
      });
    });
  }
);
