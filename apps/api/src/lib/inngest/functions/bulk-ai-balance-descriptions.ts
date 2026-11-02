import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { prisma, runInStoreScope } from '@ebda/database';
import { balanceProductLanguages } from '../../../services/ai-autofill.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { inngest } from '../client';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

/**
 * Bulk description-language balancer. Walks every active product for the
 * store, detects which language (EN/AR) has the richer description, and
 * translates it into the thinner language. Writes a revert snapshot before
 * touching each product so the merchant can always undo via the per-product
 * or bulk-revert routes.
 *
 * Concurrency capped at 1 per store (matching the translate bulk pattern).
 * 2.5s throttle between calls to stay within Gemini free-tier RPM.
 *
 * PR2 — crash-resumable batching. The product id list is loaded ONCE inside
 * `step.run('load-items', ...)`, then split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)`. A
 * crash mid-sweep resumes at the first unfinished batch. `force: false` is
 * always passed to `balanceProductLanguages`, which itself short-circuits an
 * already-balanced pair — so a retried batch is naturally idempotent with no
 * extra re-check needed here.
 */

const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const ERROR_CAP = 50;
const FILLED_CAP = 200;

interface BulkBalanceError {
  productId: string;
  productName: string;
  error: string;
}

interface FilledProduct {
  id: string;
  name: string;
}

interface BalanceBatchResult {
  processed: number;
  balanced: number;
  skipped: number;
  failed: number;
  errors: BulkBalanceError[];
  filledProducts: FilledProduct[];
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
const bulkAiBalanceDescriptionsFn = inngest.createFunction(
  {
    id: 'bulk-ai-balance-descriptions',
    name: 'Bulk: balance EN/AR descriptions across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/balance-descriptions.requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data as { jobId: string; storeId: string };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/balance-descriptions.requested fired without ids');
      return;
    }

    // `bulk_ai_jobs` and `ai_usage` carry STRICT RLS policies, so this job
    // needs the store's context — but AI work must never run inside a
    // long-lived DB transaction (#461). `runInStoreScope` gives each query its
    // own short tenant transaction instead.
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

      const errors: BulkBalanceError[] = [];
      const filledProducts: FilledProduct[] = [];
      let processed = 0;
      let balanced = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];

        const result: BalanceBatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await sdb.bulkAiJob.findUnique({
            where: { id: jobId, storeId },
            select: { status: true },
          });
          if (currentJob?.status === 'cancelled') {
            return {
              processed: 0,
              balanced: 0,
              skipped: 0,
              failed: 0,
              errors: [],
              filledProducts: [],
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
          let bBalanced = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: BulkBalanceError[] = [];
          const bFilledProducts: FilledProduct[] = [];

          for (const id of batchIds) {
            const p = byId.get(id);
            if (!p) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              // force:false — balanceProductLanguages itself short-circuits an
              // already-balanced pair, making this naturally idempotent across
              // a retried batch.
              const balanceResult = await balanceProductLanguages(storeId, p.id, { force: false });
              if (balanceResult.balanced) {
                bBalanced++;
                if (bFilledProducts.length < FILLED_CAP) {
                  bFilledProducts.push({ id: p.id, name: p.name });
                }
                await sleep(THROTTLE_MS);
              } else {
                bSkipped++;
              }
            } catch (err) {
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
            balanced: bBalanced,
            skipped: bSkipped,
            failed: bFailed,
            errors: bErrors,
            filledProducts: bFilledProducts,
            quotaReached: bQuotaReached,
            cancelled: false,
          };
        });

        processed += result.processed;
        balanced += result.balanced;
        skipped += result.skipped;
        failed += result.failed;
        for (const e of result.errors) {
          if (errors.length < ERROR_CAP) errors.push(e);
        }
        for (const fp of result.filledProducts) {
          if (filledProducts.length < FILLED_CAP) filledProducts.push(fp);
        }

        await step.run(`progress-${i}`, () =>
          sw.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: {
              processed,
              filled: balanced,
              skipped,
              failed,
              errors: errors as object,
              filledProducts: filledProducts as object,
            },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, balanced, skipped, failed },
            'bulk-ai-balance-descriptions: cancelled by merchant'
          );
          break;
        }
        if (result.quotaReached) {
          quotaReached = true;
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
            filled: balanced,
            skipped,
            failed,
            errors: errors as object,
            filledProducts: filledProducts as object,
            completedAt: new Date(),
          },
        });
      });

      logger.info(
        { jobId, storeId, balanced, skipped, failed, quotaReached },
        'bulk-ai-balance-descriptions complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiBalanceDescriptions: JobDef = bulkAiBalanceDescriptionsFn;
