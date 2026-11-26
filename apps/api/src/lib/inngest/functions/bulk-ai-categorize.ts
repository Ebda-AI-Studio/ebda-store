import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../../lib/repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { runInStoreScope } from '@ebda/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { suggestProductCategory } from '../../ai/product-category-suggester';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

/**
 * Catalogue-wide category-assignment sweep — uncategorized products only.
 *
 * For every product with ZERO categories, asks Gemini to pick the single
 * best match from the STORE'S OWN existing categories (never invents a new
 * one — mirrors the per-product `/suggest-categories` logic). If nothing is
 * a confident match, the product is left uncategorized (counts as skipped,
 * not failed).
 *
 * `force` is accepted for wiring consistency with every other bulk sweep
 * but is intentionally a NO-OP here: a product with an existing category is
 * NEVER re-categorized (there's no "AI-owned vs human-owned" provenance on
 * `ProductCategory`, so overwriting would risk clobbering a merchant's
 * manual choice). Re-running the sweep only ever fills gaps.
 *
 * PR2 — crash-resumable batching. The candidate product id list is loaded
 * ONCE inside `step.run('load-items', ...)` (stable set + order across
 * retries), then split into `BULK_AI_BATCH_SIZE`-sized batches, each
 * processed inside its own `step.run(\`batch-${i}\`, ...)`. A crash mid-sweep
 * resumes at the first unfinished batch instead of item 0. Each batch
 * re-reads its items' current category count fresh (not the load-items
 * snapshot) so a retried batch never re-spends a Gemini call on a product
 * that got categorized on a prior attempt.
 *
 * Same guardrails as every other bulk-AI sweep: concurrency 1/store,
 * retries 2, AI_BULK_THROTTLE_MS throttle, assertAiQuota before each call,
 * error cap 50, cooperative cancellation at batch boundaries.
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
const bulkAiCategorizeFn = inngest.createFunction(
  {
    id: 'bulk-ai-categorize',
    name: 'Bulk: assign categories to uncategorized products',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/categorize-requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/categorize-requested fired without ids');
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

      const apiKey = config.googleAiKey;
      if (!apiKey) {
        throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
      }

      const { storeName, existingCategories, productIds } = await step.run(
        'load-items',
        async () => {
          const store = await lazyStoreDb(storeId).store.findUnique({
            where: { id: storeId },
            select: { name: true },
          });

          const cats = await sdb.category.findMany({
            where: { storeId, isActive: true },
            select: { id: true, name: true, nameAr: true },
          });

          // Only uncategorized products are candidates — categorized products
          // are never touched by this sweep.
          const products = await sdb.product.findMany({
            where: { storeId, status: 'active', deletedAt: null, categories: { none: {} } },
            select: { id: true },
          });

          await sw.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { total: products.length },
          });

          return {
            storeName: store?.name ?? storeId,
            existingCategories: cats,
            productIds: products.map(p => p.id),
          };
        }
      );

      const batches = chunk(productIds, BULK_AI_BATCH_SIZE);

      const errors: BulkError[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      if (existingCategories.length === 0) {
        // Nothing to assign from — skip every product cleanly, no batches needed.
        skipped = productIds.length;
        processed = productIds.length;
      } else {
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

            // Fresh per-batch read — the per-item idempotency re-check. A
            // product that got categorized by a prior partial attempt (or
            // concurrently via the per-product suggest endpoint) no longer
            // matches `categories: { none: {} }` and is skipped here.
            const items = await sdb.product.findMany({
              where: { id: { in: batchIds }, storeId, categories: { none: {} } },
              select: { id: true, name: true, description: true },
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
                // Deleted, or already categorized since load-items.
                bSkipped++;
                bProcessed++;
                continue;
              }

              try {
                const aiSlot = await assertAiQuota({ storeId, bulk: true });
                try {
                  const matches = await callWithRetry(
                    () =>
                      suggestProductCategory(
                        {
                          storeId,
                          storeName,
                          product: { name: product.name, description: product.description },
                          existingCategories,
                        },
                        apiKey,
                        MODEL
                      ),
                    `categorize:${product.id}`
                  );

                  const best = matches[0];
                  if (!best) {
                    bSkipped++;
                  } else {
                    await (
                      await storeWriter(storeId)
                    ).productCategory.create({
                      data: { productId: product.id, categoryId: best.id, position: 0 },
                    });
                    bFilled++;
                  }
                } finally {
                  await aiSlot?.release(); // `?.`: test doubles of assertAiQuota resolve to undefined
                }
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  logger.warn(
                    { storeId, jobId },
                    'bulk-ai-categorize: quota cap hit, aborting sweep'
                  );
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
              'bulk-ai-categorize: cancelled by merchant'
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
        { jobId, storeId, filled, skipped, failed, quotaReached },
        'bulk-ai-categorize complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiCategorize: JobDef = bulkAiCategorizeFn;
