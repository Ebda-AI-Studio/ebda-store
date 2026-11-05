import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { stepRunUnlessEmpty } from '../empty-exit';
import { sendAlert } from '../../../services/alerts.service';
import { redis } from '../../../services/redis.service';
import { sweepStoresDb } from '../../jobs/store-db';
import { storeMoney } from '../../repo-factory';
import { withStore } from '@ebda/database';

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
 *
 * issue 2070 / issue 2133: the re-send carries the REQUESTED status
 * (`statusFanoutRequestedStatus`), and only while the order is still at it.
 * A direct `Order.status` writer (gateway refund, refresh-refund-status,
 * payment confirm) can move the row on without re-arming, and re-sending the
 * CURRENT status then ran the wrong transition's side effects (a second
 * refund bookkeeping mail) while the lost one was never reported. A request
 * that was superseded that way is now reported and disarmed, never re-sent.
 *
 * issue 2071: the claim is a dedup lock taken BEFORE the side effects, so a
 * fanout whose steps failed on every retry kept its claim and was invisible
 * here. The fanout now stamps `statusFanoutCompletedAt` after every side
 * effect succeeded; a claimed, never-completed transition past the window is
 * reported (once per transition) as a P1 naming the orders. It is NOT re-sent:
 * the steps that did succeed (customer emails) would send twice.
 */
interface StuckTransition {
  id: string;
  storeId: string;
  status: string;
  paymentStatus: string;
  statusFanoutRequestedAt: Date | string | null; // ISO string once replayed from step memo
  statusFanoutRequestedStatus: string | null;
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
  step: SweepStep,
  event?: { data?: unknown }
): Promise<{ swept: number; resent: number; alerted: number }> {
  const cutoff = new Date(Date.now() - ORDER_STATUS_FANOUT_STUCK_MINUTES * 60_000);
  const floorCutoff = new Date(Date.now() - ORDER_STATUS_FANOUT_MAX_AGE_MINUTES * 60_000);

  // Cross-tenant read — Inngest crons run outside tenant-context middleware.
  const stuck: StuckTransition[] = await stepRunUnlessEmpty(
    step,
    'find-stuck-status-fanouts',
    async () =>
      sweepStoresDb(event, {
        fetch: (storeId, db) =>
          db.order.findMany({
            where: {
              storeId,
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
              statusFanoutRequestedStatus: true,
            },
            orderBy: { statusFanoutRequestedAt: 'asc' },
            take: SWEEP_TAKE,
          }),
        orderKey: r => r.statusFanoutRequestedAt ?? 0,
        take: SWEEP_TAKE,
      })
  );

  const failedAfterClaim = await reportFailedAfterClaim(step, event, cutoff, floorCutoff);

  // Rows armed before issue 2070 carry no requested status: their CURRENT
  // status is the only answer available (the old behaviour).
  const superseded = stuck.filter(
    o => o.statusFanoutRequestedStatus != null && o.statusFanoutRequestedStatus !== o.status
  );
  const resendable = stuck.filter(o => !superseded.includes(o));
  if (superseded.length > 0) {
    await step.run('report-superseded-transitions', async () => {
      logger.error(
        {
          orders: superseded.slice(0, 20).map(o => ({
            id: o.id,
            requested: o.statusFanoutRequestedStatus,
            now: o.status,
          })),
        },
        '[order-status-fanout-stuck-sweep] a requested transition was never delivered and the order has since moved on — its side effects were lost'
      );
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'order.status_fanout.superseded',
        title: 'Order status fanout lost to a later status change',
        body:
          `${superseded.length} order(s) had a status change whose fanout (customer email / ` +
          `WhatsApp, affiliate commission, loyalty award) never ran, and the order has since ` +
          `been moved to another status directly. Not re-sent — it would run the wrong ` +
          `transition. Check each order's notifications and loyalty/affiliate state.`,
        context: {
          orders: superseded.slice(0, 20).map(o => ({
            id: o.id,
            storeId: o.storeId,
            requested: o.statusFanoutRequestedStatus,
            now: o.status,
          })),
        },
      }).catch(() => undefined);
      // Disarm, so the same lost transition is reported once, not every tick.
      await Promise.all(
        superseded.map(o =>
          storeMoney(o.storeId).then(
            async (money): Promise<unknown> =>
              money
                ? // a Durable Object order (Ruling CF-PAY-1): the same conditional disarm, one DO section
                  money.fanoutDisarm({
                    orderId: o.id,
                    requestedAt: new Date(o.statusFanoutRequestedAt ?? 0).getTime(),
                  })
                : withStore(o.storeId, tx =>
                    tx.order.updateMany({
                      where: {
                        id: o.id,
                        storeId: o.storeId,
                        statusFanoutClaimedAt: null,
                        statusFanoutRequestedAt: o.statusFanoutRequestedAt,
                      },
                      data: { statusFanoutRequestedAt: null },
                    })
                  )
          )
        )
      );
    });
  }

  if (resendable.length === 0) {
    return { swept: stuck.length, resent: 0, alerted: failedAfterClaim };
  }

  let resent = 0;
  await step.run('resend-order-status-changed', async () => {
    for (const o of resendable) {
      try {
        await inngest.send({
          name: 'order/status-changed',
          data: {
            orderId: o.id,
            storeId: o.storeId,
            // The REQUESTED transition (issue 2070); equal to the current
            // status here by construction (superseded rows were split out).
            status: o.statusFanoutRequestedStatus ?? o.status,
            ...(o.statusFanoutRequestedAt
              ? { requestedAt: new Date(o.statusFanoutRequestedAt).toISOString() }
              : {}),
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
    { count: resendable.length, resent },
    '[order-status-fanout-stuck-sweep] re-sent order/status-changed for unclaimed transitions'
  );

  // Still unclaimed past 3× the window: the re-send itself is not landing.
  const veryStaleCutoff = Date.now() - 3 * ORDER_STATUS_FANOUT_STUCK_MINUTES * 60_000;
  const veryStale = resendable.filter(
    // new Date(): a memoized step.run result — an ISO string on replay (issue 2284's class).
    o =>
      (o.statusFanoutRequestedAt ? new Date(o.statusFanoutRequestedAt).getTime() : Date.now()) <
      veryStaleCutoff
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
          `check the Cloudflare job dispatch (Worker logs, JOBS_WORKFLOW / JOBS_QUEUE).`,
        context: {
          ids: veryStale.slice(0, 20).map(o => o.id),
          oldestRequestedAt: veryStale[0]?.statusFanoutRequestedAt
            ? new Date(veryStale[0].statusFanoutRequestedAt).toISOString()
            : undefined,
        },
      }).catch(() => undefined);
    });
    logger.error(
      { count: veryStale.length },
      '[order-status-fanout-stuck-sweep] very-stale unclaimed transitions — P1 alerted'
    );
  }

  return { swept: stuck.length, resent, alerted: veryStale.length + failedAfterClaim };
}

/**
 * issue 2071 — claimed, never completed, past the window: the fanout failed
 * after taking its claim. Reported once per transition (Redis sentinel keyed
 * on the order and its requested-at); returns how many were newly reported.
 * Only rows armed with a requested status are considered, so rows from before
 * the completion stamp existed are never reported.
 */
async function reportFailedAfterClaim(
  step: SweepStep,
  event: { data?: unknown } | undefined,
  cutoff: Date,
  floorCutoff: Date
): Promise<number> {
  const failed = await stepRunUnlessEmpty(step, 'find-failed-after-claim', () =>
    sweepStoresDb(event, {
      fetch: (storeId, db) =>
        db.order.findMany({
          where: {
            storeId,
            statusFanoutClaimedAt: { lt: cutoff, gt: floorCutoff },
            statusFanoutCompletedAt: null,
            statusFanoutRequestedStatus: { not: null },
            deletedAt: null,
          },
          select: {
            id: true,
            storeId: true,
            status: true,
            statusFanoutRequestedStatus: true,
            statusFanoutRequestedAt: true,
          },
          orderBy: { statusFanoutClaimedAt: 'asc' },
          take: SWEEP_TAKE,
        }),
      orderKey: r => r.statusFanoutRequestedAt ?? 0,
      take: SWEEP_TAKE,
    })
  );
  if (failed.length === 0) return 0;
  return step.run('alert-failed-after-claim', async () => {
    const fresh: typeof failed = [];
    for (const o of failed) {
      const key = `status-fanout-failed:${o.id}:${new Date(o.statusFanoutRequestedAt ?? 0).getTime()}`;
      const first = await redis
        .acquireLock(key, (ORDER_STATUS_FANOUT_MAX_AGE_MINUTES + 60) * 60)
        .catch(() => true);
      if (first) fresh.push(o);
    }
    if (fresh.length === 0) return 0;
    logger.error(
      { orders: fresh.slice(0, 20).map(o => o.id) },
      '[order-status-fanout-stuck-sweep] fanout claimed but never completed — side effects failed'
    );
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'order.status_fanout.failed_after_claim',
      title: 'Order status fanout failed after it started',
      body:
        `${fresh.length} order status change(s) started their fanout but never finished it ` +
        `(a step failed on every retry): the customer email/WhatsApp, affiliate commission or ` +
        `loyalty award for that transition may not have run. Not re-sent automatically — ` +
        `steps that DID succeed would repeat. Check the failed Workflow run in the Cloudflare dashboard and replay it, ` +
        `or apply the missing effect by hand.`,
      context: {
        orders: fresh.slice(0, 20).map(o => ({
          id: o.id,
          storeId: o.storeId,
          transition: o.statusFanoutRequestedStatus,
          now: o.status,
        })),
      },
    }).catch(() => undefined);
    return fresh.length;
  });
}

export const orderStatusFanoutStuckSweep: JobDef = inngest.createFunction(
  {
    id: 'order-status-fanout-stuck-sweep',
    name: 'Order status fanout — sweep transitions whose order/status-changed never ran',
    retries: 1,
    // CADENCE: hourly at minute 7, the SAME minute as refund-reversal-stuck-sweep and
    // order-created-stuck-sweep, so it wakes the Neon compute in windows those
    // already open rather than adding new ones. The budget rationale is in the
    // comment below; do not tighten without re-checking Neon AND the Inngest budget.
    // HOURLY (Ruling INNGEST-BUDGET-1): Inngest Hobby caps executions at 50k/month and Ebda is pre-launch;
    // worst-case detection of a lost order/status-changed enqueue is now 10-70 min, not 10-25.
    // Revisit at launch, when real orders exist (docs/RULINGS.md, docs/ENVIRONMENT.md).
    triggers: [{ cron: '7 * * * *' }],
  },
  async ({ step, event }) => handleOrderStatusFanoutStuckSweep(step, event)
);
