import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { prisma, runInStoreScope } from '@ebda/database';
import { revertProductBalance } from '../../../services/ai-autofill.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { inngest } from '../client';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

/**
 * Bulk revert: restores every product's description fields to the snapshot
 * captured before the last balance operation. Products that were never
 * balanced (no `aiBalanceBackup`) are silently skipped.
 *
 * Concurrency capped at 1 per store. No AI calls in the inner loop.
 *
 * PR2 — crash-resumable batching. The product id list is loaded ONCE inside
 * `step.run('load-items', ...)`, then split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)`. A
 * crash mid-sweep resumes at the first unfinished batch. `revertProductBalance`
 * is naturally idempotent (a product with no backup, or already reverted,
 * just reports `reverted: false`), so a retried batch never double-reverts.
 */

const ERROR_CAP = 50;

interface BulkRevertError {
  productId: string;
  productName: string;
  error: string;
}

interface RevertBatchResult {
  processed: number;
  reverted: number;
  skipped: number;
  failed: number;
  errors: BulkRevertError[];
  quotaReached: boolean;
  cancelled: boolean;
}

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const bulkAiRevertBalanceFn = inngest.createFunction(
  {
    id: 'bulk-ai-revert-balance',
    name: 'Bulk: revert EN/AR description balance across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/revert-balance.requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data as { jobId: string; storeId: string };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/revert-balance.requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object

      const sdb = lazyStoreDb(storeId);

      const sw = lazyStoreWriter(storeId);
      await step.run('mark-running', () =>
        sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date() },
        })
      );

      // We list ALL products; revertProductBalance skips those without a
      // backup — this gives an upper bound for the progress bar.
      const productIds = await step.run('load-items', async () => {
        const products = await sdb.product.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });
        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: products.length },
        });
        return products.map(p => p.id);
      });

      const batches = chunk(productIds, BULK_AI_BATCH_SIZE);

      const errors: BulkRevertError[] = [];
      let processed = 0;
      let reverted = 0;
      let skipped = 0;
      let failed = 0;

      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];

        const result: RevertBatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await sdb.bulkAiJob.findUnique({
            where: { id: jobId, storeId },
            select: { status: true },
          });
          if (currentJob?.status === 'cancelled') {
            return {
              processed: 0,
              reverted: 0,
              skipped: 0,
              failed: 0,
              errors: [],
              quotaReached: false,
              cancelled: true,
            };
          }

          const items = await sdb.product.findMany({
            where: { id: { in: batchIds }, storeId },
            select: { id: true, name: true },
          });
          const byId = new Map(items.map(p => [p.id, p]));

          let bProcessed = 0;
          let bReverted = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: BulkRevertError[] = [];

          for (const id of batchIds) {
            const p = byId.get(id);
            if (!p) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              const revertResult = await revertProductBalance(storeId, p.id);
              if (revertResult.reverted) {
                bReverted++;
              } else {
                bSkipped++;
              }
            } catch (err) {
              // quota errors shouldn't appear here (no AI calls), but handle
              // for safety, same as the original — abort gracefully rather
              // than let the error escape the step uncaught.
              if (isAiQuotaCapError(err)) {
                bQuotaReached = true;
                break;
              }
              if (bErrors.length < ERROR_CAP) {
                bErrors.push({
                  productId: p.id,
                  productName: p.name,
                  error: err instanceof Error ? err.message : 'unknown',
                });
              }
              bFailed++;
            }
            bProcessed++;
          }

          return {
            processed: bProcessed,
            reverted: bReverted,
            skipped: bSkipped,
            failed: bFailed,
            errors: bErrors,
            quotaReached: bQuotaReached,
            cancelled: false,
          };
        });

        processed += result.processed;
        reverted += result.reverted;
        skipped += result.skipped;
        failed += result.failed;
        for (const e of result.errors) {
          if (errors.length < ERROR_CAP) errors.push(e);
        }

        await step.run(`progress-${i}`, () =>
          sw.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { processed, filled: reverted, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, reverted, skipped, failed },
            'bulk-ai-revert-balance: cancelled by merchant'
          );
          break;
        }
        if (result.quotaReached) {
          if (errors.length < ERROR_CAP) {
            errors.push({
              productId: storeId,
              productName: 'sweep',
              error: 'AI quota cap reached',
            });
          }
          break;
        }
      }

      // A bulk AI sweep rewrites product-facing content (titles, descriptions,
      // SEO, translations, tags, categories, image alt, FAQs) with raw Prisma
      // writes that carry no cache awareness, so the storefront kept serving
      // the pre-sweep copy until the TTL expired. Bust ONCE at the end, never
      // per item — same discipline as bulk-import (a per-row sweep would be an
      // invalidation storm). This also purges the storefront's Next data cache
      // via the tag the public fetches carry.
      await step.run('bust-product-caches', () => invalidateStoreProductCaches(storeId));

      await step.run('finalize', async () => {
        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: 'completed',
            processed,
            filled: reverted,
            skipped,
            failed,
            errors: errors as object,
            completedAt: new Date(),
          },
        });
      });

      logger.info({ jobId, storeId, reverted, skipped, failed }, 'bulk-ai-revert-balance complete');
    }); // end runInStoreScope
  }
);
export const bulkAiRevertBalance: JobDef = bulkAiRevertBalanceFn;
