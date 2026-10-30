import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { sweepStoresDb } from '../../jobs/store-db';
import { stepRunUnlessEmpty } from '../empty-exit';

/**
 * Stuck order-created sweep — scheduled safety net (hourly, Ruling INNGEST-BUDGET-1).
 *
 * The mirror of `payment-webhook-stuck-sweep` for the `order/created` fanout.
 * The `order/created` enqueue (4 call sites: COD create, admin mark-paid single
 * + bulk, and the online-payment webhook) is fire-and-forget: if `inngest.send`
 * fails to enqueue (Inngest outage / misconfig / Railway↔Inngest blip) the four
 * downstream functions — customer email, admin push, WhatsApp notify, CAPI, and
 * the accounting journal — NEVER run for that order, with no `function.failed`
 * to dead-letter (the consumer never started) and no provider retry. A PAID
 * order silently ends up with no confirmation email and, worse, no books entry.
 *
 * This sweep finds orders that are genuinely PAID (`paymentStatus = 'paid'`) but
 * whose fanout never claimed them (`orderCreatedNotifiedAt IS NULL`) past the
 * staleness window, and re-sends `order/created` once per tick. Keyed on
 * `paymentStatus='paid'` specifically so it can NEVER re-notify a still-unpaid
 * online order (the ghost-notification trap the create path guards against) —
 * an unpaid/pending order legitimately has no fanout yet and is excluded.
 *
 * Idempotency-safe: the fanout's first step atomically CLAIMs
 * `order_created_notified_at` (`order-created.ts`), so a re-sent event for an
 * order whose fanout is merely slow/in-flight matches 0 rows on the claim and
 * skips — no double email/push. COD orders (which are `unpaid` until delivery)
 * are intentionally out of scope here; their send-failure is lower-impact
 * (no books/paid-order reconciliation) and covered by the enqueue-site log.
 */
interface StuckOrder {
  id: string;
  storeId: string;
  locale: string | null;
  createdAt: Date | string; // ISO string once replayed from step memo
}

const STUCK_ORDER_NOTIFY_MINUTES = Number(process.env.STUCK_ORDER_NOTIFY_MINUTES) || 10;
// RECENCY FLOOR (P0 fix, 2026-07-09): the sweep must ONLY recover recently-stuck
// orders, never the historical back-catalog. Without a lower bound, the first
// run swept EVERY paid order whose `orderCreatedNotifiedAt` was NULL — which
// includes all orders predating the claim mechanism — and re-fired order/created
// (confirmation email + admin push + WhatsApp + CAPI + accounting journal) for
// the entire order history across every store. A genuinely-stuck order is caught
// within minutes; 12h is a generous ceiling that safely excludes old orders.
const STUCK_ORDER_MAX_AGE_MINUTES = Number(process.env.STUCK_ORDER_MAX_AGE_MINUTES) || 720;
const SWEEP_TAKE = 200;

/** Minimal shape of the Inngest `step` this handler uses (kept for unit tests). */
interface SweepStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Extracted handler (testable in isolation — mirrors the other extracted
 * Inngest handlers). The `createFunction` wrapper below just forwards `step`.
 */
export async function handleOrderCreatedStuckSweep(
  step: SweepStep,
  event?: { data?: unknown }
): Promise<{ swept: number; resent: number; alerted: number }> {
  const cutoff = new Date(Date.now() - STUCK_ORDER_NOTIFY_MINUTES * 60_000);
  const floorCutoff = new Date(Date.now() - STUCK_ORDER_MAX_AGE_MINUTES * 60_000);

  // Cross-tenant read — Inngest crons run outside tenant-context middleware.
  const stuck: StuckOrder[] = await stepRunUnlessEmpty(step, 'find-stuck', async () =>
    // PORTED (Ruling CF-JOBS-3): the cron lists the Postgres stores, a DO store's alarm reads its own Durable Object.
    sweepStoresDb(event, {
      fetch: (storeId, db) =>
        db.order.findMany({
          where: {
            storeId,
            paymentStatus: 'paid',
            orderCreatedNotifiedAt: null,
            status: { not: 'cancelled' },
            // Window: older than the notify grace period, but NOT older than the
            // recency floor — so the historical back-catalog is never re-notified.
            createdAt: { lt: cutoff, gt: floorCutoff },
          },
          select: { id: true, storeId: true, locale: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
          take: SWEEP_TAKE,
        }),
      orderKey: r => r.createdAt,
      take: SWEEP_TAKE,
    })
  );

  if (stuck.length === 0) return { swept: 0, resent: 0, alerted: 0 };

  let resent = 0;
  await step.run('resend-order-created', async () => {
    for (const o of stuck) {
      try {
        await inngest.send({
          name: 'order/created',
          data: {
            orderId: o.id,
            storeId: o.storeId,
            // Recovery re-send: these are all paid (online) orders. The fanout
            // only uses paymentMethod for the admin-push display string.
            paymentMethod: 'online',
            locale: o.locale ?? undefined,
          },
        });
        resent += 1;
      } catch (err) {
        logger.error({ err, orderId: o.id }, '[order-created-stuck-sweep] re-send failed');
      }
    }
  });
  logger.warn(
    { count: stuck.length, resent },
    '[order-created-stuck-sweep] re-sent order/created for paid-but-unnotified orders'
  );

  // Orders still unnotified past 3× the window mean the re-send itself isn't
  // landing (persistent Inngest delivery problem) — page an operator.
  const veryStaleCutoff = Date.now() - 3 * STUCK_ORDER_NOTIFY_MINUTES * 60_000;
  // new Date(): `stuck` is a memoized step.run result, so createdAt is an ISO
  // string on replay, not a Date (issue 2284's class).
  const veryStale = stuck.filter(o => new Date(o.createdAt).getTime() < veryStaleCutoff);
  if (veryStale.length > 0) {
    await step.run('alert-very-stale', async () => {
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'order.created.stuck',
        title: `order/created fanout stuck for ${veryStale.length} paid order(s)`,
        body:
          `${veryStale.length} PAID order(s) still have no order/created fanout after ` +
          `> ${3 * STUCK_ORDER_NOTIFY_MINUTES}m — no confirmation email, admin push, ` +
          `WhatsApp notify, CAPI, or accounting journal entry. Re-send isn't landing; ` +
          `investigate Inngest delivery.`,
        context: {
          ids: veryStale.slice(0, 20).map(o => o.id),
          oldestCreatedAt: veryStale[0]
            ? new Date(veryStale[0].createdAt).toISOString()
            : undefined,
        },
      }).catch(() => undefined);
    });
    logger.error(
      { count: veryStale.length },
      '[order-created-stuck-sweep] very-stale paid orders — P1 alerted'
    );
  }

  return { swept: stuck.length, resent, alerted: veryStale.length };
}

export const orderCreatedStuckSweep: JobDef = inngest.createFunction(
  {
    id: 'order-created-stuck-sweep',
    name: 'Order created — sweep paid-but-unnotified orders',
    retries: 1,
    // CADENCE NOTE (2026-08-09) — this is a COST control, not a preference.
    //
    // Neon suspends a compute after 5 minutes idle. Anything polling the database
    // every 5 minutes therefore resets the idle timer just before it fires, and the
    // compute NEVER sleeps. Measured: a previous project ran 195 active hours out of 195 and
    // burned 193 CU-h/month — 76% of the whole account allowance — while the menu
    // projects, which idle normally, used 7-17.
    //
    // order-created-stuck-sweep is threshold-driven: it looks for rows stale by
    // STUCK_ORDER_NOTIFY_MINUTES (10) minutes, so polling every 5 was oversampling it. At */15 the worst-case
    // detection window moves from 10-15 to 10-25 minutes, and the database gets a
    // ~10 minute sleep gap every cycle.
    //
    // Do NOT tighten this back to */5 without re-checking the Neon bill: the whole
    // saving comes from leaving a gap LONGER than the 300s suspend timeout.
    // HOURLY (Ruling INNGEST-BUDGET-1): Inngest Hobby caps executions at 50k/month and Ebda is pre-launch;
    // worst-case detection of a lost order/created enqueue is now 10-70 min, not 10-25.
    // Revisit at launch, when real orders exist (docs/RULINGS.md, docs/ENVIRONMENT.md).
    triggers: [{ cron: '7 * * * *' }], // hourly, off the :00 pile-up
  },
  async ({ step, event }) => handleOrderCreatedStuckSweep(step, event)
);
