import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
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
    // monopolize Inngest workers / hammer external providers. Limit
    // is 5 because Inngest's free plan caps per-function concurrency
    // at 5; bump alongside the plan if we ever upgrade.
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/created' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, paymentMethod, locale } = event.data;

    // Guard against empty test payloads from Inngest's sync UI — they
    // arrive with `data: {}` and would crash Prisma with an
    // `id: undefined` validation error.
    if (!orderId || !storeId) {
      logger.warn({ event: event.name }, 'order/created fired without ids — skipping');
      return;
    }

    // FORCE RLS (migration complete_force_rls_coverage) filters orders to 0 rows
    // unless the tenant GUC is set. Inngest jobs run OUTSIDE the HTTP request, so
    // there is no tenant-context middleware here — set it explicitly from the
    // event's storeId, or this findUnique returns null and the fanout dies.
    const order = await step.run('load-order', async () =>
      runInTenantContext(storeId, async () => {
        const row = await prisma.order.findUnique({
          where: { id: orderId },
          include: {
            customer: true,
            items: true,
          },
        });
        if (!row) throw new Error(`Order ${orderId} not found`);
        return row;
      })
    );

    // Buyer's locale: prefer event payload (set at enqueue time), then
    // the persisted Order.locale, then fall through to store default.
    const emailLocale = (locale ?? order.locale ?? undefined) as 'en' | 'ar' | undefined;

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
      items: (order.items as Array<{ productName: string; quantity: number; price: number }>).map(
        item => ({
          name: item.productName,
          quantity: item.quantity,
          price: item.price,
        })
      ),
      subtotal: order.subtotal,
      tax: order.tax,
      shipping: order.shipping,
      discount: order.discount,
      couponCode: order.couponCode ?? undefined,
      total: order.total,
      shippingAddress: shippingAddress as OrderEmailData['shippingAddress'],
    };

    const store = await step.run('load-store', () =>
      runInTenantContext(storeId, () =>
        prisma.store
          .findUnique({
            where: { id: storeId },
            select: { name: true, wbsTemplates: true },
          })
          .catch(() => null)
      )
    );

    // Origin-aware notification routing: orders that originated on
    // WhatsApp (merchant-initiated payment link, customer DM ordering,
    // etc.) should NOT receive an email — the customer didn't give us
    // a real email address (the User row carries a synthetic
    // wa-<digits>@placeholder.forcestore.kw placeholder), the WhatsApp
    // template already confirms the order via the orderPaid template
    // (handled by the parallel orderWhatsappNotify Inngest fn), and
    // sending email to the placeholder address would either bounce or
    // (worse) deliver to whoever owns the placeholder domain. We detect
    // the origin via shippingAddress._source — set when the
    // payment-links.routes.ts flow creates the draft order. Any future
    // WhatsApp-origin flows (customer DM, BWA bot) should stamp the
    // same marker so the email skip applies uniformly.
    const orderSource = (order.shippingAddress as { _source?: string } | null)?._source;
    const skipEmailByOrigin = orderSource === 'wa_payment_link' || orderSource === 'wa_dm_order';
    if (skipEmailByOrigin) {
      logger.info(
        { orderId: order.id, source: orderSource },
        '[order-created] skipping customer email — WhatsApp-origin order, customer notified via template'
      );
    }

    // Merchant-level channel toggle: check wbsTemplates.orderPaid.channels.email.
    // When explicitly set to false, the merchant wants this event silent on email
    // (e.g. they rely solely on WhatsApp for paid confirmation). Absent channels
    // object = both on (backward-compatible default).
    type TemplateChannels = { whatsapp?: boolean; email?: boolean };
    type TemplateEntry = { name?: string; languageCode?: string; channels?: TemplateChannels };
    type WbsTemplatesShape = { orderPaid?: TemplateEntry };
    const wbsTemplates = store?.wbsTemplates as WbsTemplatesShape | null;
    const emailChannelEnabled = wbsTemplates?.orderPaid?.channels?.email !== false;
    const skipEmail = skipEmailByOrigin || !emailChannelEnabled;
    if (!emailChannelEnabled && !skipEmailByOrigin) {
      logger.info(
        { orderId: order.id, storeId },
        '[order-created] skipping customer email — merchant disabled email channel for orderPaid'
      );
    }

    await Promise.allSettled([
      step.run('send-customer-confirmation', () =>
        skipEmail
          ? Promise.resolve()
          : EmailService.sendOrderConfirmation(storeId, emailData, emailLocale)
      ),
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
