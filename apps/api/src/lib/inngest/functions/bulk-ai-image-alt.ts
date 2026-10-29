import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../../lib/repo-factory';
import { prisma, runInStoreScope } from '@ebda/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { generateProductAltText } from '../../ai/product-alt-text-generator';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

/**
 * Catalogue-wide image alt-text sweep (Gemini Vision).
 *
 * Walks every active product, looks at up to IMAGES_PER_PRODUCT_CAP images
 * (ordered by position) that are still missing `alt`, and asks Gemini
 * Vision to write a concise, descriptive alt string for each. A product
 * whose capped image set is already fully alt-filled is skipped entirely
 * (no Gemini calls). `ProductImage` has no AI-vs-human provenance field, so
 * — like category assignment — an image that already has `alt` (however it
 * got there) is NEVER overwritten, regardless of `force`. Re-running the
 * sweep only ever fills gaps left by new images.
 *
 * The per-product image cap protects the Gemini quota from a single
 * many-image product burning the whole sweep's budget; assertAiQuota +
 * the throttle apply PER IMAGE (each is its own Vision call), not per
 * product.
 *
 * Progress is tracked at PRODUCT granularity (matches every other bulk
 * sweep's BulkAiJob shape): a product counts `filled` if at least one of
 * its images got a fresh alt, `skipped` if none needed one, `failed` if
 * every attempted image failed.
 *
 * PR2 — crash-resumable batching. The product id list is loaded ONCE inside
 * `step.run('load-items', ...)`, then split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)`. A
 * crash mid-sweep resumes at the first unfinished batch. Each product's
 * images are re-read fresh at batch-processing time (not the load-items
 * snapshot) so a retried batch never re-spends a Vision call on an image
 * already alt-filled by a prior attempt.
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const IMAGES_PER_PRODUCT_CAP = 4;

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
const bulkAiImageAltFn = inngest.createFunction(
  {
    id: 'bulk-ai-image-alt',
    name: 'Bulk: generate image alt-text across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/image-alt-requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/image-alt-requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date() },
        })
      );

      const apiKey = config.googleAiKey;
      if (!apiKey) {
        throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
      }

      const productIds = await step.run('load-items', async () => {
        const products = await prisma.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: { id: true },
        });
        await prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: products.length },
        });
        return products.map(p => p.id);
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
          const currentJob = await prisma.bulkAiJob.findUnique({
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

          // Fresh per-batch read of each product's images — the idempotency
          // re-check. Images already alt-filled by a prior partial attempt
          // (this batch retried, or the per-product endpoint) drop out of
          // `missingAlt` naturally.
          const items = await prisma.product.findMany({
            where: { id: { in: batchIds }, storeId },
            select: {
              id: true,
              name: true,
              nameAr: true,
              images: {
                orderBy: { position: 'asc' },
                take: IMAGES_PER_PRODUCT_CAP,
                select: { id: true, url: true, alt: true },
              },
            },
          });
          const byId = new Map(items.map(p => [p.id, p]));

          let bProcessed = 0;
          let bFilled = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: BulkError[] = [];

          outer: for (const id of batchIds) {
            const product = byId.get(id);
            if (!product) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            const missingAlt = product.images.filter(img => !img.alt?.trim());
            if (missingAlt.length === 0) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            let productFilled = 0;
            let productFailed = 0;

            for (const image of missingAlt) {
              try {
                await assertAiQuota({ storeId, bulk: true });

                const alt = await callWithRetry(
                  () =>
                    generateProductAltText(
                      {
                        storeId,
                        imageUrl: image.url,
                        product: { name: product.name, nameAr: product.nameAr },
                      },
                      apiKey,
                      MODEL
                    ),
                  `image-alt:${image.id}`
                );

                await (
                  await storeWriter(storeId)
                ).productImage.update({
                  where: { id: image.id },
                  data: { alt },
                });
                productFilled++;
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  logger.warn(
                    { storeId, jobId },
                    'bulk-ai-image-alt: quota cap hit, aborting sweep'
                  );
                  bQuotaReached = true;
                  // Tally whatever this product accomplished before the abort,
                  // matching the pre-batch semantics of not counting the
                  // in-flight image, then stop the whole batch.
                  if (productFilled > 0) bFilled++;
                  else if (productFailed > 0) bFailed++;
                  break outer;
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
                productFailed++;
              }

              await sleep(THROTTLE_MS);
            }

            if (productFilled > 0) bFilled++;
            else if (productFailed > 0) bFailed++;
            else bSkipped++;

            bProcessed++;
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
          prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { processed, filled, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, filled, skipped, failed },
            'bulk-ai-image-alt: cancelled by merchant'
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
        const finalRow = await prisma.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await prisma.bulkAiJob.update({
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
        'bulk-ai-image-alt complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiImageAlt: JobDef = bulkAiImageAltFn;
