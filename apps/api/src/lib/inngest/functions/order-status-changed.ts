import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { groupOrderLinesForDisplay } from '@force/shared';
import { EmailService } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { LoyaltyService } from '../../../services/loyalty.service';
import { affiliateService } from '../../../services/affiliate.service';
import { shippingCarrierService } from '../../../services/shipping-carrier.service';
import { featureService } from '../../../services/feature.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Fans out the post-purchase side effects of an order STATUS transition
 * (confirmed / shipped / delivered / cancelled / refunded). Builder Reality
 * Audit Lens E, finding E2-4.
 *
 * Before this, `OrderService.updateStatus()` fired ~13 side effects
 * (payment-success / shipped / admin-refund emails, WhatsApp/SMS/push dispatch,
 * affiliate commission, loyalty award, shipping-carrier auto-create) as
 * in-process fire-and-forget `.catch(log)` calls — if Resend/OneSignal/etc. was
 * down, or the process redeployed mid-flight, the side effect was lost with only
 * a Pino line: no retry, no alert, no record. This mirrors what
 * `order-created-fanout` already does for the create path: each side effect is a
 * retriable `step.run`, and the whole run re-throws on any exhausted failure so
 * `alerts-failure-watch` dead-letters it.
 *
 * Money reversal (`applyRefundEffects`) and the real-time socket ping stay
 * inline in `updateStatus` — the former is awaited money state, the latter is a
 * fast in-process emit. The existing `order/shipped` + `order/delivered` events
 * (consumed by the WhatsApp bridge + the 7-day review-request job) are unchanged;
 * this new `order/status-changed` event carries only the migrated side effects.
 */
interface FanoutStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleOrderStatusChanged(
  orderId: string,
  storeId: string,
  status: string,
  hadCapturedPayment: boolean,
  step: FanoutStep
): Promise<{ skipped?: string; ran: string[] }> {
  if (!orderId || !storeId) {
    logger.warn({ orderId, storeId }, 'order/status-changed fired without ids — skipping');
    return { skipped: 'missing-ids', ran: [] };
  }

  const order = await step.run('load-order', () =>
    runInTenantContext(storeId, () =>
      prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true, items: true },
      })
    )
  );
  if (!order) {
    logger.warn({ orderId, storeId }, 'order/status-changed: order not found — skipping');
    return { skipped: 'order-not-found', ran: [] };
  }

  const orderLocale = (order.locale ?? undefined) as 'en' | 'ar' | undefined;
  const customerEmail = order.customer?.email || '';
  const customerName =
    `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
    customerEmail ||
    'Customer';
  const shippingAddrFull = order.shippingAddress as {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
  } | null;
  const customerPhone = shippingAddrFull?.phone ?? undefined;

  const store = await step.run('load-store', () =>
    runInTenantContext(storeId, () =>
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }).catch(() => null)
    )
  );
  const storeName = store?.name ?? storeId;

  // Each side effect is its own retriable step; collect results and re-throw on
  // any exhausted failure so the run dead-letters (alerts-failure-watch).
  const jobs: Array<Promise<unknown>> = [];
  const ran: string[] = [];
  const add = (id: string, fn: () => Promise<unknown>) => {
    ran.push(id);
    jobs.push(step.run(id, fn));
  };

  if (status === 'delivered') {
    // affiliate_referrals/affiliates + loyalty_points/loyalty_transactions carry
    // FORCE RLS — in Inngest there's no HTTP request ALS scope, so each writer
    // MUST set the tenant GUC itself via runInTenantContext or the reads return
    // 0 rows and the WITH CHECK insert is rejected (commissions silently lost,
    // loyalty inserts dead-letter every delivered order).
    add('affiliate-commission', () =>
      runInTenantContext(storeId, () => affiliateService.processCommission(storeId, orderId))
    );
    if (order.customerId) {
      add('loyalty-earn', () =>
        runInTenantContext(storeId, () =>
          LoyaltyService.earnPointsFromPurchase(storeId, order.customerId!, orderId, order.total)
        )
      );
    }
    add('dispatch-delivered', () =>
      notificationDispatcher.dispatch(storeId, 'order_delivered', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName,
      })
    );
  } else if (status === 'confirmed') {
    add('auto-ship', () =>
      // store_features + shipments + shipping_carrier_configs are all FORCE RLS,
      // so BOTH the feature check and the shipment create must run with the
      // tenant GUC set (Inngest has no request ALS scope to inherit).
      runInTenantContext(storeId, async () => {
        const shippingEnabled = await featureService.isFeatureEnabled(storeId, 'shipping_carriers');
        if (shippingEnabled) {
          await shippingCarrierService.createShipmentForOrder(storeId, orderId);
        }
      })
    );
    if (shippingAddrFull) {
      add('email-payment-success', () =>
        EmailService.sendPaymentSuccess(
          storeId,
          {
            orderNumber: order.orderNumber,
            customerName,
            customerEmail,
            // Bundle boxes collapse to ONE row each (see
            // groupOrderLinesForDisplay) — the payment-success email must
            // show "Ramadan Box · 12.000 KWD", never the per-component
            // allocated shares that fund that one price.
            items: groupOrderLinesForDisplay(order.items).map(row =>
              row.kind === 'bundle'
                ? { name: row.name, nameAr: row.nameAr, quantity: row.quantity, price: row.total }
                : { name: row.item.productName, quantity: row.item.quantity, price: row.item.price }
            ),
            subtotal: order.subtotal,
            tax: order.tax,
            shipping: order.shipping,
            total: order.total,
            shippingAddress: shippingAddrFull,
          },
          orderLocale
        )
      );
    }
  } else if (status === 'shipped') {
    add('email-shipped', () =>
      EmailService.sendOrderShipped(
        storeId,
        { customerEmail, customerName, orderNumber: order.orderNumber },
        orderLocale
      )
    );
    add('dispatch-shipped', () =>
      notificationDispatcher.dispatch(storeId, 'order_shipped', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName,
      })
    );
  } else if (status === 'cancelled') {
    add('dispatch-cancelled', () =>
      notificationDispatcher.dispatch(storeId, 'order_cancelled', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName,
      })
    );
  } else if (status === 'refunded' && hadCapturedPayment) {
    // Only notify a refund when money was actually captured (same gate as the
    // inline path — a `refunded` status on a never-paid order must not claim a
    // refund happened).
    add('email-admin-refund', () =>
      EmailService.sendAdminRefund({
        orderNumber: order.orderNumber,
        amount: order.total,
        reason: 'Order refunded',
      })
    );
    add('dispatch-refunded', () =>
      notificationDispatcher.dispatch(storeId, 'refund_processed', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        amount: order.total,
        storeId,
        storeName,
      })
    );
  }

  const results = await Promise.allSettled(jobs);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected.length > 0) {
    // Index by the ORIGINAL position in results/jobs/ran — iterating the
    // filtered `rejected` subset would mislabel which step failed (e.g. report
    // the first step's name for a later step's failure).
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.error({ err: r.reason, step: ran[i] }, 'order/status-changed step failed');
      }
    });
    throw new AggregateError(
      rejected.map(r => r.reason),
      `order-status-changed-fanout (${status}): ${rejected.length}/${results.length} step(s) failed`
    );
  }

  return { ran };
}

export const orderStatusChanged: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-status-changed-fanout',
    name: 'Order status changed — email + push + dispatcher fan-out',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/status-changed' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, status, hadCapturedPayment } = event.data;
    return handleOrderStatusChanged(orderId, storeId, status, hadCapturedPayment === true, step);
  }
);
