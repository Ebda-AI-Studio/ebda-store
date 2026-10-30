import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../../lib/repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { prisma, runInStoreScope } from '@ebda/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { suggestProductTags, MAX_TAGS_PER_PRODUCT } from '../../ai/product-tag-suggester';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

/**
 * Catalogue-wide product-tag sweep.
 *
 * For every product, suggests up to MAX_TAGS_PER_PRODUCT (5) tags from
 * name + description. Reuses the store's existing `Tag` rows by
 * case-insensitive name match before creating a new one — never creates a
 * near-duplicate tag. Tags are purely additive: this sweep NEVER deletes a
 * `ProductTag` link or a `Tag` row.
 *
 * Re-sweep semantics:
 *   - Default: skip a product that already has >=1 tag (smart-skip).
 *   - `force: true`: also process already-tagged products, but only ever
 *     TOPS UP — adds newly-suggested tags the product doesn't have yet,
 *     up to the per-product cap. Existing tags are never removed (there is
 *     nothing to "clobber" since tags are additive-only by design).
 *
 * PR2 — crash-resumable batching. The product id list is loaded ONCE inside
 * `step.run('load-items', ...)`, then split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)`. The
 * store's tag cache (name → id) is rebuilt fresh at the START of every batch
 * (not carried in a closure across batches — each batch step is its own
 * isolated callback) so tags created by an earlier batch are visible to a
 * later one. Each item re-checks its own tag count fresh so a retried batch
 * never re-spends a Gemini call on a product it already tagged.
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
const bulkAiTagsFn = inngest.createFunction(
  {
    id: 'bulk-ai-tags',
    name: 'Bulk: suggest product tags across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/tags-requested' }],
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
      logger.warn('bulk-ai/tags-requested fired without ids');
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
        const store = await prisma.store.findUnique({
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

          // Store-wide tag cache rebuilt fresh for THIS batch — sees every
          // Tag row created by earlier batches (already persisted to DB).
          const existingTags = await sdb.tag.findMany({
            where: { storeId },
            select: { id: true, name: true },
          });
          const tagByLowerName = new Map(existingTags.map(t => [t.name.toLowerCase(), t.id]));
          const existingTagNames = existingTags.map(t => t.name);

          // Fresh per-item read — the idempotency re-check.
          const items = await sdb.product.findMany({
            where: { id: { in: batchIds }, storeId },
            select: {
              id: true,
              name: true,
              description: true,
              tags: { select: { tagId: true } },
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

            const currentTagIds = new Set(product.tags.map(t => t.tagId));
            const remainingSlots = MAX_TAGS_PER_PRODUCT - currentTagIds.size;

            if ((!force && currentTagIds.size > 0) || remainingSlots <= 0) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              await assertAiQuota({ storeId, bulk: true });

              const suggested = await callWithRetry(
                () =>
                  suggestProductTags(
                    {
                      storeId,
                      storeName,
                      product: { name: product.name, description: product.description },
                      existingTagNames,
                    },
                    apiKey,
                    MODEL
                  ),
                `tags:${product.id}`
              );

              // Resolve each suggested name to a tag id, creating new Tag rows
              // only when no case-insensitive match already exists.
              const toLink: string[] = [];
              for (const name of suggested) {
                if (toLink.length >= remainingSlots) break;
                const key = name.toLowerCase();
                let tagId = tagByLowerName.get(key);
                if (!tagId) {
                  const created = await (
                    await storeWriter(storeId)
                  ).tag.create({ data: { storeId, name } });
                  tagId = created.id;
                  tagByLowerName.set(key, tagId);
                  existingTagNames.push(name);
                }
                if (!currentTagIds.has(tagId) && !toLink.includes(tagId)) {
                  toLink.push(tagId);
                }
              }

              if (toLink.length === 0) {
                bSkipped++;
              } else {
                await (
                  await storeWriter(storeId)
                ).productTag.createMany({
                  data: toLink.map(tagId => ({ productId: product.id, tagId })),
                  skipDuplicates: true,
                });
                bFilled++;
              }
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                logger.warn({ storeId, jobId }, 'bulk-ai-tags: quota cap hit, aborting sweep');
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
            'bulk-ai-tags: cancelled by merchant'
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
        'bulk-ai-tags complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiTags: JobDef = bulkAiTagsFn;
