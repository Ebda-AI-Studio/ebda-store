import type { JobDef } from '../../jobs/types';
import { runInStoreScope } from '@ebda/database';
import { storeDb, storeWriter } from '../../repo-factory';
import logger from '../../logger';
import { inngest } from '../client';
import { processFile, refreshJobCounters } from '../../catalogue/process-file';
import { catalogueLimits } from '../../catalogue/page-ledger';
import { failJob } from '../../../services/catalog-import.service';

/**
 * Catalogue import: extract every stored file of a job, one durable step per file.
 *
 *  - One file per step, a sleep-after-success throttle between model calls (measured-RPM pattern,
 *    never retry-on-429). A 429 marks the file retryable, pauses, and the job continues.
 *  - An AI cap (platform / store daily) marks the rest `skipped_quota` and stops: retryable later.
 *  - A failed job is never left orphaned: `onFailure` marks it failed; the read-side sweep catches
 *    anything that dies without even that.
 *  - Items land in `catalog_import_items`, never in `products`.
 */
export const catalogImportRun: JobDef = inngest.createFunction(
  {
    id: 'catalog-import-run',
    name: 'Catalogue import: extract products from uploaded files',
    retries: 1,
    concurrency: { key: 'event.data.storeId', limit: 1 },
    triggers: [{ event: 'catalog-import/started' }],
    onFailure: async ({ event }) => {
      const d = event.data?.event?.data as { jobId?: string; storeId?: string } | undefined;
      if (d?.jobId && d.storeId) await failJob(d.storeId, d.jobId, 'JOB_FAILED');
    },
  },
  async ({ event, step }) => {
    const { jobId, storeId } = (event.data ?? {}) as { jobId?: string; storeId?: string };
    if (!jobId || !storeId) {
      logger.warn('catalog-import/started fired without ids');
      return { skipped: 'missing-ids' };
    }

    const plan = await step.run('start', () =>
      runInStoreScope(storeId, async () => {
        const job = await (
          await storeDb(storeId)
        ).catalogImportJob.findFirst({
          where: { id: jobId, storeId },
          select: { status: true, startedAt: true },
        });
        if (!job || job.status === 'cancelled') return { skip: true as const };
        await (
          await storeWriter(storeId)
        ).catalogImportJob.updateMany({
          where: { id: jobId, storeId },
          data: { status: 'processing', startedAt: job.startedAt ?? new Date(), completedAt: null },
        });
        const files = await (
          await storeDb(storeId)
        ).catalogImportFile.findMany({
          where: { jobId, storeId, status: { in: ['stored', 'processing'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        const cats = await (
          await storeDb(storeId)
        ).category.findMany({
          where: { storeId, deletedAt: null },
          select: { name: true, nameAr: true },
          take: 100,
        });
        return {
          skip: false as const,
          fileIds: files.map(f => f.id),
          categories: cats.flatMap(c => [c.name, c.nameAr]).filter((n): n is string => !!n),
        };
      })
    );
    if (plan.skip) return { skipped: 'cancelled-or-missing' };

    const gapMs = Math.max(
      parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10),
      catalogueLimits().minGapMs
    );
    let stopped = false;
    for (const fileId of plan.fileIds) {
      if (stopped) {
        // The AI cap is hit: park the rest as retryable, do not call the model.
        await step.run(`park-${fileId}`, () =>
          runInStoreScope(storeId, async () =>
            (await storeWriter(storeId)).catalogImportFile.updateMany({
              where: { id: fileId, storeId, status: { in: ['stored', 'processing'] } },
              data: { status: 'skipped_quota', errorCode: 'AI_QUOTA_EXCEEDED' },
            })
          )
        );
        continue;
      }
      const r = await step.run(`file-${fileId}`, () =>
        runInStoreScope(storeId, async () => {
          const out = await processFile(storeId, jobId, fileId, plan.categories);
          await refreshJobCounters(storeId, jobId);
          return out;
        })
      );
      if (r.outcome === 'cancelled') return { cancelled: true };
      if (r.stopAll) stopped = true;
      if (r.retryAfterMs) await step.sleep(`backoff-${fileId}`, r.retryAfterMs);
      else if (r.calledModel) await step.sleep(`gap-${fileId}`, gapMs);
    }

    return step.run('finalize', () =>
      runInStoreScope(storeId, async () => {
        const c = await refreshJobCounters(storeId, jobId);
        const first = await (
          await storeDb(storeId)
        ).catalogImportFile.findFirst({
          where: { jobId, storeId, status: { in: ['failed', 'skipped_quota'] } },
          select: { errorCode: true },
        });
        const ok = c.done > 0;
        await (
          await storeWriter(storeId)
        ).catalogImportJob.updateMany({
          where: { id: jobId, storeId, status: 'processing' },
          data: ok
            ? { status: 'review', completedAt: new Date() }
            : {
                status: 'failed',
                errorCode: first?.errorCode ?? 'NO_FILES',
                completedAt: new Date(),
              },
        });
        return { done: c.done, failed: c.failed, skipped: c.skipped };
      })
    );
  }
);
