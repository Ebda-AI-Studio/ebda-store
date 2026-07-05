import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Cleanup orphan bulk-import jobs.
 *
 * The bulk-import-products function intentionally runs at `retries: 0`
 * (per its doc comment — retrying a half-run import creates duplicate
 * products). But that means a process restart mid-run (Railway redeploy,
 * OOM kill, container crash) leaves the BulkImportJob row stuck in
 * `running` forever with no failure marker. The admin sees "importing..."
 * indefinitely and can't cancel without DB intervention.
 *
 * This scheduled function runs every 4 hours and flips any `running`
 * job whose `startedAt` is older than 1 hour to `failed`. 1 hour is a
 * generous ceiling — even a 50k-row import completes well inside that
 * on the current Railway instance. Anything older is orphaned.
 *
 * Cadence: every-4h, not every-15-min (changed 2026-07-05). The 15-min cron
 * woke the Neon compute ~33% of every idle hour, defeating autosuspend
 * (min_cu 0.25 / suspend 300s) — a real always-on compute cost. Every 4h
 * cuts idle-wake to ~2% while keeping orphan cleanup responsive: a crashed
 * import is marked failed within ~5h. Orphans are rare (only on crash/
 * redeploy mid-import), and during active use the DB is warm from real
 * traffic anyway.
 *
 * Surfaced by the 2026-05-22 SaaS audit (P1-5). Alternative considered:
 * raising bulk-import-products `retries` to 2. Rejected — would violate
 * the deliberate "no duplicate products on retry" design intent.
 */
export const bulkImportOrphanCleanup: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-import-orphan-cleanup',
    name: 'Mark orphaned bulk-import jobs as failed',
    retries: 1,
    triggers: [{ cron: '0 */4 * * *' }],
  },
  async () => {
    const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

    const orphans = await withRlsBypass(tx =>
      tx.bulkImportJob.findMany({
        where: {
          status: 'running',
          startedAt: { lt: orphanCutoff },
        },
        select: { id: true, storeId: true, startedAt: true },
      })
    );

    if (orphans.length === 0) {
      return { orphansSwept: 0 };
    }

    await withRlsBypass(tx =>
      tx.bulkImportJob.updateMany({
        where: { id: { in: orphans.map(o => o.id) } },
        data: {
          status: 'failed',
          errorMessage:
            'Job orphaned — process restarted mid-import without completing. Re-upload the CSV to retry.',
          completedAt: new Date(),
        },
      })
    );

    logger.warn(
      { orphansSwept: orphans.length, jobIds: orphans.map(o => o.id) },
      '[bulk-import-orphan-cleanup] Marked orphaned jobs as failed'
    );

    return { orphansSwept: orphans.length };
  }
);
