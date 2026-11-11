import type { JobDef } from '../../jobs/types';
import { writeBulkProductFields } from '../../../services/ai-autofill.service';
import { storeWriter } from '../../../lib/repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { runInStoreScope } from '@ebda/database';
import type { AiFieldSources } from '@ebda/shared';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { generateProductExcerpt } from '../../ai/product-excerpt-generator';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

/**
 * Catalogue-wide product-excerpt sweep.
 *
 * Derives a 1-2 sentence bilingual excerpt from each product's full
 * description and writes `Product.excerpt` / `excerptAr`, stamping
 * `aiFieldSources.excerpt` / `.excerptAr` = 'ai' (the same provenance map
 * `ai-autofill.service.ts` uses) so a merchant's manual edit is never
 * silently overwritten.
 *
 * Re-sweep semantics:
 *   - Default: skip a product whose `excerpt` is already non-empty
 *     (human OR ai-written — smart-skip, counts as skipped).
 *   - `force: true`: re-generate only products whose CURRENT excerpt is
 *     empty OR ai-owned (`aiFieldSources.excerpt === 'ai'`). A human-owned
 *     excerpt (present, no 'ai' provenance, or explicitly stamped 'human')
 *     is never touched, matching the ai-autofill `canWrite` guard.
 *
 * PR2 — crash-resumable batching. The product id list is loaded ONCE inside
 * `step.run('load-items', ...)`, then split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)`. A
 * crash mid-sweep resumes at the first unfinished batch. Each item re-reads
 * its own excerpt + aiFieldSources fresh (not the load-items snapshot) so a
 * retried batch never re-spends a Gemini call on a product already filled.
 *
 * Same guardrails as every other bulk-AI sweep: concurrency 1/store,
 * retries 2, AI_BULK_THROTTLE_MS throttle, assertAiQuota before each Gemini
 * call, error cap 50, cooperative cancellation at batch boundaries.
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface BulkError {
  entityKind: 'product';
  entityId: string;
  entityName: string;
  error: string;
}

interface BatchResult {
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errors: BulkError[];
  quotaReached: boolean;
  cancelled: boolean;
}

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type when the returned object mixes a plain string[]
// with a richer array-of-objects sibling (the annotation widens the
// contextual type fed into `createFunction`'s generics, and Jsonify then
// collapses the string[] to `unknown[]`). Assigning to the annotated export
// on a separate line avoids feeding the annotation back into inference.
const bulkAiExcerptFn = inngest.createFunction(
  {
    id: 'bulk-ai-excerpt',
    name: 'Bulk: draft product excerpts across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/excerpt-requested' }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      storeId,
      force = false,
    } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/excerpt-requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object

      const sdb = lazyStoreDb(storeId);

      const sw = lazyStoreWriter(storeId);
      await step.run('mark-running', () =>
        sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date(), force },
        })
      );

      const apiKey = config.googleAiKey;
      if (!apiKey) {
        throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
      }

      const { storeName, productIds } = await step.run('load-items', async () => {
        const store = await lazyStoreDb(storeId).store.findUnique({
          where: { id: storeId },
          select: { name: true },
        });
        const products = await sdb.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: { id: true },
        });
        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: products.length },
        });
        return { storeName: store?.name ?? storeId, productIds: products.map(p => p.id) };
      });

      const batches = chunk(productIds, BULK_AI_BATCH_SIZE);

      const errors: BulkError[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];

        const result: BatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await sdb.bulkAiJob.findUnique({
            where: { id: jobId, storeId },
            select: { status: true },
          });
          if (currentJob?.status === 'cancelled') {
            return {
              processed: 0,
              filled: 0,
              skipped: 0,
              failed: 0,
              errors: [],
              quotaReached: false,
              cancelled: true,
            };
          }

          const items = await sdb.product.findMany({
            where: { id: { in: batchIds }, storeId },
            select: {
              id: true,
              name: true,
              nameAr: true,
              description: true,
              descriptionAr: true,
              excerpt: true,
              excerptAr: true,
              aiFieldSources: true,
            },
          });
          const byId = new Map(items.map(p => [p.id, p]));

          let bProcessed = 0;
          let bFilled = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: BulkError[] = [];

          for (const id of batchIds) {
            const product = byId.get(id);
            if (!product) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            const sources = (product.aiFieldSources as AiFieldSources) ?? {};
            const hasExcerpt = !!product.excerpt?.trim();
            // Safe to (re)write only if empty, or explicitly ai-owned (force
            // refresh). A human-owned or unprovenanced-but-present excerpt is
            // never touched — mirrors ai-autofill.service's canWrite guard.
            const canWrite = !hasExcerpt || (force && sources.excerpt === 'ai');

            if (!canWrite) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              await assertAiQuota({ storeId, bulk: true });

              const result = await callWithRetry(
                () =>
                  generateProductExcerpt(
                    {
                      storeId,
                      storeName,
                      product: {
                        name: product.name,
                        nameAr: product.nameAr,
                        description: product.description,
                        descriptionAr: product.descriptionAr,
                      },
                    },
                    apiKey,
                    MODEL
                  ),
                `excerpt:${product.id}`
              );

              if (!result.excerpt.trim() && !result.excerptAr.trim()) {
                bSkipped++;
              } else {
                await writeBulkProductFields(
                  storeId,
                  product.id,
                  product,
                  { excerpt: result.excerpt, excerptAr: result.excerptAr },
                  { overwrite: force && hasExcerpt }
                );
                bFilled++;
              }
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                logger.warn({ storeId, jobId }, 'bulk-ai-excerpt: quota cap hit, aborting sweep');
                bQuotaReached = true;
                break;
              }
              if (bErrors.length < ERROR_CAP) {
                bErrors.push({
                  entityKind: 'product',
                  entityId: product.id,
                  entityName: product.name,
                  error:
                    err instanceof AppError
                      ? err.message
                      : 'AI request failed — please try again shortly.',
                });
              }
              bFailed++;
            }

            bProcessed++;
            await sleep(THROTTLE_MS);
          }

          return {
            processed: bProcessed,
            filled: bFilled,
            skipped: bSkipped,
            failed: bFailed,
            errors: bErrors,
            quotaReached: bQuotaReached,
            cancelled: false,
          };
        });

        processed += result.processed;
        filled += result.filled;
        skipped += result.skipped;
        failed += result.failed;
        for (const e of result.errors) {
          if (errors.length < ERROR_CAP) errors.push(e);
        }

        await step.run(`progress-${i}`, () =>
          sw.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { processed, filled, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, filled, skipped, failed },
            'bulk-ai-excerpt: cancelled by merchant'
          );
          break;
        }
        if (result.quotaReached) {
          quotaReached = true;
          if (errors.length < ERROR_CAP) {
            errors.push({
              entityKind: 'product',
              entityId: storeId,
              entityName: 'sweep',
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
        const finalRow = await sdb.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: finalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
            processed,
            filled,
            skipped,
            failed,
            errors: errors as object,
            completedAt: new Date(),
          },
        });
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-excerpt complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiExcerpt: JobDef = bulkAiExcerptFn;
