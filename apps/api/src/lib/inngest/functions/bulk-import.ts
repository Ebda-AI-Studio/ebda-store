import type { InngestFunction } from 'inngest';
import { prisma, runInStoreScope, withStore } from '@force/database';
import { BulkService } from '../../../services/bulk.service';
import { invalidateStoreProductCaches } from '../../public-cache';
import logger from '../../logger';
import { inngest } from '../client';
import { getEntityStoreId } from '../../definer';

/**
 * True when a bulk import actually wrote/changed products and the public
 * product caches (list/detail/suggest) should be busted. Extracted as a
 * pure function so the gating logic is unit-testable without standing up
 * the full Inngest handler's `$transaction`/RLS-context machinery (matches
 * the `webhook-offload.guard.ts` pattern elsewhere in this directory).
 */
export function shouldInvalidateAfterBulkImport(result: {
  created: number;
  updated: number;
}): boolean {
  return result.created > 0 || result.updated > 0;
}

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

    // BulkImportJob is a store-scoped job table: the event names the store (a
    // replayed event without one is resolved by primary key through a definer)
    // and the job is read inside that store's scope.
    const jobStoreId = event.data.storeId ?? (await getEntityStoreId('bulk_import_job', jobId));
    const job = jobStoreId
      ? await withStore(jobStoreId, tx => tx.bulkImportJob.findUnique({ where: { id: jobId } }))
      : null;
    if (!job) {
      logger.warn({ jobId }, 'bulk-import/started fired for missing job');
      return;
    }

    // From here we know the storeId. Use runInStoreScope so all subsequent
    // reads/writes (Products, Categories, BulkImportJob status) go through the
    // tenant's RLS policies rather than silently returning 0 rows.
    //
    // NOT runInTenantContext: importProducts creates categories/tags first and
    // then links them from its own `withMoneyTx` batches. Those batches are
    // separate transactions, so under ONE outer tenant transaction they could
    // not see the not-yet-committed categories — every import that introduced
    // a NEW category or tag failed with a product_categories FK violation (and
    // a 5k-row import also outlived the 30s interactive-transaction limit).
    // A store scope holds no long transaction: each query commits on its own,
    // and withMoneyTx batches start with the same store GUC.
    await runInStoreScope(job.storeId, async () => {
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

        // Bust the public product-facing caches ONCE after the whole batch
        // finishes (not per-row — `importProducts` writes in 50-row batches
        // and a sweep per batch would be a needless invalidation storm).
        // Without this, `BulkService.importProducts()` writes products via
        // raw Prisma calls with no cache awareness, so a merchant who just
        // imported/updated their whole catalog would keep seeing the
        // pre-import product list/detail/suggest cache for up to the full
        // 120s TTL regardless of import size (M2, see
        // docs/audits/2026-07-13-cache-stampede.md).
        if (shouldInvalidateAfterBulkImport(result)) {
          await invalidateStoreProductCaches(job.storeId);
        }

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
    });
  }
);
