/**
 * Event-driven rollup correction for a refund (STORE-QA-7). `funnel_snapshots` holds one PRE-AGGREGATED row per Cairo day
 * (`ordersCompleted`, `revenueFils`); the nightly rollup only recomputes the last 7 days, so a refund that lands after the
 * day left that window (a COD return a month later) would leave the day's revenue overstated forever.
 *
 * On every `order/refunded` (full OR partial, any producer) this recomputes the ONE Cairo day the refunded order was
 * placed in, through the same `runFunnelRollup` the cron uses (so the refund is netted by the ONE revenue definition,
 * lib/revenue-sql.ts). Idempotent: it recomputes from the orders, it never applies a delta.
 *
 * Staleness class of the other two rollups (BOUNDED-stale, <= 24 h): cohort + RFM snapshots are rebuilt from the whole
 * paid-order history by the nightly cron (analytics-daily-rollup), so a refund shows up there at the next 02:00 Cairo run.
 */
import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { runInStoreCtx } from '../../jobs/store-db';
import { isStoreGoneError } from '../../jobs/store-gone';
import { storeDb, storeRepo } from '../../repo-factory';
import { runFunnelRollup } from '../../../services/accounting/analytics-rollup.service';
import { regionDayStart } from '@ebda/shared';
import logger from '../../logger';

const DAY_MS = 86_400_000;
/** Whole Cairo days between the order's day and today (>= 1: the rollup never writes today). */
export function cairoDaysAgo(orderCreatedAt: Date, now: Date = new Date()): number {
  const days = Math.round(
    (regionDayStart(now).getTime() - regionDayStart(orderCreatedAt).getTime()) / DAY_MS
  );
  return days;
}

export const analyticsRefundCorrection: JobDef = inngest.createFunction(
  {
    id: 'analytics-refund-correction',
    name: 'Insights — correct the funnel rollup day after a refund',
    retries: 3,
    concurrency: [{ limit: 5 }, { key: 'event.data.storeId', limit: 1 }],
    triggers: [{ event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = (event.data ?? {}) as { orderId?: string; storeId?: string };
    if (!orderId || !storeId) {
      logger.warn({ eventId: event.id }, 'analytics-refund-correction: missing ids, skipping');
      return { skipped: 'missing-ids' };
    }
    return step.run('recompute-day', async () => {
      try {
        await storeRepo(storeId);
      } catch (err) {
        if (isStoreGoneError(err)) return { skipped: 'store-gone' };
        throw err;
      }
      return runInStoreCtx(storeId, async () => {
        const order = await (
          await storeDb(storeId)
        ).order.findFirst({ where: { id: orderId, storeId }, select: { createdAt: true } });
        if (!order) return { skipped: 'order-not-found' };
        const daysAgo = cairoDaysAgo(order.createdAt);
        // Today's row does not exist yet (the nightly run writes yesterday and earlier): nothing to correct.
        if (daysAgo < 1) return { skipped: 'today' };
        const rows = await runFunnelRollup(storeId, daysAgo, daysAgo);
        return { corrected: rows, daysAgo };
      });
    });
  }
);
