import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../repo-factory';
import { acrossStoresDb } from '../../jobs/store-db';
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
export const bulkImportOrphanCleanup: JobDef = inngest.createFunction(
  {
    id: 'bulk-import-orphan-cleanup',
    name: 'Mark orphaned bulk-import jobs as failed',
    retries: 1,
    triggers: [{ cron: '0 */4 * * *' }],
  },
  async ({ event }) => {
    const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

    // `bulk_import_jobs` is store-scoped: sweep it store by store, each in its
    // own scope, and mark that store's orphans failed there.
    // Per store, on the store's backend (Ruling CF-JOBS-4): the cron run visits the Postgres stores, the alarm run of a
    // DO store reads and marks that store's own Durable Object. The mark is a guarded `updateMany` on `running`, so a
    // second delivery finds nothing left to mark.
    const orphans: Array<{ id: string; storeId: string; startedAt: Date | null }> = [];
    await acrossStoresDb(event, async (storeId, db) => {
      const found = await db.bulkImportJob.findMany({
        where: {
          storeId,
          status: 'running',
          startedAt: { lt: orphanCutoff },
        },
        select: { id: true, storeId: true, startedAt: true },
      });
      if (found.length > 0) {
        await (
          await storeWriter(storeId)
        ).bulkImportJob.updateMany({
          where: { id: { in: found.map(o => o.id) }, storeId, status: 'running' },
          data: {
            status: 'failed',
            errorMessage:
              'Job orphaned — process restarted mid-import without completing. Re-upload the CSV to retry.',
            completedAt: new Date(),
          },
        });
      }
      orphans.push(...found);
    });

    if (orphans.length === 0) {
      return { orphansSwept: 0 };
    }

    logger.warn(
      { orphansSwept: orphans.length, jobIds: orphans.map(o => o.id) },
      '[bulk-import-orphan-cleanup] Marked orphaned jobs as failed'
    );

    return { orphansSwept: orphans.length };
  }
);
