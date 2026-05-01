import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { BulkService } from '../../../services/bulk.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Long-running bulk product import. Picks up the BulkImportJob row,
 * runs the existing BulkService.importProducts, and writes the
 * outcome back to the row so the polling endpoint can render the
 * final summary.
 *
 * Why async: imports of 5k+ rows used to block the request thread
 * for 30-90s. The HTTP layer would time out before the import
 * finished, leaving the admin with no idea whether to retry.
 */
export const bulkImportProducts: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-import-products',
    name: 'Bulk import products from CSV',
    // Imports per-store are serialised — a tenant can't queue ten
    // imports in parallel and lock their own products table.
    concurrency: { key: 'event.data.storeId', limit: 1 },
    // No automatic retries — a failed import that ran halfway can
    // produce duplicate products on retry. Failures surface to the
    // admin via the job row's errorMessage instead.
    retries: 0,
    triggers: [{ event: 'bulk-import/started' }],
  },
  async ({ event }) => {
    const { jobId } = event.data;

    // Inngest may invoke this function with an empty test payload during
    // sync / replay. Guard before hitting Prisma — `findUnique` with
    // `id: undefined` throws a validation error and counts as a failed
    // run in the UI, masking real failures.
    if (!jobId) {
      logger.warn('bulk-import/started fired without jobId — skipping');
      return;
    }

    const job = await prisma.bulkImportJob.findUnique({ where: { id: jobId } });
    if (!job) {
      logger.warn({ jobId }, 'bulk-import/started fired for missing job');
      return;
    }

    await prisma.bulkImportJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      const result = await BulkService.importProducts(
        job.storeId,
        job.csvData,
        { updateExisting: job.updateExisting },
        job.userId ?? undefined
      );

      await prisma.bulkImportJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          total: result.total,
          processed: result.total,
          created: result.created,
          updated: result.updated,
          failed: result.failed,
          errors: result.errors,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, jobId }, 'Bulk import job failed');
      await prisma.bulkImportJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          errorMessage: message,
          completedAt: new Date(),
        },
      });
    }
  }
);
