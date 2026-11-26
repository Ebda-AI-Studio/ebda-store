/**
 * REVENUE-DEF-1 backfill of `funnel_snapshots` rows written before the revenue definition netted refunds.
 * The nightly rollup recomputes only the last 7 Cairo days, so older days stay as written: this fixes them.
 *
 * `insights/funnel-backfill-requested` { storeId, daysBack?: 1..400 (90), apply?: boolean }
 *   DRY RUN BY DEFAULT: with `apply` absent/false it only reports (return value + log) the days whose stored revenue differs.
 *   `apply: true` rewrites exactly those days' revenueFils + ordersCompleted ONLY (correctFunnelRevenueDay: every other column is
 *   left as the nightly run wrote it), 30 days per step. Idempotent: recomputed from the orders, no deltas.
 * Cohort + RFM rows are rebuilt from the whole paid-order history by every nightly run, so they converge within 24 h with no
 * backfill; only the funnel's per-day rows need this.
 */
import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { runInStoreCtx } from '../../jobs/store-db';
import { isStoreGoneError } from '../../jobs/store-gone';
import { storeRepo } from '../../repo-factory';
import {
  correctFunnelRevenueDay,
  funnelDriftDays,
} from '../../../services/accounting/analytics-rollup.service';
import logger from '../../logger';

const FUNNEL_BACKFILL_DEFAULT_DAYS = 90;
const FUNNEL_BACKFILL_MAX_DAYS = 400;
/** days rewritten per Inngest step */
const FUNNEL_BACKFILL_CHUNK = 30;

// pq-allow(unused-export): imported by tests/unit/revenue-definition.test.ts
export function clampBackfillDays(n: unknown): number {
  const v =
    typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : FUNNEL_BACKFILL_DEFAULT_DAYS;
  return Math.min(FUNNEL_BACKFILL_MAX_DAYS, Math.max(1, v));
}

export const analyticsFunnelBackfill: JobDef = inngest.createFunction(
  {
    id: 'analytics-funnel-backfill',
    name: 'Insights - backfill funnel revenue to the net-sales definition (dry run by default)',
    retries: 1,
    concurrency: [{ limit: 2 }, { key: 'event.data.storeId', limit: 1 }],
    triggers: [{ event: 'insights/funnel-backfill-requested' }],
  },
  async ({ event, step }) => {
    const { storeId, daysBack, apply } = (event.data ?? {}) as {
      storeId?: string;
      daysBack?: number;
      apply?: boolean;
    };
    if (!storeId) return { skipped: 'missing-storeId' };
    const days = clampBackfillDays(daysBack);
    const live = await step.run('store-live', async () => {
      try {
        await storeRepo(storeId);
        return true;
      } catch (err) {
        if (isStoreGoneError(err)) return false;
        throw err;
      }
    });
    if (!live) return { skipped: 'store-gone' };
    // ONE read (two queries, however many days), then the rewrite in chunked steps so no step runs 400 writes.
    const drift = await step.run('drift', () =>
      runInStoreCtx(storeId, () => funnelDriftDays(storeId, days))
    );
    if (apply !== true) {
      logger.info({ storeId, days, drift: drift.length }, 'funnel-backfill DRY RUN');
      return { mode: 'dry-run' as const, days, drift };
    }
    let rewritten = 0;
    for (let i = 0; i < drift.length; i += FUNNEL_BACKFILL_CHUNK) {
      const chunk = drift.slice(i, i + FUNNEL_BACKFILL_CHUNK);
      rewritten += await step.run(`apply-${i / FUNNEL_BACKFILL_CHUNK}`, () =>
        runInStoreCtx(storeId, async () => {
          let n = 0;
          for (const d of chunk) n += await correctFunnelRevenueDay(storeId, d.daysAgo);
          return n;
        })
      );
    }
    logger.info({ storeId, days, rewritten }, 'funnel-backfill applied');
    return { mode: 'applied' as const, days, drift, rewritten };
  }
);
