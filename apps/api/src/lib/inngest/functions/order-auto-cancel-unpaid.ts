import type { InngestFunction } from 'inngest';
import { prisma, withRlsBypass, runInTenantContext } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { OrderService } from '../../../services/order.service';

/**
 * Auto-cancel stale unpaid orders — daily cron (03:00 UTC).
 *
 * Finds orders left status=pending / paymentStatus=unpaid past
 * AUTO_CANCEL_UNPAID_DAYS (default 2 — matches the MyFatoorah payment-link
 * 2-day validity, after which the link is dead and the order will never be
 * paid) and cancels them.
 *
 * Cancellation goes through `OrderService.updateStatus(storeId, orderId,
 * 'cancelled')`. After the order-payment-lifecycle FIX, updateStatus only runs
 * applyRefundEffects (refund reversal + "Refund issued" merchant push) when the
 * order had a CAPTURED payment — so cancelling an unpaid order here issues NO
 * refund and sends NO "Refund issued" push. The customer still gets the normal
 * `order_cancelled` notification (email + configured channels). Reusing
 * updateStatus keeps the cancel path identical to a manual admin cancel
 * (inventory release, valid-transition checks, real-time socket ping, etc.).
 *
 * Capped at 500 orders/run (oldest first); the next daily run sweeps the rest.
 * Each cancel is its own step.run so one failure doesn't abort the batch.
 */

const AUTO_CANCEL_UNPAID_DAYS = Number(process.env.AUTO_CANCEL_UNPAID_DAYS) || 2;
const RUN_CAP = 500;

export const orderAutoCancelUnpaid: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-auto-cancel-unpaid',
    name: 'Auto-cancel stale unpaid orders (daily cron)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 * * *' }], // daily 03:00 UTC
  },
  async ({ step }) => {
    const threshold = new Date(Date.now() - AUTO_CANCEL_UNPAID_DAYS * 24 * 60 * 60 * 1000);

    // Cross-tenant — withRlsBypass so FORCE RLS doesn't hide other tenants'
    // rows (no HTTP tenant GUC on a cron).
    const stale = await step.run('find-stale-unpaid', () =>
      withRlsBypass(tx =>
        tx.order.findMany({
          where: {
            status: 'pending',
            paymentStatus: 'unpaid',
            deletedAt: null,
            createdAt: { lt: threshold },
          },
          select: { id: true, storeId: true, orderNumber: true },
          orderBy: { createdAt: 'asc' },
          take: RUN_CAP,
        })
      )
    );

    if (stale.length === 0) {
      logger.info('order-auto-cancel-unpaid: nothing to cancel');
      return { scanned: 0, cancelled: 0, failed: 0 };
    }

    let cancelled = 0;
    let failed = 0;

    for (const order of stale) {
      const ok = await step.run(`cancel-${order.id}`, async () => {
        try {
          // updateStatus reads + writes the order via Prisma — run it inside the
          // order's tenant context so FORCE RLS policies (read + write) are
          // satisfied on this non-HTTP cron path.
          await runInTenantContext(order.storeId, () =>
            OrderService.updateStatus(order.storeId, order.id, 'cancelled')
          );
          return true;
        } catch (err) {
          logger.error(
            { err, orderId: order.id, storeId: order.storeId },
            'order-auto-cancel-unpaid: failed to cancel order'
          );
          return false;
        }
      });
      if (ok) cancelled += 1;
      else failed += 1;
    }

    logger.info(
      { scanned: stale.length, cancelled, failed, thresholdDays: AUTO_CANCEL_UNPAID_DAYS },
      'order-auto-cancel-unpaid completed'
    );
    return { scanned: stale.length, cancelled, failed };
  }
);
