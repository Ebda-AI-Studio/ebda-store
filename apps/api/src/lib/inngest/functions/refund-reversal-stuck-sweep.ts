import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { handleStuckRefundClaimSweep } from './refund-claim-stuck-sweep';

/**
 * Stuck refund-reversal sweep — scheduled safety net (every 5 min).
 *
 * The mirror of `order-created-stuck-sweep`, for the `order/refunded` fanout.
 *
 * `OrderService.applyRefundEffects` only ENQUEUES `order/refunded`; the actual
 * reversals (inventory restore, coupon usage, affiliate commission, loyalty
 * points, backorder lines) run in the fanout. A FAILED enqueue propagates and
 * every call site handles it — but a SUCCESSFUL enqueue whose event is never
 * consumed (Inngest outage, bad signing key, worker never came up, event
 * dropped mid-deploy) is completely silent. The order reads `cancelled`, the
 * customer has their money back, and the stock is never returned. Nobody finds
 * out until a merchant notices phantom out-of-stock.
 *
 * This sweep finds orders whose whole-order reversal was REQUESTED
 * (`refundReversalRequestedAt`, stamped at every stock-restoring enqueue by
 * applyRefundEffects — status-agnostic and immune to later unrelated writes)
 * but never claimed (`refundReversedAt IS NULL`) past the staleness window, and
 * re-sends `order/refunded` once per tick. Orders that predate that column fall
 * back to the original cancelled/refunded + updatedAt predicate.
 *
 * WHY A CLAIM COLUMN AND NOT THE InventoryHistory MARKER: the `return_stock`
 * marker is legitimately absent in two cases — `restoreInventory: false`
 * (backorder-line cancels, where the stock was never reserved) and orders whose
 * products are all `track_inventory = false`. Sweeping on marker-absence would
 * re-fire those every 5 minutes forever, and for the backorder case would
 * invent stock that never existed — a money bug in the opposite direction.
 * `Order.refundReversedAt` is stamped by the fanout's LAST step whenever it
 * runs to completion, whether or not any stock actually moved, so it means
 * exactly "the reversals ran" and nothing else.
 *
 * Idempotency-safe: a re-sent event re-executes every step, and all five
 * reversals are idempotent at the data layer — inventory via the `return_stock`
 * marker + an order-level FOR UPDATE lock, coupon via the `coupon_reversed`
 * OrderEvent marker, affiliate via its `status: 'commission_paid'` guard,
 * loyalty via tagged adjust rows, backorders via the `fulfilledAt/cancelledAt`
 * null guards. The claim step itself is scoped to `refundReversedAt: null`, so a
 * re-fire never overwrites the original completion timestamp.
 */
interface StuckReversal {
  id: string;
  storeId: string;
  status: string;
  updatedAt: Date;
  refundReversalRequestedAt: Date | null;
}

/** When the reversal was requested — the immutable clock when we have one. */
const requestedAt = (o: StuckReversal): Date => o.refundReversalRequestedAt ?? o.updatedAt;

const REFUND_REVERSAL_STUCK_MINUTES = Number(process.env.REFUND_REVERSAL_STUCK_MINUTES) || 10;

// RECENCY FLOOR — load-bearing, not an optimization.
//
// `refund_reversed_at` is NULL for EVERY cancelled/refunded order that predates
// the column, i.e. the entire historical order book. Without a lower bound the
// first tick after deploy would re-fire `order/refunded` for all of them.
// `order-created-stuck-sweep` shipped exactly that bug on 2026-07-09 (its P0
// comment documents re-notifying every paid order in history); the reversals are
// idempotent so the blast radius here is smaller, but it would still stampede
// Inngest and re-run five reversal steps across every order ever cancelled.
// A genuinely-stuck reversal is caught within minutes; 12h is a generous ceiling.
const REFUND_REVERSAL_MAX_AGE_MINUTES = Number(process.env.REFUND_REVERSAL_MAX_AGE_MINUTES) || 720;

const SWEEP_TAKE = 200;

/** Minimal shape of the Inngest `step` this handler uses (kept for unit tests). */
interface SweepStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Extracted handler (testable in isolation — mirrors order-created-stuck-sweep).
 * The `createFunction` wrapper below just forwards `step`.
 */
export async function handleRefundReversalStuckSweep(
  step: SweepStep
): Promise<{ swept: number; resent: number; alerted: number }> {
  const cutoff = new Date(Date.now() - REFUND_REVERSAL_STUCK_MINUTES * 60_000);
  const floorCutoff = new Date(Date.now() - REFUND_REVERSAL_MAX_AGE_MINUTES * 60_000);

  // Cross-tenant read — Inngest crons run outside tenant-context middleware.
  const stuck: StuckReversal[] = await step.run('find-stuck-reversals', async () =>
    withRlsBypass(tx =>
      tx.order.findMany({
        where: {
          refundReversedAt: null,
          // Window: reversal is overdue, but NOT older than the recency floor —
          // so the historical back-catalog is never re-fired.
          OR: [
            // Every whole-order stock-restoring enqueue stamps this
            // (applyRefundEffects). Status-agnostic (a manual full return
            // leaves the order `delivered`, #839) and immutable (a later
            // tracking edit or webhook does not move it, #855).
            { refundReversalRequestedAt: { lt: cutoff, gt: floorCutoff } },
            // Legacy rows cancelled before that column existed: the original
            // status + updatedAt predicate, unchanged. Empty within one
            // recency floor of the deploy.
            {
              refundReversalRequestedAt: null,
              status: { in: ['cancelled', 'refunded'] },
              updatedAt: { lt: cutoff, gt: floorCutoff },
            },
          ],
        },
        select: {
          id: true,
          storeId: true,
          status: true,
          updatedAt: true,
          refundReversalRequestedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: SWEEP_TAKE,
      })
    )
  );

  if (stuck.length === 0) return { swept: 0, resent: 0, alerted: 0 };

  let resent = 0;
  await step.run('resend-order-refunded', async () => {
    for (const o of stuck) {
      try {
        await inngest.send({
          name: 'order/refunded',
          data: {
            orderId: o.id,
            storeId: o.storeId,
            // Recovery re-send: restore stock (the fanout's own marker check
            // makes this a no-op if it somehow already ran) but never re-fire
            // the "Refund issued" merchant push / customer refund email — this
            // is a plumbing retry, not a new refund event.
            restoreInventory: true,
            notify: false,
          },
        });
        resent += 1;
      } catch (err) {
        logger.error({ err, orderId: o.id }, '[refund-reversal-stuck-sweep] re-send failed');
      }
    }
  });
  logger.warn(
    { count: stuck.length, resent },
    '[refund-reversal-stuck-sweep] re-sent order/refunded for unreversed cancelled/refunded orders'
  );

  // Orders still unreversed past 3× the window mean the re-send itself isn't
  // landing (persistent Inngest delivery problem) — page an operator. Stock
  // sitting un-restored is lost sales, so this is a P1.
  const veryStaleCutoff = Date.now() - 3 * REFUND_REVERSAL_STUCK_MINUTES * 60_000;
  const veryStale = stuck.filter(o => requestedAt(o).getTime() < veryStaleCutoff);
  if (veryStale.length > 0) {
    await step.run('alert-very-stale', async () => {
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'order.refund.reversal.stuck',
        title: `order/refunded reversals stuck for ${veryStale.length} order(s)`,
        body:
          `${veryStale.length} refunded/cancelled order(s) still have no reversal after ` +
          `> ${3 * REFUND_REVERSAL_STUCK_MINUTES}m — inventory NOT restored, coupon/loyalty/` +
          `affiliate NOT reversed. Stock is silently missing from the catalogue. ` +
          `Re-send isn't landing; investigate Inngest delivery.`,
        context: {
          ids: veryStale.slice(0, 20).map(o => o.id),
          oldestRequestedAt: veryStale[0] ? requestedAt(veryStale[0]).toISOString() : undefined,
        },
      }).catch(() => undefined);
    });
    logger.error(
      { count: veryStale.length },
      '[refund-reversal-stuck-sweep] very-stale unreversed orders — P1 alerted'
    );
  }

  return { swept: stuck.length, resent, alerted: veryStale.length };
}

export const refundReversalStuckSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'refund-reversal-stuck-sweep',
    name: 'Refund reversal — sweep cancelled/refunded orders whose reversal never ran',
    retries: 1,
    // CADENCE NOTE (2026-08-09) — this is a COST control, not a preference.
    //
    // Neon suspends a compute after 5 minutes idle. Anything polling the database
    // every 5 minutes therefore resets the idle timer just before it fires, and the
    // compute NEVER sleeps. Measured: fwb-eu ran 195 active hours out of 195 and
    // burned 193 CU-h/month — 76% of the whole account allowance — while the menu
    // projects, which idle normally, used 7-17.
    //
    // refund-reversal-stuck-sweep is threshold-driven: it looks for rows stale by
    // REFUND_REVERSAL_STUCK_MINUTES (10) minutes, so polling every 5 was oversampling it. At */15 the worst-case
    // detection window moves from 10-15 to 10-25 minutes, and the database gets a
    // ~10 minute sleep gap every cycle.
    //
    // Do NOT tighten this back to */5 without re-checking the Neon bill: the whole
    // saving comes from leaving a gap LONGER than the 300s suspend timeout.
    triggers: [{ cron: '*/15 * * * *' }], // every 15 min — see CADENCE NOTE
  },
  async ({ step }) => {
    const reversals = await handleRefundReversalStuckSweep(step);
    // Same tick, same wake-up of the database — see refund-claim-stuck-sweep.ts.
    const claims = await handleStuckRefundClaimSweep(step);
    return { ...reversals, stuckRefundClaims: claims.stuck };
  }
);
