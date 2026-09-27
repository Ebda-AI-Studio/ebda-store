import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

/**
 * Stuck status-change fanout sweep — scheduled safety net (#619).
 *
 * The sibling of `order-created-stuck-sweep` and `refund-reversal-stuck-sweep`,
 * for the `order/status-changed` fanout: customer payment-success / shipped
 * emails, WhatsApp/SMS/push dispatch, carrier auto-ship, and — money-adjacent —
 * the affiliate commission + loyalty award for a delivered order.
 *
 * `OrderService.updateStatus` sends the event and, if the send is REJECTED,
 * runs the fanout inline. Nothing covered a send that was ACCEPTED but never
 * delivered (Inngest outage after ingest, bad signing key, worker never came
 * up): every side effect was lost with no trace.
 *
 * updateStatus now stamps `statusFanoutRequestedAt` (and re-nulls
 * `statusFanoutClaimedAt`) with every transition, and the fanout claims
 * `statusFanoutClaimedAt` before any side effect. This sweep finds transitions
 * requested past the staleness window and never claimed, and re-sends
 * `order/status-changed` for the order's CURRENT status. The claim makes that
 * re-send safe: if the original delivery lands after all, only one of the two
 * runs gets past it.
 *
 * Only statuses whose fanout does something are swept. `pending` / `processing`
 * have no side effects, so an unclaimed one is not "stuck".
 */
interface StuckTransition {
  id: string;
  storeId: string;
  status: string;
  paymentStatus: string;
  statusFanoutRequestedAt: Date | null;
}

const FANOUT_STATUSES = ['confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'] as const;

const ORDER_STATUS_FANOUT_STUCK_MINUTES =
  Number(process.env.ORDER_STATUS_FANOUT_STUCK_MINUTES) || 10;

// RECENCY FLOOR — the same load-bearing bound the sibling sweeps carry, so a
// window misconfiguration can never re-fire the historical back-catalogue.
// Rows that predate the column are NULL and never match anyway.
const ORDER_STATUS_FANOUT_MAX_AGE_MINUTES =
  Number(process.env.ORDER_STATUS_FANOUT_MAX_AGE_MINUTES) || 720;

const SWEEP_TAKE = 200;

/** Minimal shape of the Inngest `step` this handler uses (kept for unit tests). */
interface SweepStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleOrderStatusFanoutStuckSweep(
  step: SweepStep
): Promise<{ swept: number; resent: number; alerted: number }> {
  const cutoff = new Date(Date.now() - ORDER_STATUS_FANOUT_STUCK_MINUTES * 60_000);
  const floorCutoff = new Date(Date.now() - ORDER_STATUS_FANOUT_MAX_AGE_MINUTES * 60_000);

  // Cross-tenant read — Inngest crons run outside tenant-context middleware.
  const stuck: StuckTransition[] = await step.run('find-stuck-status-fanouts', async () =>
    withRlsBypass(tx =>
      tx.order.findMany({
        where: {
          statusFanoutClaimedAt: null,
          statusFanoutRequestedAt: { lt: cutoff, gt: floorCutoff },
          status: { in: [...FANOUT_STATUSES] },
          deletedAt: null,
        },
        select: {
          id: true,
          storeId: true,
          status: true,
          paymentStatus: true,
          statusFanoutRequestedAt: true,
        },
        orderBy: { statusFanoutRequestedAt: 'asc' },
        take: SWEEP_TAKE,
      })
    )
  );

  if (stuck.length === 0) return { swept: 0, resent: 0, alerted: 0 };

  let resent = 0;
  await step.run('resend-order-status-changed', async () => {
    for (const o of stuck) {
      try {
        await inngest.send({
          name: 'order/status-changed',
          data: {
            orderId: o.id,
            storeId: o.storeId,
            status: o.status,
            // Only gates the admin refund bookkeeping email. updateStatus reads
            // it off the pre-transition order; from the persisted row, money
            // was captured when the payment status says paid or refunded.
            hadCapturedPayment: ['paid', 'refunded', 'partially_refunded'].includes(
              o.paymentStatus
            ),
          },
        });
        resent += 1;
      } catch (err) {
        logger.error({ err, orderId: o.id }, '[order-status-fanout-stuck-sweep] re-send failed');
      }
    }
  });
  logger.warn(
    { count: stuck.length, resent },
    '[order-status-fanout-stuck-sweep] re-sent order/status-changed for unclaimed transitions'
  );

  // Still unclaimed past 3× the window: the re-send itself is not landing.
  const veryStaleCutoff = Date.now() - 3 * ORDER_STATUS_FANOUT_STUCK_MINUTES * 60_000;
  const veryStale = stuck.filter(
    o => (o.statusFanoutRequestedAt?.getTime() ?? Date.now()) < veryStaleCutoff
  );
  if (veryStale.length > 0) {
    await step.run('alert-very-stale', async () => {
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'order.status_fanout.stuck',
        title: `order/status-changed fanout stuck for ${veryStale.length} order(s)`,
        body:
          `${veryStale.length} order status change(s) still have no fanout after ` +
          `> ${3 * ORDER_STATUS_FANOUT_STUCK_MINUTES}m — customer emails/WhatsApp, affiliate ` +
          `commission and loyalty award have NOT run. Re-send isn't landing; ` +
          `investigate Inngest delivery.`,
        context: {
          ids: veryStale.slice(0, 20).map(o => o.id),
          oldestRequestedAt: veryStale[0]?.statusFanoutRequestedAt?.toISOString(),
        },
      }).catch(() => undefined);
    });
    logger.error(
      { count: veryStale.length },
      '[order-status-fanout-stuck-sweep] very-stale unclaimed transitions — P1 alerted'
    );
  }

  return { swept: stuck.length, resent, alerted: veryStale.length };
}

export const orderStatusFanoutStuckSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-status-fanout-stuck-sweep',
    name: 'Order status fanout — sweep transitions whose order/status-changed never ran',
    retries: 1,
    // CADENCE: */15 on the SAME minutes as refund-reversal-stuck-sweep and
    // order-created-stuck-sweep, so it wakes the Neon compute in windows those
    // already open rather than adding new ones — see the CADENCE NOTE in
    // refund-reversal-stuck-sweep.ts. Do not tighten without re-checking Neon.
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) => handleOrderStatusFanoutStuckSweep(step)
);
