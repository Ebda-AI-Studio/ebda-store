import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { runInStoreScope } from '@ebda/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { generateProductFaqs } from '../../ai/product-faq-generator';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';
import { isPlaceholderText } from '../../ai/placeholder-guard';

/**
 * Catalogue-wide product-FAQ sweep.
 *
 * Generates bilingual (EN + AR) FAQ pairs for every active product using
 * the SAME core as the per-product "Draft with AI" button
 * (`generateProductFaqs` in lib/ai/product-faq-generator.ts). DRY: one
 * prompt + parse path for both the single-product route and this sweep.
 *
 * Re-sweep semantics (mirrors bulk-ai-recommendations):
 *   - Default: smart-skip products that already have ANY FAQ row. Only
 *     products with zero FAQs get a Gemini call.
 *   - `force: true`: process every product. Deletes that product's prior
 *     AI-DRAFTED FAQs (manuallyEdited rows are preserved) then inserts the
 *     freshly-generated ones.
 *   - Cooperative cancellation: polls bulk_ai_jobs.status once per batch.
 *
 * PR2 — crash-resumable batching. The product id list is loaded ONCE inside
 * `step.run('load-items', ...)` (stable set + order across retries), then
 * split into `BULK_AI_BATCH_SIZE`-sized batches, each processed inside its
 * own `step.run(\`batch-${i}\`, ...)`. Inngest memoizes completed steps, so
 * a crash mid-sweep (deploy window / worker restart) resumes at the first
 * unfinished batch instead of restarting from item 0. Each item re-checks
 * its own "needs work" predicate fresh (from the batch's own DB read, not
 * the load-items snapshot) so a batch step that gets retried after a
 * partial failure never re-spends a Gemini call on a product it already
 * finished.
 *
 * Follows the canonical bulk-AI patterns:
 *   - concurrency key on storeId (one sweep per store at a time)
 *   - retries: 2
 *   - throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - assertAiQuota before each Gemini call (respects AI_DAILY_REQUEST_CAP)
 *   - error cap at 50 so no single run bloats the BulkAiJob row
 *   - quota errors abort the sweep cleanly (not silenced)
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
// FAQ pairs to draft per product.
const FAQS_PER_PRODUCT = 3;

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
const bulkAiProductFaqsFn = inngest.createFunction(
  {
    id: 'bulk-ai-product-faqs',
    name: 'Bulk: draft product FAQs across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/product-faqs-requested' }],
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
      logger.warn('bulk-ai/product-faqs-requested fired without ids');
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

      // Stable snapshot of the candidate set + order — batch boundaries never
      // shift across retries even if products are added/removed mid-sweep.
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

          // Fresh per-batch read — this IS the per-item idempotency re-check:
          // a batch step retried after a partial failure sees the real
          // current `_count.faqs`, so products it already wrote on the prior
          // attempt are skipped instead of re-spending a Gemini call.
          const items = await sdb.product.findMany({
            where: { id: { in: batchIds }, storeId },
            select: {
              id: true,
              name: true,
              nameAr: true,
              description: true,
              options: {
                select: {
                  name: true,
                  nameAr: true,
                  values: { select: { value: true, valueAr: true } },
                },
              },
              _count: { select: { faqs: true } },
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
            // Deleted between load-items and this batch running — nothing to do.
            if (!product) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            // Smart-skip: products that already have FAQs are left alone
            // unless force is set. Counts as skipped (not failed) so
            // re-runs report cleanly.
            if (!force && product._count.faqs > 0) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              await assertAiQuota({ storeId, bulk: true, reserve: false });

              // Shared core — identical to the per-product "Draft with AI" path.
              const faqs = await callWithRetry(
                () =>
                  generateProductFaqs(
                    {
                      storeId,
                      storeName,
                      product: {
                        name: product.name,
                        nameAr: product.nameAr,
                        description: product.description,
                        options: product.options,
                      },
                      count: FAQS_PER_PRODUCT,
                    },
                    apiKey,
                    MODEL
                  ),
                `product-faqs:${product.id}`
              );

              // Keep only well-formed, non-placeholder rows (question + answer
              // present and neither is degenerate Gemini output like "N/A" —
              // this sweep writes straight to the live product page with no
              // merchant review step, see placeholder-guard.ts).
              const validFaqs = faqs.filter(
                f =>
                  f &&
                  typeof f.question === 'string' &&
                  f.question.trim() &&
                  typeof f.answer === 'string' &&
                  f.answer.trim() &&
                  !isPlaceholderText(f.question) &&
                  !isPlaceholderText(f.answer)
              );

              if (validFaqs.length === 0) {
                bSkipped++;
              } else {
                const w = await storeWriter(storeId);
                await w.$transaction([
                  // On force, replace only AI-drafted rows — never clobber
                  // merchant-edited FAQs.
                  ...(force
                    ? [
                        w.productFaq.deleteMany({
                          where: { productId: product.id, aiDrafted: true, manuallyEdited: false },
                        }),
                      ]
                    : []),
                  w.productFaq.createMany({
                    data: validFaqs.map(f => ({
                      productId: product.id,
                      question: f.question.slice(0, 500),
                      questionAr: f.questionAr?.slice(0, 500) ?? null,
                      answer: f.answer.slice(0, 2000),
                      answerAr: f.answerAr?.slice(0, 2000) ?? null,
                      aiDrafted: true,
                    })),
                  }),
                ]);
                bFilled++;
              }
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                logger.warn(
                  { storeId, jobId },
                  'bulk-ai-product-faqs: quota cap hit, aborting sweep'
                );
                bQuotaReached = true;
                break; // do not count this item — matches pre-batch abort semantics
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

            // Throttle to stay under the free-tier RPM — only after a real call.
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
            'bulk-ai-product-faqs: cancelled by merchant'
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
        'bulk-ai-product-faqs complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiProductFaqs: JobDef = bulkAiProductFaqsFn;
