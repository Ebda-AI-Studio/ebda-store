import type { InngestFunction } from 'inngest';
import { prisma, withRlsBypass, runInTenantContext } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { OneSignalService } from '../../../services/onesignal.service';

/**
 * Stuck-payment merchant alert — scheduled sweep (every 15 min).
 *
 * Finds ONLINE-payment orders that the customer placed but never paid:
 *   status         = 'pending'
 *   paymentStatus  = 'unpaid'
 *   has a Payment row whose provider is NOT cash/COD (i.e. an online gateway
 *     invoice was created — a payment LINK exists that the customer can still
 *     complete)
 *   createdAt      < now - STUCK_PAYMENT_MINUTES
 *   stuckPaymentAlertedAt IS NULL (not yet alerted)
 *
 * …and pushes the merchant ONE "Payment pending — follow up" alert per order so
 * they can call/contact the customer before the (2-day) link expires. The
 * `stuckPaymentAlertedAt` column dedupes so each order alerts at most once.
 *
 * Why a sweep (cron) and not purely event-driven: the "stuck" condition is a
 * TIMEOUT — it can only be evaluated after a delay, and there's no event when
 * "nothing happened". A 15-min cron catches every stuck order within one tick
 * of crossing the threshold, with the column making it idempotent across ticks.
 *
 * Capped at 200 orders/run (oldest first) so a backlog can't blow up a single
 * run; the next tick picks up the remainder. COD orders never match (no online
 * Payment row), and already paid / cancelled / expired orders are excluded by
 * the status filter.
 */

const STUCK_PAYMENT_MINUTES = Number(process.env.STUCK_PAYMENT_MINUTES) || 60;
const SWEEP_TAKE = 200;

// Payment providers that represent CASH / cash-on-delivery — these orders have
// no online payment link to chase, so they're NOT "stuck online payments".
const CASH_PROVIDERS = ['cod', 'cash', 'cash_on_delivery'];

export const orderStuckPaymentSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-stuck-payment-sweep',
    name: 'Stuck payment — merchant follow-up sweep (cron)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/15 * * * *' }], // every 15 minutes
  },
  async ({ step }) => {
    const threshold = new Date(Date.now() - STUCK_PAYMENT_MINUTES * 60_000);

    // Cross-tenant sweep — no HTTP tenant context. withRlsBypass so FORCE RLS
    // on orders/payments doesn't filter to 0 rows. We select the minimum
    // needed to send the push; per-order marking happens in its own tenant
    // context below.
    const candidates = await step.run('find-stuck-orders', () =>
      withRlsBypass(tx =>
        tx.order.findMany({
          where: {
            status: 'pending',
            paymentStatus: 'unpaid',
            deletedAt: null,
            stuckPaymentAlertedAt: null,
            createdAt: { lt: threshold },
            // Online order = at least one Payment row with a non-cash provider
            // (an online gateway invoice / payment link was created).
            payments: {
              some: {
                provider: { notIn: CASH_PROVIDERS },
              },
            },
          },
          select: {
            id: true,
            storeId: true,
            orderNumber: true,
            total: true,
            currency: true,
            customer: { select: { firstName: true, lastName: true, email: true } },
            shippingAddress: true,
            store: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: SWEEP_TAKE,
        })
      )
    );

    if (candidates.length === 0) {
      logger.info('order-stuck-payment-sweep: no stuck orders');
      return { scanned: 0, alerted: 0 };
    }

    let alerted = 0;

    for (const order of candidates) {
      await step.run(`alert-${order.id}`, async () => {
        const shippingAddress = order.shippingAddress as Record<string, unknown> | null;
        const guestFirstName =
          typeof shippingAddress?.firstName === 'string' ? shippingAddress.firstName : '';
        const guestLastName =
          typeof shippingAddress?.lastName === 'string' ? shippingAddress.lastName : '';
        const customerName =
          `${order.customer?.firstName || guestFirstName} ${order.customer?.lastName || guestLastName}`.trim() ||
          order.customer?.email ||
          'Customer';

        // Send first; only mark alerted once the push call resolved. A thrown
        // send leaves stuckPaymentAlertedAt NULL so the next tick retries.
        await OneSignalService.notifyAdminsOfStuckPayment({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId: order.storeId,
          storeName: order.store?.name ?? order.storeId,
          customerName,
          total: order.total,
          currency: order.currency,
        });

        // Mark alerted inside the order's tenant context so the FORCE RLS write
        // policy is satisfied. Conditional WHERE keeps it idempotent even if two
        // sweeps race the same order.
        await runInTenantContext(order.storeId, () =>
          prisma.order.updateMany({
            where: { id: order.id, stuckPaymentAlertedAt: null },
            data: { stuckPaymentAlertedAt: new Date() },
          })
        );
        return true;
      });
      alerted += 1;
    }

    logger.info({ scanned: candidates.length, alerted }, 'order-stuck-payment-sweep completed');
    return { scanned: candidates.length, alerted };
  }
);
