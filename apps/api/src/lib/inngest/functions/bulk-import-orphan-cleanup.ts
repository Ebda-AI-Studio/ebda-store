import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
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
 * This scheduled function runs every 15 minutes and flips any `running`
 * job whose `startedAt` is older than 1 hour to `failed`. 1 hour is a
 * generous ceiling — even a 50k-row import completes well inside that
 * on the current Railway instance. Anything older is orphaned.
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
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async () => {
    const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

    const orphans = await prisma.bulkImportJob.findMany({
      where: {
        status: 'running',
        startedAt: { lt: orphanCutoff },
      },
      select: { id: true, storeId: true, startedAt: true },
    });

    if (orphans.length === 0) {
      return { orphansSwept: 0 };
    }

    await prisma.bulkImportJob.updateMany({
      where: { id: { in: orphans.map(o => o.id) } },
      data: {
        status: 'failed',
        errorMessage:
          'Job orphaned — process restarted mid-import without completing. Re-upload the CSV to retry.',
        completedAt: new Date(),
      },
    });

    logger.warn(
      { orphansSwept: orphans.length, jobIds: orphans.map(o => o.id) },
      '[bulk-import-orphan-cleanup] Marked orphaned jobs as failed'
    );

    return { orphansSwept: orphans.length };
  }
);
